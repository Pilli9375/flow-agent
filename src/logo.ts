import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { FFMPEG, FFPROBE, tool } from "./media.js";

// Flow's free (daily) credits stamp a white star at 30% opacity into the bottom-right corner of every image and
// video: shown = 0.7 * original + 0.3 * 255 * coverage. Because that is a known blend, the original pixels can be
// recovered exactly inside the star. The thin edge band (anti-aliasing, and the ringing the 1080p upscaler adds)
// is rebuilt from the pixels around it, so nothing wider than a few pixels is ever interpolated.
const A = JSON.parse(readFileSync(new URL("../assets/sparkle.json", import.meta.url), "utf8")) as {
  alpha: number; white: number; window: number; star: number; centroid: [number, number];
  image: { marginRight: number; marginBottom: number };
  video: { scale: number; marginRight: number; marginBottom: number; refHeight: number };
};
const MASTER = new Uint8Array(readFileSync(new URL("../assets/sparkle.u8", import.meta.url)));
const MODE = (process.env.FLOW_AGENT_LOGO ?? "remove").toLowerCase();

type Kind = "image" | "video";
type Geo = { cx: number; cy: number; f: number; soft?: number };

// In-place separable Gaussian blur (sigma in px): the 1080p upscaler softens the star's edge.
function blur(a: Float32Array, w: number, h: number, sigma: number): void {
  const r = Math.ceil(3 * sigma), k: number[] = [];
  let sum = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k.push(v); sum += v; }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const tmp = new Float32Array(a.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 0;
    for (let i = -r; i <= r; i++) v += k[i + r] * a[y * w + Math.min(w - 1, Math.max(0, x + i))];
    tmp[y * w + x] = v;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 0;
    for (let i = -r; i <= r; i++) v += k[i + r] * tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x];
    a[y * w + x] = v;
  }
}
type Win = { x0: number; y0: number; w: number; h: number };
type Cov = { win: Win; s: Float32Array; band: Uint8Array; inner: Uint8Array; outer: Uint8Array; edgePairs: number[]; zone: Uint8Array };

export type LogoResult = { status: "none" | "removed" | "skipped" | "failed"; note: string };

function geometry(kind: Kind, w: number, h: number): Geo {
  if (kind === "image") return { f: 1, cx: w - A.image.marginRight, cy: h - A.image.marginBottom };
  const k = Math.min(w, h) / A.video.refHeight; // the star scales with the shorter side (the same in landscape and portrait)
  return { f: A.video.scale * k, cx: w - A.video.marginRight * k, cy: h - A.video.marginBottom * k };
}

const master = (u: number, v: number): number => {
  const n = A.window;
  const x = Math.floor(u), y = Math.floor(v);
  if (x < 0 || y < 0 || x >= n - 1 || y >= n - 1) return 0;
  const fx = u - x, fy = v - y;
  const p = (xx: number, yy: number) => MASTER[yy * n + xx] / 255;
  return p(x, y) * (1 - fx) * (1 - fy) + p(x + 1, y) * fx * (1 - fy) + p(x, y + 1) * (1 - fx) * fy + p(x + 1, y + 1) * fx * fy;
};

// Distance (in px) from every pixel to the nearest pixel of `set` (two-pass chamfer).
function distanceTo(set: Uint8Array, w: number, h: number): Float32Array {
  const d = new Float32Array(w * h).fill(1e9);
  for (let i = 0; i < d.length; i++) if (set[i]) d[i] = 0;
  const S = Math.SQRT2;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (x > 0) d[i] = Math.min(d[i], d[i - 1] + 1);
    if (y > 0) { d[i] = Math.min(d[i], d[i - w] + 1); if (x > 0) d[i] = Math.min(d[i], d[i - w - 1] + S); if (x < w - 1) d[i] = Math.min(d[i], d[i - w + 1] + S); }
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x;
    if (x < w - 1) d[i] = Math.min(d[i], d[i + 1] + 1);
    if (y < h - 1) { d[i] = Math.min(d[i], d[i + w] + 1); if (x < w - 1) d[i] = Math.min(d[i], d[i + w + 1] + S); if (x > 0) d[i] = Math.min(d[i], d[i + w - 1] + S); }
  }
  return d;
}

// Coverage of the star inside a window around its expected position, plus the pixel sets used to measure and repair it.
function buildCoverage(g: Geo, fw: number, fh: number, fixed?: Win): Cov {
  const half = Math.ceil(62 * g.f) + 6;
  // Even-aligned window so it lines up with the half-resolution color planes of 4:2:0 video.
  const even = (n: number) => n - (n % 2);
  const x0 = fixed?.x0 ?? even(Math.max(0, Math.floor(g.cx) - half)), y0 = fixed?.y0 ?? even(Math.max(0, Math.floor(g.cy) - half));
  const x1 = fixed ? fixed.x0 + fixed.w : even(Math.min(fw, Math.floor(g.cx) + half + 1)), y1 = fixed ? fixed.y0 + fixed.h : even(Math.min(fh, Math.floor(g.cy) + half + 1));
  const w = x1 - x0, h = y1 - y0;
  const s = new Float32Array(w * h);
  const [c0x, c0y] = A.centroid;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) s[y * w + x] = master(c0x + (x0 + x - g.cx) / g.f, c0y + (y0 + y - g.cy) / g.f);
  if (g.soft) blur(s, w, h, g.soft);
  const star = new Uint8Array(w * h), notStar = new Uint8Array(w * h);
  for (let i = 0; i < s.length; i++) { star[i] = s[i] > 0.5 ? 1 : 0; notStar[i] = star[i] ? 0 : 1; }
  const dOutside = distanceTo(star, w, h), dInside = distanceTo(notStar, w, h);
  const tune = (process.env.FLOW_AGENT_BAND ?? "").split(",").map(Number); const bandOut = Number.isFinite(tune[0]) && tune[0] > 0 ? tune[0] * g.f : 1.4 * g.f, bandIn = Number.isFinite(tune[1]) && tune[1] > 0 ? tune[1] * g.f : 1.0 * g.f;
  const band = new Uint8Array(w * h), inner = new Uint8Array(w * h), outer = new Uint8Array(w * h), zone = new Uint8Array(w * h);
  const edgePairs: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if ((star[i] ? dInside[i] : dOutside[i]) <= 4 * g.f) zone[i] = 1;
    if (s[i] > 0.02 && s[i] < 0.98) band[i] = 1; // partly covered pixels are never trusted
    if (star[i]) {
      if (dInside[i] <= bandIn) band[i] = 1;
      else if (dInside[i] >= 3 * g.f) inner[i] = 1;
    } else {
      if (dOutside[i] <= bandOut) band[i] = 1;
      if (dOutside[i] >= bandOut + 2 && dOutside[i] <= bandOut + 9 * g.f) outer[i] = 1;
    }
  }
  // Boundary pairs: a pixel just inside the repaired band and one just outside it, used for an edge-based measurement.
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (star[i] && dInside[i] > bandIn && dInside[i] <= bandIn + 1.5) {
      // walk outward to a pixel just outside the band
      let best = -1, bd = 1e9;
      for (let dy = -Math.ceil(bandOut + 3); dy <= Math.ceil(bandOut + 3); dy++) for (let dx = -Math.ceil(bandOut + 3); dx <= Math.ceil(bandOut + 3); dx++) {
        const yy = y + dy, xx = x + dx;
        if (yy < 0 || xx < 0 || yy >= h || xx >= w) continue;
        const j = yy * w + xx;
        if (!star[j] && dOutside[j] > bandOut && dOutside[j] <= bandOut + 1.5) { const dd = dx * dx + dy * dy; if (dd < bd) { bd = dd; best = j; } }
      }
      if (best >= 0) edgePairs.push(i, best);
    }
  }
  return { win: { x0, y0, w, h }, s, band, inner, outer, edgePairs, zone };
}

// The exact position of the star varies by a fraction of a pixel between files (and the 1080p upscaler shifts it
// slightly), so pick the offset whose reversal leaves the least edge energy around the star.
function align(g: Geo, base: Cov, wins: Uint8Array[], fw: number, fh: number): { g: Geo; c: Cov } {
  const energy = (c: Cov) => {
    const { w, h } = c.win;
    let tot = 0, n = 0;
    for (const win of wins) {
      const lum = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) {
        const a = A.alpha * c.s[i];
        let v = 0;
        for (let k = 0; k < 3; k++) v += Math.min(255, Math.max(0, (win[i * 3 + k] - a * A.white) / (1 - a)));
        lum[i] = v / 3;
      }
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (!base.zone[i]) continue;
        tot += Math.abs(4 * lum[i] - lum[i - 1] - lum[i + 1] - lum[i - w] - lum[i + w]); n++;
      }
    }
    return tot / Math.max(n, 1);
  };
  let best = { g, c: base, e: energy(base) };
  // Size first (an upscaler can grow or shrink the star a little), then position.
  for (const k of [0.9, 0.94, 0.97, 1.03, 1.06, 1.1, 1.15, 1.2]) {
    const cand = { ...g, f: g.f * k };
    const c = buildCoverage(cand, fw, fh, base.win);
    const e = energy(c);
    if (e < best.e) best = { g: cand, c, e };
    if (process.env.FLOW_AGENT_DEBUG) console.error(`size x${k}: edge energy ${e.toFixed(2)}`);
  }
  for (const step of [0.5, 0.25, 0.125]) {
    const center = best.g;
    for (const dx of [-step, 0, step]) for (const dy of [-step, 0, step]) {
      if (!dx && !dy) continue;
      const cand = { ...center, cx: center.cx + dx, cy: center.cy + dy };
      const c = buildCoverage(cand, fw, fh, base.win);
      const e = energy(c);
      if (e < best.e) best = { g: cand, c, e };
    }
  }
  // Edge softness (an upscaler blurs the star's edge, a plain download does not), then one more position pass.
  for (const soft of [0.6, 1.0, 1.4, 1.9]) {
    const cand = { ...best.g, soft };
    const c = buildCoverage(cand, fw, fh, base.win);
    const e = energy(c);
    if (e < best.e) best = { g: cand, c, e };
  }
  const center = best.g;
  for (const dx of [-0.5, 0, 0.5]) for (const dy of [-0.5, 0, 0.5]) {
    if (!dx && !dy) continue;
    const cand = { ...center, cx: center.cx + dx, cy: center.cy + dy };
    const c = buildCoverage(cand, fw, fh, base.win);
    const e = energy(c);
    if (e < best.e) best = { g: cand, c, e };
  }
  return { g: best.g, c: best.c };
}

const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

// How much of the expected star contrast is present (1 = star, 0 = none), measured on a cropped RGB window.
function measure(win: Uint8Array, c: Cov): { core: number; edge: number; bg: number; exp: number } {
  const { w, h } = c.win;
  const px = (i: number) => (win[i * 3] + win[i * 3 + 1] + win[i * 3 + 2]) / 3;
  const inn: number[] = [], out: number[] = [];
  for (let i = 0; i < w * h; i++) { if (c.inner[i]) inn.push(px(i)); if (c.outer[i]) out.push(px(i)); }
  const mo = mean(out), mi = mean(inn);
  const exp = A.alpha * (A.white - mo);
  const diffs: number[] = [];
  for (let k = 0; k < c.edgePairs.length; k += 2) diffs.push(px(c.edgePairs[k]) - px(c.edgePairs[k + 1]));
  return { core: (mi - mo) / exp, edge: mean(diffs) / exp, bg: mo, exp };
}

// Verdict on what is left of the star after cleaning. "ok": within 0.3 of the star's contrast (or under 3 grey levels on
// a very bright corner, where that contrast is only a few levels). "soft": a small residual (under 0.6 and 10 levels)
// that strongly textured picture (water, foliage) can cause by itself; it is delivered but labelled, never reported as
// a verified clean removal. "fail": the cleanup is rejected and the original kept.
// "ok" also covers a texture-compensated pass: measured on the same frames and window, the star contrast must have
// dropped by about one full star (core 0.7 to 1.35, edge 0.6 to 1.4); whatever is left is then the picture's own
// texture (it was there before too), not star.
export function judge(aCore: number, aEdge: number, level: number, before?: { core: number; edge: number }): "ok" | "soft" | "fail" {
  const c = Math.abs(aCore), e = Math.abs(aEdge);
  if ((c < 0.3 && e < 0.3) || (c * level < 3 && e * level < 3)) return "ok";
  if (before) {
    const dc = before.core - aCore, de = before.edge - aEdge;
    if (dc > 0.7 && dc < 1.35 && de > 0.6 && de < 1.4 && c < 0.7 && e < 0.7) return "ok";
  }
  if (c < 0.6 && e < 0.6 && c * level < 10 && e * level < 10) return "soft";
  return "fail";
}

// One plane (R, G, B, luma or chroma): reverses the blend inside the star (exact), then rebuilds the thin edge band
// from the trusted pixels around it. `white` is the plane's value for pure white (255 in RGB, 235 for limited-range
// luma, 128 for chroma, where white is neutral).
function repairPlane(src: Uint8Array, w: number, h: number, s: Float32Array, band: Uint8Array, white: number, sigma: number): Uint8Array {
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = A.alpha * s[i];
    out[i] = Math.min(255, Math.max(0, (src[i] - a * white) / (1 - a)));
  }
  const R = Math.ceil(2.5 * sigma);
  const result = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!band[i]) { result[i] = Math.round(out[i]); continue; }
    let sw = 0, sv = 0;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const yy = y + dy, xx = x + dx;
      if (yy < 0 || xx < 0 || yy >= h || xx >= w) continue;
      const j = yy * w + xx;
      if (band[j]) continue;
      const wt = Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
      sw += wt; sv += wt * out[j];
    }
    result[i] = sw > 0 ? Math.round(sv / sw) : Math.round(out[i]);
  }
  return result;
}

// RGB window (used when the file is not 4:2:0 YUV).
function repairWindow(win: Uint8Array, c: Cov, f: number): Uint8Array {
  const { w, h } = c.win, n = w * h;
  const result = new Uint8Array(win.length);
  for (let k = 0; k < 3; k++) {
    const plane = new Uint8Array(n);
    for (let i = 0; i < n; i++) plane[i] = win[i * 3 + k];
    const fixed = repairPlane(plane, w, h, c.s, c.band, A.white, 2 * f);
    for (let i = 0; i < n; i++) result[i * 3 + k] = fixed[i];
  }
  return result;
}

// Half-resolution versions of the coverage and band for the chroma planes of 4:2:0 video: the star's color change was
// stored at half resolution, so it has to be undone at half resolution (this is what removes the faint ghost).
function chromaMasks(c: Cov): { s: Float32Array; band: Uint8Array; w: number; h: number } {
  const w = c.win.w >> 1, h = c.win.h >> 1;
  const s = new Float32Array(w * h), band = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let sum = 0, b = 0;
    for (const [dy, dx] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
      const i = (2 * y + dy) * c.win.w + (2 * x + dx);
      sum += c.s[i]; b |= c.band[i];
    }
    s[y * w + x] = sum / 4; band[y * w + x] = b;
  }
  return { s, band, w, h };
}

async function probe(file: string) {
  const j = JSON.parse(await tool(FFPROBE, ["-v", "error", "-show_entries", "stream=codec_type,width,height,r_frame_rate,pix_fmt,color_range,color_space,color_primaries,color_transfer:format=duration", "-of", "json", file]));
  const v = j.streams.find((s: { codec_type: string }) => s.codec_type === "video");
  const [n, d] = String(v.r_frame_rate).split("/").map(Number);
  const tag = (k: string) => (v[k] && v[k] !== "unknown" ? String(v[k]) : undefined);
  return {
    w: v.width as number, h: v.height as number, fps: n / (d || 1), audio: j.streams.some((s: { codec_type: string }) => s.codec_type === "audio"), duration: Number(j.format.duration),
    pixFmt: String(v.pix_fmt ?? ""), range: tag("color_range"), space: tag("color_space"), primaries: tag("color_primaries"), trc: tag("color_transfer"),
  };
}

// One frame, cropped to the window, as RGB bytes.
async function grabWindow(file: string, at: number, win: Win): Promise<Uint8Array> {
  const out = await new Promise<Buffer>((resolve, reject) => {
    const p = spawn(FFMPEG, ["-v", "error", ...(at > 0 ? ["-ss", String(at)] : []), "-i", file, "-frames:v", "1", "-vf", `format=rgb24,crop=${win.w}:${win.h}:${win.x0}:${win.y0}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = []; let err = "";
    p.stdout.on("data", (c) => chunks.push(c)); p.stderr.on("data", (c) => (err += c));
    p.on("error", reject); p.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(err.trim().split("\n").pop() || `ffmpeg exit ${code}`))));
  });
  if (out.length !== win.w * win.h * 3) throw new Error(`Could not read the corner of the file (got ${out.length} bytes, wanted ${win.w * win.h * 3} for ${JSON.stringify(win)}).`);
  return new Uint8Array(out);
}

type Info = Awaited<ReturnType<typeof probe>>;

// Streams every frame of `src` through `handle` and encodes the result to `dst` (audio copied). 4:2:0 files stay in
// their own planes (luma full size, color half size), anything else goes through RGB.
async function pipeFrames(src: string, dst: string, kind: Kind, info: Info, native: boolean, handle: (frame: Buffer, index: number) => void | Promise<void>): Promise<void> {
  const { w, h } = info;
  const fmt = native ? info.pixFmt : "rgb24";
  const fs = native ? (w * h * 3) / 2 : w * h * 3;
  const tags = [...(info.range ? ["-color_range", info.range] : []), ...(info.space ? ["-colorspace", info.space] : []), ...(info.primaries ? ["-color_primaries", info.primaries] : []), ...(info.trc ? ["-color_trc", info.trc] : [])];
  const dec = spawn(FFMPEG, ["-v", "error", "-i", src, ...(kind === "image" ? ["-frames:v", "1"] : []), "-f", "rawvideo", "-pix_fmt", fmt, "pipe:1"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const encArgs = kind === "image"
    ? ["-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", fmt, "-s", `${w}x${h}`, "-i", "pipe:0", "-q:v", "1", "-pix_fmt", "yuvj420p", dst]
    : ["-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", fmt, "-s", `${w}x${h}`, "-r", String(info.fps), "-i", "pipe:0", "-i", src, "-map", "0:v", "-map", "1:a?", "-c:v", "libx264", "-crf", "14", "-preset", "medium", "-pix_fmt", "yuv420p", ...tags, "-c:a", "copy", "-movflags", "+faststart", dst];
  const enc = spawn(FFMPEG, encArgs, { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
  let derr = "", eerr = "";
  dec.stderr.on("data", (d) => (derr += d)); enc.stderr.on("data", (d) => (eerr += d));
  const done = Promise.all([
    new Promise<number>((r) => dec.on("close", (c) => r(c ?? 1))),
    new Promise<number>((r) => enc.on("close", (c) => r(c ?? 1))),
  ]);
  enc.stdin.on("error", () => {});
  let pending: Buffer[] = [], have = 0, index = 0;
  for await (const chunk of dec.stdout) {
    pending.push(chunk as Buffer); have += (chunk as Buffer).length;
    while (have >= fs) {
      const all = Buffer.concat(pending);
      const frame = Buffer.from(all.subarray(0, fs));
      pending = have > fs ? [all.subarray(fs)] : []; have -= fs;
      await handle(frame, index++);
      if (!enc.stdin.write(frame)) await new Promise((r) => enc.stdin.once("drain", r));
    }
  }
  enc.stdin.end();
  const [dc, ec] = await done;
  if (dc !== 0 || ec !== 0) throw new Error((eerr || derr).trim().split("\n").pop() || "ffmpeg failed while rewriting the file");
}

// Copies a window out of a plane stored at `base` with row length `stride`, and writes a window back.
const take = (frame: Buffer, base: number, stride: number, px: number, py: number, pw: number, ph: number) => {
  const out = new Uint8Array(pw * ph);
  for (let y = 0; y < ph; y++) frame.copy(out, y * pw, base + (py + y) * stride + px, base + (py + y) * stride + px + pw);
  return out;
};
const put = (frame: Buffer, base: number, stride: number, px: number, py: number, pw: number, ph: number, data: Uint8Array) => {
  for (let y = 0; y < ph; y++) Buffer.from(data.buffer, data.byteOffset + y * pw, pw).copy(frame, base + (py + y) * stride + px);
};

const isNative = (info: Info, c: Cov) => /^yuvj?420p$/.test(info.pixFmt) && info.w % 2 === 0 && info.h % 2 === 0 && c.win.x0 % 2 === 0 && c.win.y0 % 2 === 0 && c.win.w % 2 === 0 && c.win.h % 2 === 0;

async function rewrite(src: string, dst: string, kind: Kind, info: Info, c: Cov, f: number): Promise<void> {
  const { w, h } = info;
  const native = isNative(info, c);
  const lumaWhite = native && !(info.pixFmt === "yuvj420p" || info.range === "pc") ? 235 : 255;
  const chroma = native ? chromaMasks(c) : null;
  const { x0, y0, w: ww, h: wh } = c.win;
  await pipeFrames(src, dst, kind, info, native, (frame) => {
    if (native && chroma) {
      const sg = 2 * f;
      put(frame, 0, w, x0, y0, ww, wh, repairPlane(take(frame, 0, w, x0, y0, ww, wh), ww, wh, c.s, c.band, lumaWhite, sg));
      for (const base of [w * h, w * h + (w * h) / 4]) {
        put(frame, base, w / 2, x0 / 2, y0 / 2, chroma.w, chroma.h, repairPlane(take(frame, base, w / 2, x0 / 2, y0 / 2, chroma.w, chroma.h), chroma.w, chroma.h, chroma.s, chroma.band, 128, Math.max(1, sg / 2)));
      }
    } else {
      const win = new Uint8Array(ww * wh * 3);
      for (let y = 0; y < wh; y++) frame.copy(win, y * ww * 3, ((y0 + y) * w + x0) * 3, ((y0 + y) * w + x0 + ww) * 3);
      const fixed = repairWindow(win, c, f);
      for (let y = 0; y < wh; y++) Buffer.from(fixed.buffer, y * ww * 3, ww * 3).copy(frame, ((y0 + y) * w + x0) * 3);
    }
  });
}

// Every frame of a file as a tiny grayscale thumbnail (for matching frames between two renditions of one video).
async function thumbs(file: string, filter = ""): Promise<Uint8Array[]> {
  const TW = 64, TH = 36;
  const raw = await new Promise<Buffer>((resolve, reject) => {
    const p = spawn(FFMPEG, ["-v", "error", "-i", file, "-vf", `${filter}scale=${TW}:${TH}:flags=area,format=gray`, "-f", "rawvideo", "pipe:1"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = []; let err = "";
    p.stdout.on("data", (c) => chunks.push(c)); p.stderr.on("data", (c) => (err += c));
    p.on("error", reject); p.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(err.trim().split("\n").pop() || "ffmpeg failed"))));
  });
  const out: Uint8Array[] = [];
  for (let i = 0; i + TW * TH <= raw.length; i += TW * TH) out.push(new Uint8Array(raw.subarray(i, i + TW * TH)));
  return out;
}

// For each frame of the big file, the matching frame of the small file (the upscaler may drop or shift a frame).
function matchFrames(big: Uint8Array[], small: Uint8Array[]): number[] | null {
  const mse = (a: Uint8Array, b: Uint8Array) => { let s = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; } return s / a.length; };
  const out: number[] = []; let prev = 0, total = 0;
  for (let i = 0; i < big.length; i++) {
    let best = -1, bd = Infinity;
    for (let j = prev; j <= Math.min(small.length - 1, prev + 4); j++) { const d = mse(big[i], small[j]); if (d < bd) { bd = d; best = j; } }
    if (best < 0) return null;
    out.push(best); prev = best; total += bd;
  }
  return total / big.length < 120 ? out : null;
}

// Detects Flow's sparkle in a downloaded file and removes it. The original is kept in <folder>/originals/.
export const cleanLogo = (file: string, kind: Kind): Promise<LogoResult> => cleanFile(file, kind, true);

async function cleanFile(file: string, kind: Kind, archive: boolean): Promise<LogoResult> {
  if (MODE === "keep") return { status: "skipped", note: "logo removal is off (FLOW_AGENT_LOGO=keep)" };
  try {
    const info = await probe(file);
    const g = geometry(kind, info.w, info.h);
    if (g.cx < 0 || g.cy < 0) return { status: "skipped", note: "frame too small for the logo" };
    const c = buildCoverage(g, info.w, info.h);
    const times = kind === "image" ? [0] : [0.2, 0.5, 0.8].map((q) => q * info.duration);
    const wins = await Promise.all(times.map((t) => grabWindow(file, t, c.win)));
    const ms = wins.map((wd) => measure(wd, c));
    const usable = ms.filter((m) => A.white - m.bg >= 30);
    if (!usable.length) return { status: "none", note: "corner too bright for a visible logo" };
    const core = mean(usable.map((m) => m.core)), edge = mean(usable.map((m) => m.edge));
    if (!(core > 0.5 && core < 1.6 && edge > 0.35 && edge < 1.8)) return { status: "none", note: `no logo found (core ${core.toFixed(2)}, edge ${edge.toFixed(2)})` };
    if (process.env.FLOW_AGENT_DEBUG) console.error(`logo detect: core ${core.toFixed(2)} edge ${edge.toFixed(2)}`);
    const tmp = join(dirname(file), `.clean-${process.pid}-${basename(file)}`);
    const fit = align(g, c, wins, info.w, info.h);
    await rewrite(file, tmp, kind, info, fit.c, fit.g.f);
    const after = await Promise.all(times.map((t) => grabWindow(tmp, t, c.win)));
    const am = after.map((wd) => measure(wd, c));
    const aCore = mean(am.map((m) => m.core)), aEdge = mean(am.map((m) => m.edge));
    // Relative check, with an absolute floor: on a very bright corner the expected star contrast is only a few grey
    // levels, so ordinary picture texture alone can exceed 0.3 of it. Accept when the residual is under 3 grey levels.
    const level = mean(am.map((m) => m.exp));
    const v = judge(aCore, aEdge, level, { core, edge });
    const soft = v === "soft";
    if (process.env.FLOW_AGENT_DEBUG) console.error(`logo check: after core ${aCore.toFixed(2)} edge ${aEdge.toFixed(2)}, star contrast ${level.toFixed(1)} grey levels -> ${v}`);
    if (v === "fail") {
      if (process.env.FLOW_AGENT_DEBUG) renameSync(tmp, file + ".failed.mp4"); else rmSync(tmp, { force: true });
      return { status: "failed", note: `logo found but cleanup did not verify (after: core ${aCore.toFixed(2)}, edge ${aEdge.toFixed(2)}); original kept` };
    }
    if (archive) {
      const keep = join(dirname(file), "originals");
      mkdirSync(keep, { recursive: true });
      renameSync(file, join(keep, basename(file)));
    } else rmSync(file, { force: true });
    renameSync(tmp, file);
    return { status: "removed", note: soft ? "logo removed, but a faint outline may remain (textured, bright corner: the automatic check was loose; please look at the corner) (original saved in originals/)" : "logo removed (original saved in originals/)" };
  } catch (e) {
    return { status: "failed", note: `logo check failed: ${(e as Error).message.split("\n")[0]}` };
  }
}

// For an upscaled video: the original-size download (same video, crisp star) is cleaned exactly, and only the small
// corner patch of the upscaled file is replaced by that clean patch (resized, frame-matched, feathered). This keeps
// Flow's upscale everywhere else and avoids the upscaler's blurred, ringing star edge. Falls back to cleaning the
// upscaled file directly if anything does not line up.
export async function cleanLogoHybrid(file: string, srcFile: string): Promise<LogoResult> {
  if (MODE === "keep") return { status: "skipped", note: "logo removal is off (FLOW_AGENT_LOGO=keep)" };
  const fallback = () => cleanFile(file, "video", true);
  const fb = (i: number) => { if (process.env.FLOW_AGENT_DEBUG) console.error("hybrid logo cleanup fell back to the plain method at step " + i); return fallback(); };
  let cleanSrc = "";
  try {
    if (!existsSync(srcFile)) return await fb(0);
    const big = await probe(file), small = await probe(srcFile);
    const k = big.h / small.h;
    const P = 128; // patch size in source pixels
    if (!(k > 1) || Math.abs(big.w / small.w - k) > 0.01 || !Number.isInteger(P * k) || (P * k) % 2 || !/^yuvj?420p$/.test(big.pixFmt) || !/^yuvj?420p$/.test(small.pixFmt)) return await fb(1);
    cleanSrc = join(dirname(srcFile), `.clean-${process.pid}-${basename(srcFile)}`);
    copyFileSync(srcFile, cleanSrc);
    const r = await cleanFile(cleanSrc, "video", false);
    if (r.status !== "removed") { rmSync(cleanSrc, { force: true }); return r.status === "none" ? r : await fallback(); }

    // Window: P x P source pixels around the star (origin on a multiple of 4 so it stays even after scaling), P*k in the big file.
    const gs = geometry("video", small.w, small.h), gb = geometry("video", big.w, big.h);
    const x0s = Math.max(0, Math.min(small.w - P, 4 * Math.round((gs.cx - P / 2) / 4))), y0s = Math.max(0, Math.min(small.h - P, 4 * Math.round((gs.cy - P / 2) / 4)));
    const PT = P * k, x0 = x0s * k, y0 = y0s * k;
    if (x0 % 2 || y0 % 2 || x0 + PT > big.w || y0 + PT > big.h) { rmSync(cleanSrc, { force: true }); return await fb(2); }

    const [bigT, smallT] = await Promise.all([thumbs(file), thumbs(cleanSrc)]);
    const map = matchFrames(bigT, smallT);
    if (!map) { rmSync(cleanSrc, { force: true }); return await fb(3); }

    // Patch frames: the clean source's window, scaled up to the big file's size (Lanczos), as yuv420p.
    const patchRaw = await new Promise<Buffer>((resolve, reject) => {
      const p = spawn(FFMPEG, ["-v", "error", "-i", cleanSrc, "-vf", `crop=${P}:${P}:${x0s}:${y0s},scale=${PT}:${PT}:flags=lanczos,format=yuv420p`, "-f", "rawvideo", "pipe:1"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const chunks: Buffer[] = []; let err = "";
      p.stdout.on("data", (c) => chunks.push(c)); p.stderr.on("data", (c) => (err += c));
      p.on("error", reject); p.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(err.trim().split("\n").pop() || "ffmpeg failed"))));
    });
    const ps = (PT * PT * 3) / 2;
    const patches = Array.from({ length: Math.floor(patchRaw.length / ps) }, (_, i) => patchRaw.subarray(i * ps, (i + 1) * ps));
    if (!patches.length || Math.max(...map) >= patches.length) { rmSync(cleanSrc, { force: true }); return await fb(4); }

    // Circular feather around the star: full patch inside r1, original outside r2.
    const sx = gb.cx - x0, sy = gb.cy - y0, star = 24 * gb.f, r1 = star * 1.3 + 3, r2 = Math.min(r1 + 8 * gb.f, PT / 2 - 2);
    const weight = (x: number, y: number) => { const t = Math.min(1, Math.max(0, (r2 - Math.hypot(x - sx, y - sy)) / (r2 - r1))); return t * t * (3 - 2 * t); };
    const wY = new Float32Array(PT * PT), wC = new Float32Array((PT / 2) * (PT / 2));
    for (let y = 0; y < PT; y++) for (let x = 0; x < PT; x++) wY[y * PT + x] = weight(x, y);
    for (let y = 0; y < PT / 2; y++) for (let x = 0; x < PT / 2; x++) wC[y * (PT / 2) + x] = weight(2 * x + 0.5, 2 * y + 0.5);

    const tmp = join(dirname(file), `.clean-${process.pid}-${basename(file)}`);
    const { w, h } = big, cw = w / 2, ch = PT / 2;
    await pipeFrames(file, tmp, "video", big, true, (frame, i) => {
      const patch = patches[map[Math.min(i, map.length - 1)]];
      const mix = (base: number, stride: number, px: number, py: number, pw: number, ph: number, pOff: number, wt: Float32Array) => {
        for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
          const o = base + (py + y) * stride + px + x, a = wt[y * pw + x];
          if (a > 0) frame[o] = Math.round(a * patch[pOff + y * pw + x] + (1 - a) * frame[o]);
        }
      };
      mix(0, w, x0, y0, PT, PT, 0, wY);
      mix(w * h, cw, x0 / 2, y0 / 2, PT / 2, ch, PT * PT, wC);
      mix(w * h + (w * h) / 4, cw, x0 / 2, y0 / 2, PT / 2, ch, PT * PT + (PT * PT) / 4, wC);
    });

    // Verify on the big file's own geometry before replacing anything.
    const c = buildCoverage(gb, big.w, big.h);
    const times = [0.2, 0.5, 0.8].map((q) => q * big.duration);
    const am = (await Promise.all(times.map((t) => grabWindow(tmp, t, c.win)))).map((wd) => measure(wd, c));
    const aCore = mean(am.map((m) => m.core)), aEdge = mean(am.map((m) => m.edge));
    const bm = (await Promise.all(times.map((t) => grabWindow(file, t, c.win)))).map((wd) => measure(wd, c));
    const before = { core: mean(bm.map((m) => m.core)), edge: mean(bm.map((m) => m.edge)) };
    rmSync(cleanSrc, { force: true });
    const level = mean(am.map((m) => m.exp));
    const v = judge(aCore, aEdge, level, before);
    if (process.env.FLOW_AGENT_DEBUG) console.error(`hybrid check: before core ${before.core.toFixed(2)} edge ${before.edge.toFixed(2)}; after core ${aCore.toFixed(2)} edge ${aEdge.toFixed(2)}, star contrast ${level.toFixed(1)} grey levels -> ${v}`);
    if (v === "fail") { if (process.env.FLOW_AGENT_DEBUG) renameSync(tmp, file + ".hybrid-failed.mp4"); else rmSync(tmp, { force: true }); return await fb(5); }
    const keep = join(dirname(file), "originals");
    mkdirSync(keep, { recursive: true });
    renameSync(file, join(keep, basename(file)));
    renameSync(tmp, file);
    return { status: "removed", note: v === "soft" ? "logo removed from the 1080p file using the original-size source, but a faint outline may remain (textured, bright corner: the automatic check was loose; please look at the corner) (original saved in originals/)" : "logo removed from the 1080p file using the original-size source (original saved in originals/)" };
  } catch (e) {
    if (cleanSrc) rmSync(cleanSrc, { force: true });
    const r = await fallback();
    return r.status === "removed" ? r : { status: "failed", note: `hybrid failed (${(e as Error).message.split("\n")[0]}); ${r.note}` };
  }
}

export const logoAvailable = () => existsSync(new URL("../assets/sparkle.u8", import.meta.url));

// Exposed for tests only.
export const _geometry = geometry;
export const _repairPlane = repairPlane;
export const _probe = probe;
export const _pipeFrames = pipeFrames;
