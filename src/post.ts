import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { FFMPEG, probe, tool } from "./media.js";

// Local post-production with ffmpeg (free, CPU only, nothing goes to Flow). Every result is a NEW file in an
// "exports" folder next to the source; the source is never changed.

export const PRESETS = {
  reels: { w: 1080, h: 1920, note: "Instagram Reels, 9:16" },
  tiktok: { w: 1080, h: 1920, note: "TikTok, 9:16" },
  shorts: { w: 1080, h: 1920, note: "YouTube Shorts, 9:16" },
  youtube: { w: 1920, h: 1080, note: "YouTube, 16:9 full HD" },
  square: { w: 1080, h: 1080, note: "square 1:1 (feed posts)" },
  small: { w: 1280, h: 720, note: "small 720p file for sharing" },
} as const;
export type Preset = keyof typeof PRESETS;

const ENC = ["-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart"];

// <dir>/exports/<name>-<tag>.mp4, never overwriting an earlier result.
export function outPath(file: string, tag: string): string {
  const dir = join(dirname(file), "exports");
  mkdirSync(dir, { recursive: true });
  const base = basename(file, extname(file));
  let out = join(dir, `${base}-${tag}.mp4`);
  for (let i = 2; existsSync(out); i++) out = join(dir, `${base}-${tag}-${i}.mp4`);
  return out;
}

const mb = (f: string) => `${(statSync(f).size / 1048576).toFixed(1)} MB`;
const need = (file: string) => {
  if (!existsSync(file)) throw new Error(`File not found: ${file}`);
};

// Video filter for a preset. "crop" fills the frame (cuts the sides or top, focus 0 = left/top, 0.5 = centre, 1 = right/bottom);
// "pad" keeps the whole picture and adds black bars.
export function presetFilter(preset: Preset, fit: "crop" | "pad" = "crop", focus = 0.5): string {
  const { w, h } = PRESETS[preset];
  const f = Math.min(1, Math.max(0, focus));
  return fit === "pad"
    ? `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`
    : `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}:(in_w-out_w)*${f}:(in_h-out_h)*${f},setsar=1`;
}

export async function exportPreset(file: string, preset: Preset, opts: { fit?: "crop" | "pad"; focus?: number } = {}): Promise<string> {
  need(file);
  if (!(preset in PRESETS)) throw new Error(`Unknown preset "${preset}". Use: ${Object.keys(PRESETS).join(", ")}.`);
  const out = outPath(file, preset);
  await tool(FFMPEG, ["-y", "-v", "error", "-i", file, "-vf", presetFilter(preset, opts.fit, opts.focus), "-map", "0:v:0", "-map", "0:a?", ...ENC, out]);
  return `${out} (${PRESETS[preset].note}, ${PRESETS[preset].w}x${PRESETS[preset].h}, ${mb(out)})`;
}

const secs = (v: number | undefined, name: string) => {
  if (v !== undefined && !(Number.isFinite(v) && v >= 0)) throw new Error(`${name} must be a number of seconds, 0 or more.`);
  return v;
};

export async function trim(file: string, start = 0, end?: number): Promise<string> {
  need(file);
  secs(start, "start"); secs(end, "end");
  const { duration } = await probe(file);
  if (end !== undefined && end <= start) throw new Error("end must be later than start.");
  if (start >= duration) throw new Error(`start is past the end of the clip (${duration.toFixed(1)} s).`);
  const out = outPath(file, "trim");
  await tool(FFMPEG, ["-y", "-v", "error", "-i", file, "-ss", String(start), ...(end !== undefined ? ["-to", String(end)] : []), ...ENC, out]);
  return `${out} (${Math.max(0, Math.min(end ?? duration, duration) - start).toFixed(1)} s, ${mb(out)})`;
}

// atempo only takes 0.5 to 2 per step, so larger changes are chained.
export function atempoChain(factor: number): string {
  const steps: number[] = [];
  let f = factor;
  while (f > 2) { steps.push(2); f /= 2; }
  while (f < 0.5) { steps.push(0.5); f /= 0.5; }
  steps.push(f);
  return steps.map((s) => `atempo=${s.toFixed(4)}`).join(",");
}

export async function speed(file: string, factor: number): Promise<string> {
  need(file);
  if (!(factor >= 0.25 && factor <= 4)) throw new Error("factor must be between 0.25 (slow motion) and 4 (fast).");
  const { audio } = await probe(file);
  const out = outPath(file, `speed${factor}`);
  const args = audio
    ? ["-filter_complex", `[0:v]setpts=PTS/${factor}[v];[0:a]${atempoChain(factor)}[a]`, "-map", "[v]", "-map", "[a]"]
    : ["-vf", `setpts=PTS/${factor}`, "-map", "0:v:0"];
  await tool(FFMPEG, ["-y", "-v", "error", "-i", file, ...args, ...ENC, out]);
  return `${out} (${factor}x, ${mb(out)})`;
}

// Adds or replaces the sound. replace=false mixes the music under the clip's own sound; replace=true uses only the music.
export async function mixAudio(file: string, audio: string, opts: { volume?: number; clipVolume?: number; replace?: boolean; fadeOut?: number } = {}): Promise<string> {
  need(file); need(audio);
  const { duration, audio: hasAudio } = await probe(file);
  const mv = opts.volume ?? 0.4, cv = opts.clipVolume ?? 1, fo = Math.min(opts.fadeOut ?? 1.5, duration);
  const music = `[1:a]volume=${mv},afade=t=out:st=${Math.max(0, duration - fo).toFixed(2)}:d=${fo.toFixed(2)}`;
  const graph = hasAudio && !opts.replace
    ? `[0:a]volume=${cv}[a0];${music}[a1];[a0][a1]amix=inputs=2:duration=first:normalize=0[a]`
    : `${music}[a]`;
  const out = outPath(file, "mix");
  await tool(FFMPEG, ["-y", "-v", "error", "-i", file, "-stream_loop", "-1", "-i", audio, "-filter_complex", graph, "-map", "0:v:0", "-map", "[a]", "-t", duration.toFixed(3), "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out]);
  return `${out} (${hasAudio && !opts.replace ? "music mixed under the clip's sound" : "sound replaced by the music"}, ${mb(out)})`;
}

// Burns subtitles from an .srt file into the picture. ffmpeg runs inside the srt's folder so Windows paths need no escaping.
export async function captions(file: string, srt: string, opts: { fontSize?: number } = {}): Promise<string> {
  need(file); need(srt);
  if (!/\.srt$/i.test(srt)) throw new Error("The captions file must be an .srt file.");
  const out = outPath(file, "captions");
  const size = Math.min(72, Math.max(10, opts.fontSize ?? 28));
  await tool(FFMPEG, ["-y", "-v", "error", "-i", file, "-vf", `subtitles='${basename(srt).replace(/'/g, "")}':force_style='FontSize=${size},Outline=2,Shadow=0,MarginV=40'`, "-map", "0:v:0", "-map", "0:a?", ...ENC, out], dirname(srt));
  return `${out} (captions burned in, ${mb(out)})`;
}
