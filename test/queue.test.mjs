import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "fa-queue-"));
process.env.FLOW_AGENT_HOME = home;
mkdirSync(home, { recursive: true });
writeFileSync(join(home, "queue.json"), JSON.stringify([
  { id: "aaaa0001", project: "P", scene: { prompt: "x" }, status: "done", files: ["a.jpeg"] },
  { id: "aaaa0002", project: "P", scene: { prompt: "y", type: "video" }, status: "running", files: [] },
  { id: "aaaa0003", project: "P", scene: { prompt: "z", type: "video" }, status: "queued", files: [] },
]));
const { Queue } = await import("../dist/queue.js");

test("history survives a restart, unfinished jobs are failed and never resubmitted", () => {
  const q = new Queue();
  const jobs = q.get();
  assert.equal(jobs.length, 3);
  assert.equal(jobs.find((j) => j.id === "aaaa0001").status, "done");
  for (const id of ["aaaa0002", "aaaa0003"]) {
    const j = jobs.find((x) => x.id === id);
    assert.equal(j.status, "failed");
    assert.match(j.error, /not resubmitted/);
  }
});

test("a cancelled queued job is saved to disk", () => {
  const q = new Queue();
  q.get().find((j) => j.id === "aaaa0003").status = "queued"; // pretend it is still waiting
  assert.equal(q.cancel("aaaa0003"), "cancelled");
  const saved = JSON.parse(readFileSync(join(home, "queue.json"), "utf8"));
  assert.equal(saved.find((j) => j.id === "aaaa0003").status, "cancelled");
});
