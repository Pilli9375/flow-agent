import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const haveFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const skip = haveFfmpeg ? false : "ffmpeg is not installed";
const { stitch, previewSheet } = await import("../dist/media.js");

const dir = mkdtempSync(join(tmpdir(), "fa-media-"));
const clip = (name, color) =>
  spawnSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", `color=c=${color}:s=320x180:r=24:d=2`, "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", join(dir, name)]);
const duration = (f) => Number(spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f], { encoding: "utf8" }).stdout.trim());

test("a plain join keeps the full length of both clips", { skip }, async () => {
  assert.equal(clip("scene-01.mp4", "red").status, 0);
  assert.equal(clip("scene-02.mp4", "blue").status, 0);
  const out = await stitch(dir, { transition: "cut" });
  assert.ok(existsSync(out));
  assert.ok(Math.abs(duration(out) - 4) < 0.15);
});

test("a crossfade overlaps the clips by the fade length", { skip }, async () => {
  const out = await stitch(dir, { transition: "fade", fadeSeconds: 0.5 });
  assert.ok(Math.abs(duration(out) - 3.5) < 0.15);
});

test("stitching needs at least two clips", { skip }, async () => {
  const empty = mkdtempSync(join(tmpdir(), "fa-media-empty-"));
  await assert.rejects(() => stitch(empty), /at least 2 clips/);
});

test("preview sheets are small pictures for videos and images", { skip }, async () => {
  const v = await previewSheet(join(dir, "scene-01.mp4"), 6);
  assert.ok(existsSync(v) && statSync(v).size > 1000 && statSync(v).size < 500_000);
  const png = join(dir, "pic.png");
  spawnSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=green:s=2000x1000", "-frames:v", "1", png]);
  const i = await previewSheet(png);
  assert.ok(existsSync(i));
});
