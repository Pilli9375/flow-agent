import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated state: the guard reads FLOW_AGENT_HOME when it is first imported.
process.env.FLOW_AGENT_HOME = mkdtempSync(join(tmpdir(), "fa-guard-"));
process.env.FLOW_AGENT_MAX_PER_HOUR = "3";
process.env.FLOW_AGENT_COOLDOWN_MIN = "30";
const g = await import("../dist/guard.js");

test("allows submissions at first", () => {
  assert.equal(g.submissionBlocked(), null);
});

test("hourly cap blocks the next submission and names a time", () => {
  const now = Date.now();
  for (let i = 0; i < 3; i++) g.recordSubmission(now);
  assert.match(g.submissionBlocked(now) ?? "", /Hourly limit of 3/);
  assert.equal(g.submissionBlocked(now + 3_700_000), null); // an hour later the slots are free
});

test("a rejection starts a cooldown that doubles on repeats and never exceeds 4 hours", () => {
  const t0 = Date.now() + 10 * 3_600_000; // after the earlier hourly window
  const a = g.recordRejection(t0);
  assert.equal(a - t0, 30 * 60_000);
  assert.match(g.submissionBlocked(t0 + 60_000) ?? "", /Cooling down/);
  const b = g.recordRejection(t0 + 1000);
  assert.equal(b - (t0 + 1000), 60 * 60_000);
  let last = b;
  for (let i = 0; i < 6; i++) last = g.recordRejection(t0 + 2000 + i);
  assert.ok(last - (t0 + 2005) <= 240 * 60_000);
  assert.equal(g.submissionBlocked(last + 1000), null); // the cooldown does end
});

test("a success eases the strike count", () => {
  const t0 = Date.now() + 40 * 3_600_000;
  g.recordRejection(t0); // strikes reset after 24 h, so this is strike 1
  g.recordSuccess();
  const next = g.recordRejection(t0 + 5000);
  assert.equal(next - (t0 + 5000), 30 * 60_000);
});
