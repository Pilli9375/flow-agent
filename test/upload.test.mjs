import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planUpload, MAX_FILES } from "../dist/uploadplan.js";
import { optionNameRe } from "../dist/flow.js";

const dir = mkdtempSync(join(tmpdir(), "flow-agent-upload-"));
const img = (rel, bytes = 10) => {
  const p = join(dir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, Buffer.alloc(bytes, 1));
  return p;
};
test.after(() => rmSync(dir, { recursive: true, force: true }));

test("a list of images passes, in order, without duplicates", () => {
  const a = img("a.png"), b = img("b.jpg"), c = img("c.webp");
  const plan = planUpload({ files: [a, b, c, a] });
  assert.deepEqual(plan.files, [a, b, c]);
});

test("every problem is reported before anything would be uploaded", () => {
  const ok = img("ok.png");
  const txt = img("notes.txt");
  assert.throws(() => planUpload({ files: [ok, "relative.png", join(dir, "missing.png"), txt] }), (e) => /Not an absolute path/.test(e.message) && /Image not found/.test(e.message) && /Not a png\/jpg\/webp/.test(e.message));
});

test("empty and oversized files are refused", () => {
  const empty = img("empty.png", 0);
  assert.throws(() => planUpload({ files: [empty] }), /Empty file/);
});

test("nothing given is an error", () => {
  assert.throws(() => planUpload({}), /files .* or a folder/);
});

test("a folder uploads only its images; other files are counted as ignored", () => {
  const sub = join(dir, "pics");
  mkdirSync(sub);
  for (const n of ["z.png", "a.jpeg", "m.webp", "readme.md"]) writeFileSync(join(sub, n), "x");
  const plan = planUpload({ folder: sub });
  assert.deepEqual(plan.files.map((f) => f.split(/[\\/]/).pop()), ["a.jpeg", "m.webp", "z.png"]);
  assert.equal(plan.ignored, 1);
});

test("sub-folders are only searched when asked, and only one level deep", () => {
  const root = join(dir, "gen");
  mkdirSync(join(root, "session1", "deeper"), { recursive: true });
  writeFileSync(join(root, "session1", "exec-1.png"), "x");
  writeFileSync(join(root, "session1", "deeper", "exec-2.png"), "x");
  assert.throws(() => planUpload({ folder: root }), /recursive/);
  const plan = planUpload({ folder: root, recursive: true });
  assert.deepEqual(plan.files.map((f) => f.split(/[\\/]/).pop()), ["exec-1.png"]);
});

test("two different files with the same name are refused (Flow names assets by file name)", () => {
  const x = img("one/same.png"), y = img("two/same.png");
  assert.throws(() => planUpload({ files: [x, y] }), /both named same\.png/);
});

test("too many images in one call are refused", () => {
  const files = Array.from({ length: MAX_FILES + 1 }, (_, i) => img(`many/${i}.png`));
  assert.throws(() => planUpload({ files }), new RegExp(`At most ${MAX_FILES}`));
});

test("a missing folder is reported", () => {
  assert.throws(() => planUpload({ folder: join(dir, "nope") }), /Folder not found/);
});

test("picker option names match with or without the media-type suffix", () => {
  const re = optionNameRe("exec-1.png");
  assert.ok(re.test("exec-1.png"));
  assert.ok(re.test("exec-1.png Image"));
  assert.ok(!re.test("Uploading exec-1.png"));
  assert.ok(!re.test("exec-1xpng"));
});
