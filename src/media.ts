import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { promisify } from "node:util";

export const OUT_ROOT = process.env.FLOW_AGENT_OUT ?? join(homedir(), "flow-agent-out");

const run = promisify(execFile);
export const FFMPEG = process.env.FFMPEG ?? "ffmpeg";
export const FFPROBE = process.env.FFPROBE ?? "ffprobe";

export async function tool(bin: string, args: string[], cwd?: string): Promise<string> {
  try {
    return (await run(bin, args, { maxBuffer: 16 * 1024 * 1024, windowsHide: true, cwd })).stdout;
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === "ENOENT") throw new Error(`${bin} not found. Install ffmpeg and put it on PATH (or set ${bin === FFMPEG ? "FFMPEG" : "FFPROBE"}).`);
    throw new Error(`${bin} failed: ${(err.stderr ?? err.message).trim().split("\n").slice(-2).join(" ")}`);
  }
}

// Last frame of a clip as a png, used as the next scene's start frame so motion continues across cuts.
export async function lastFrame(video: string, out: string): Promise<string> {
  await tool(FFMPEG, ["-y", "-v", "error", "-sseof", "-0.15", "-i", video, "-frames:v", "1", out]);
  if (!existsSync(out)) throw new Error(`Could not read the last frame of ${video}`);
  return out;
}

export const probe = async (file: string) => {
  const [v, a, d] = await Promise.all([
    tool(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file]),
    tool(FFPROBE, ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_type", "-of", "csv=p=0", file]),
    tool(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]),
  ]);
  const [w, h] = v.trim().split(",").map(Number);
  return { w, h, audio: a.trim() === "audio", duration: Number(d.trim()) };
};

export type StitchOptions = { files?: string[]; transition?: "cut" | "fade"; fadeSeconds?: number };

// Joins a project's clips (scene-*.mp4, or the named files) into <project>/final.mp4, scaled to the first clip's size.
// transition "fade" crossfades picture and sound between clips (default 0.4 s); "cut" is a plain join.
export async function stitch(projectDir: string, opts: StitchOptions | string[] = {}): Promise<string> {
  const o: StitchOptions = Array.isArray(opts) ? { files: opts } : opts;
  const names = o.files?.length
    ? o.files
    : readdirSync(projectDir)
        .filter((f) => /^scene-.*\.mp4$/.test(f))
        .sort();
  const clips = names.map((n) => join(projectDir, n)).filter((f) => existsSync(f) && statSync(f).isFile());
  if (clips.length < 2) throw new Error(`Need at least 2 clips to stitch, found ${clips.length} in ${projectDir}.`);
  const info = await Promise.all(clips.map(probe));
  const { w, h } = info[0];
  const audio = info.every((i) => i.audio);
  const norm = clips.map((_, i) => `[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24[v${i}]`);
  let graph: string;
  let outMaps: string[];
  const fade = o.transition === "fade";
  const d = Math.min(Math.max(o.fadeSeconds ?? 0.4, 0.1), 2);
  if (fade && info.every((i) => i.duration > d * 2)) {
    // Chain of xfade (picture) and acrossfade (sound); each offset is where the previous result ends minus the overlap.
    const parts = [...norm];
    let acc = info[0].duration;
    let vPrev = "v0";
    let aPrev = "0:a";
    for (let i = 1; i < clips.length; i++) {
      const vOut = i === clips.length - 1 ? "v" : `x${i}`;
      parts.push(`[${vPrev}][v${i}]xfade=transition=fade:duration=${d}:offset=${(acc - d).toFixed(3)}[${vOut}]`);
      vPrev = vOut;
      if (audio) {
        const aOut = i === clips.length - 1 ? "a" : `ax${i}`;
        parts.push(`[${aPrev}][${i}:a]acrossfade=d=${d}[${aOut}]`);
        aPrev = aOut;
      }
      acc += info[i].duration - d;
    }
    graph = parts.join(";");
    outMaps = ["-map", "[v]", ...(audio ? ["-map", "[a]", "-c:a", "aac"] : [])];
  } else {
    const inputs = clips.map((_, i) => `[v${i}]${audio ? `[${i}:a]` : ""}`).join("");
    graph = `${norm.join(";")};${inputs}concat=n=${clips.length}:v=1:a=${audio ? 1 : 0}[v]${audio ? "[a]" : ""}`;
    outMaps = ["-map", "[v]", ...(audio ? ["-map", "[a]", "-c:a", "aac"] : [])];
  }
  const out = join(projectDir, "final.mp4");
  await tool(FFMPEG, ["-y", "-v", "error", ...clips.flatMap((c) => ["-i", c]), "-filter_complex", graph, ...outMaps, "-c:v", "libx264", "-crf", "17", "-preset", "medium", "-pix_fmt", "yuv420p", out]);
  return out;
}

// A small picture for checking a result cheaply (a few hundred KB instead of a whole video): videos become a grid of
// evenly spaced frames, images are scaled down. Saved in a previews/ folder next to the file.
export async function previewSheet(file: string, frames = 6): Promise<string> {
  if (!existsSync(file)) throw new Error(`File not found: ${file}`);
  const dir = join(dirname(file), "previews");
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `${basename(file, extname(file))}.jpg`);
  const isVideo = /\.(mp4|mov|webm|mkv)$/i.test(file);
  if (!isVideo) {
    await tool(FFMPEG, ["-y", "-v", "error", "-i", file, "-vf", "scale='min(1280,iw)':-2", "-q:v", "4", out]);
    return out;
  }
  const { w, h, duration } = await probe(file);
  const n = Math.min(Math.max(Math.round(frames), 1), 12);
  const cols = n <= 3 ? n : n <= 8 ? Math.ceil(n / 2) : 4;
  const rows = Math.ceil(n / cols);
  const tw = Math.round(Math.min(480, 1440 / cols));
  const th = Math.round((tw * h) / w / 2) * 2;
  const fps = Math.max(duration, 0.5) > 0 ? n / Math.max(duration, 0.5) : 1;
  await tool(FFMPEG, ["-y", "-v", "error", "-i", file, "-vf", `fps=${fps.toFixed(4)},scale=${tw}:${th},tile=${cols}x${rows}:padding=4:color=black`, "-frames:v", "1", "-q:v", "4", out]);
  return out;
}
