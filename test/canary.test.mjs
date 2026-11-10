import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOW_AGENT_HOME = mkdtempSync(join(tmpdir(), "fa-canary-"));
const c = await import("../dist/canary.js");

test("the canary is due when it never ran and again after a day", () => {
  assert.equal(c.canaryDue(Date.now(), null), true);
  const last = { at: Date.now(), failures: [], fixed: [] };
  assert.equal(c.canaryDue(Date.now() + 3_600_000, last), false);
  assert.equal(c.canaryDue(Date.now() + 25 * 3_600_000, last), true);
});

test("a doctor report becomes failures and fixes, and the status line says which", () => {
  const s = c.summarize(["ok    start", "FAIL  mode_video: Flow UI changed", "FIXED ratio: added fallback"], 1000);
  assert.deepEqual(s.failures, ["mode_video: Flow UI changed"]);
  assert.equal(s.fixed.length, 1);
  assert.match(c.canaryLine(1000 + 2 * 3_600_000, s), /1 control\(s\) BROKEN \(2 h ago\).*doctor --fix/);
  assert.match(c.canaryLine(1000, c.summarize(["ok start"], 1000)), /all controls ok/);
  assert.match(c.canaryLine(0, null), /not run yet/);
});
