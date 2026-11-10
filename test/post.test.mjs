import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atempoChain, captions, exportPreset, mixAudio, presetFilter, speed, trim } from "../dist/post.js";

const dir = mkdtempSync(join(tmpdir(), "fa-post-"));
const clip = join(dir, "clip.mp4");
execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24:duration=3", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip]);
const info = (f) => execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height,duration", "-of", "csv=p=0", f]).toString();

test("the preset filter fills or pads the frame, and the tempo chain stays inside ffmpeg's 0.5 to 2 steps", () => {
  assert.match(presetFilter("reels", "crop", 0.25), /crop=1080:1920:\(in_w-out_w\)\*0.25/);
  assert.match(presetFilter("youtube", "pad"), /pad=1920:1080/);
  assert.equal(atempoChain(1.5), "atempo=1.5000");
  assert.equal(atempoChain(4), "atempo=2.0000,atempo=2.0000");
  assert.equal(atempoChain(0.25), "atempo=0.5000,atempo=0.5000");
});

test("export makes a 9:16 file in an exports folder and leaves the source alone", async () => {
  const r = await exportPreset(clip, "reels");
  const out = r.split(" (")[0];
  assert.ok(out.includes("exports") && existsSync(out) && existsSync(clip));
  assert.match(info(out), /1080,1920/);
  const again = (await exportPreset(clip, "reels")).split(" (")[0];
  assert.notEqual(again, out); // never overwrites
});

test("trim keeps just the chosen part, speed changes the length", async () => {
  const t = (await trim(clip, 0.5, 2)).split(" (")[0];
  assert.ok(Math.abs(Number(info(t).split("\n")[0].split(",")[2]) - 1.5) < 0.2);
  const s = (await speed(clip, 2)).split(" (")[0];
  assert.ok(Math.abs(Number(info(s).split("\n")[0].split(",")[2]) - 1.5) < 0.2);
  await assert.rejects(() => trim(clip, 5), /past the end/);
  await assert.rejects(() => speed(clip, 9), /between 0.25/);
});

test("mixing music keeps the clip's length and captions burn in", async () => {
  const music = join(dir, "music.wav");
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=220:duration=1", music]);
  const m = (await mixAudio(clip, music)).split(" (")[0];
  assert.ok(Math.abs(Number(info(m).split("\n")[0].split(",")[2]) - 3) < 0.3);
  const srt = join(dir, "subs.srt");
  writeFileSync(srt, "1\n00:00:00,000 --> 00:00:02,000\nHello there\n");
  const c = (await captions(clip, srt)).split(" (")[0];
  assert.ok(existsSync(c));
  await assert.rejects(() => captions(clip, clip), /\.srt/);
});
