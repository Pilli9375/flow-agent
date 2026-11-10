import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeFor, listProjects, moveToTrash, pick } from "../dist/cleanup.js";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "fa-clean-"));
  for (const [name, ageDays] of [["Old", 30], ["New", 1], ["Mid", 10]]) {
    mkdirSync(join(root, name, "originals"), { recursive: true });
    writeFileSync(join(root, name, "scene-01.mp4"), Buffer.alloc(2048));
    const t = (Date.now() - ageDays * 86_400_000) / 1000;
    for (const p of [join(root, name, "scene-01.mp4"), join(root, name, "originals"), join(root, name)]) utimesSync(p, t, t);
  }
  return root;
}

test("lists folders oldest first with sizes, ignoring the trash folder", () => {
  const root = setup();
  mkdirSync(join(root, ".trash"));
  const all = listProjects(root);
  assert.deepEqual(all.map((e) => e.name), ["Old", "Mid", "New"]);
  assert.equal(all[0].bytes, 2048);
});

test("picks by name or by age, and reports unknown names", () => {
  const all = listProjects(setup());
  assert.deepEqual(pick(all, { olderDays: 5 }).chosen.map((e) => e.name), ["Old", "Mid"]);
  assert.deepEqual(pick(all, { names: ["New", "Nope"] }).unknown, ["Nope"]);
  assert.deepEqual(pick(all, { names: ["New"], olderDays: 20 }).chosen.map((e) => e.name).sort(), ["New", "Old"]);
});

test("the confirm code depends on the selection, and the move keeps the folders (nothing erased)", () => {
  const root = setup();
  const all = listProjects(root);
  const a = pick(all, { names: ["Old"] }).chosen, b = pick(all, { names: ["Old", "Mid"] }).chosen;
  assert.notEqual(codeFor(a), codeFor(b));
  const dest = moveToTrash(root, a);
  assert.ok(existsSync(join(dest, "Old", "scene-01.mp4")));
  assert.ok(!existsSync(join(root, "Old")));
  assert.ok(existsSync(join(root, "Mid")));
});
