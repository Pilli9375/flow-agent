import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { FFMPEG } from "./media.js";
import { _pipeFrames, _probe, type LogoResult } from "./logo.js";

// Flow's Veo models stamp a small white "Veo" text in the bottom-right corner (not the sparkle). It is a partly
// transparent white blend (shown = (1-a)*original + a*white, a up to about 0.9 on the thin strokes), constant over
// the whole clip. assets/veo-mark.json holds its alpha map (estimated from the temporal mean of a real clip).
// Method: detect it by correlating the clip's mean corner image with the map; per frame, reverse the blend where a
// is small and fill from the surrounding picture where a is large (the thin strokes are nearly opaque, so reversal
// would only amplify noise); then verify on the result and keep the original if anything is off.

type Tpl = { w: number; h: number; marginRight: number; marginBottom: number; white: number; alpha: Uint8Array };
const TPL: Tpl | null = (() => {
  try {
    const j = JSON.parse(readFileSync(new URL("../assets/veo-mark.json", import.meta.url), "utf8"));
    return { w: j.w, h: j.h, marginRight: j.marginRight, marginBottom: j.marginBottom, white: j.white, alpha: new Uint8Array(Buffer.from(j.alpha, "base64")) };
  } catch {
    return null;
  }
})();
const PAD = 6; // context pixels around the mark used for the plane fit and for filling
const MODE = (process.env.FLOW_AGENT_LOGO ?? "remove").toLowerCase();
const even = (n: number) => n - (n % 2);

export type VeoGeo = { x: number; y: number; tw: number; th: number; rx: number; ry: number; rw: number; rh: number };

// Where the mark sits in a frame of this size (it scales with the short side, margins measured from the bottom-right).
export function veoGeometry(w: number, h: number): VeoGeo | null {
  if (!TPL) return null;
  const s = Math.min(w, h) / 1080;
  const tw = even(Math.round(TPL.w * s)), th = even(Math.round(TPL.h * s));
  const x = even(w - Math.round(TPL.marginRight * s) - tw), y = even(h - Math.round(TPL.marginBottom * s) - th);
  if (x < PAD || y < PAD || tw < 8 || th < 6) return null;
  const rx = even(Math.max(0, x - PAD)), ry = even(Math.max(0, y - PAD));
  const rw = even(Math.min(w, x + tw + PAD) - rx), rh = even(Math.min(h, y + th + PAD) - ry);
  return { x, y, tw, th, rx, ry, rw, rh };
}

// The template's alpha resampled (bilinear) to the geometry, placed inside the region rx,ry,rw,rh.
export function alphaMap(g: VeoGeo): Float32Array {
  const out = new Float32Array(g.rw * g.rh);
  if (!TPL) return out;
  for (let y = 0; y < g.th; y++) for (let x = 0; x < g.tw; x++) {
    const sx = Math.min(TPL.w - 1, Math.max(0, ((x + 0.5) * TPL.w) / g.tw - 0.5)), sy = Math.min(TPL.h - 1, Math.max(0, ((y + 0.5) * TPL.h) / g.th - 0.5));
    const x0 = Math.floor(sx), y0 = Math.floor(sy), x1 = Math.min(TPL.w - 1, x0 + 1), y1 = Math.min(TPL.h - 1, y0 + 1), fx = sx - x0, fy = sy - y0;
    const v = (xx: number, yy: number) => TPL.alpha[yy * TPL.w + xx] / 255;
    const a = v(x0, y0) * (1 - fx) * (1 - fy) + v(x1, y0) * fx * (1 - fy) + v(x0, y1) * (1 - fx) * fy + v(x1, y1) * fx * fy;
    out[(g.y - g.ry + y) * g.rw + (g.x - g.rx + x)] = a < 0.03 ? 0 : a;
  }
  return out;
}

// Mean over all frames of the region's luma.
async function regionMean(file: string, g: VeoGeo): Promise<Float32Array> {
  const size = g.rw * g.rh;
  const p = spawn(FFMPEG, ["-v", "error", "-i", file, "-vf", `crop=${g.rw}:${g.rh}:${g.rx}:${g.ry},format=gray`, "-f", "rawvideo", "pipe:1"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  p.stderr.on("data", (d) => (err += d));
  const sum = new Float64Array(size);
  let n = 0, pending = Buffer.alloc(0);
  for await (const chunk of p.stdout) {
    pending = Buffer.concat([pending, chunk as Buffer]);
    while (pending.length >= size) {
      for (let i = 0; i < size; i++) sum[i] += pending[i];
      pending = pending.subarray(size); n++;
    }
  }
  await new Promise((r) => p.on("close", r));
  if (!n) throw new Error(err.trim().split("\n").pop() || "could not read the corner of the video");
  return Float32Array.from(sum, (v) => v / n);
}

// Quadratic plane fit through the pixels where `use` is true; returns the fitted surface everywhere.
function planeFit(img: Float32Array, w: number, h: number, use: Uint8Array): Float32Array {
  const T = 6, M = Array.from({ length: T }, () => new Float64Array(T + 1));
  const terms = (x: number, y: number) => { const u = x / w, v = y / h; return [1, u, v, u * u, v * v, u * v]; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!use[y * w + x]) continue;
    const t = terms(x, y);
    for (let i = 0; i < T; i++) { for (let j = 0; j < T; j++) M[i][j] += t[i] * t[j]; M[i][T] += t[i] * img[y * w + x]; }
  }
  for (let i = 0; i < T; i++) {
    let piv = i;
    for (let r = i + 1; r < T; r++) if (Math.abs(M[r][i]) > Math.abs(M[piv][i])) piv = r;
    [M[i], M[piv]] = [M[piv], M[i]];
    if (Math.abs(M[i][i]) < 1e-12) continue;
    for (let r = 0; r < T; r++) if (r !== i) { const f = M[r][i] / M[i][i]; for (let c = i; c <= T; c++) M[r][c] -= f * M[i][c]; }
  }
  const c = M.map((row, i) => (Math.abs(row[i]) < 1e-12 ? 0 : row[T] / row[i]));
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const t = terms(x, y); out[y * w + x] = t.reduce((s, v, i) => s + v * c[i], 0); }
  return out;
}

// How strongly the corner's mean image looks like the mark: correlation of (mean - smooth background) with the alpha map.
export function markCorrelation(mean: Float32Array, alpha: Float32Array, w: number, h: number): number {
  // Background fit only from pixels away from the mark (dilated by 2).
  const use = new Uint8Array(w * h).fill(1);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (alpha[y * w + x] > 0) for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const yy = y + dy, xx = x + dx; if (yy >= 0 && xx >= 0 && yy < h && xx < w) use[yy * w + xx] = 0; }
  const base = planeFit(mean, w, h, use);
  let sa = 0, sr = 0, saa = 0, srr = 0, sar = 0;
  const n = w * h;
  for (let i = 0; i < n; i++) { const r = mean[i] - base[i], a = alpha[i]; sa += a; sr += r; saa += a * a; srr += r * r; sar += a * r; }
  const cov = sar / n - (sa / n) * (sr / n), va = saa / n - (sa / n) ** 2, vr = srr / n - (sr / n) ** 2;
  return va > 0 && vr > 0 ? cov / Math.sqrt(va * vr) : 0;
}

// Where the mark can have left any trace: the alpha map grown by a couple of pixels, fading with distance (the real
// mark is blurred by the video codec and the upscaler, so it reaches past the estimated map).
export function reachMap(alpha: Float32Array, w: number, h: number): Float32Array {
  const out = Float32Array.from(alpha);
  const R = 2;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (alpha[y * w + x] <= 0) continue;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const yy = y + dy, xx = x + dx;
      if (yy < 0 || xx < 0 || yy >= h || xx >= w) continue;
      const v = Math.max(alpha[y * w + x], 0.3) * (1 - 0.3 * Math.hypot(dx, dy));
      if (v > out[yy * w + xx]) out[yy * w + xx] = v;
    }
  }
  return out;
}

// One plane of one frame: reverse the blend where alpha is small, fill from untouched neighbours where it is large or
// where only a blurred trace can remain.
function cleanPlane(buf: Buffer, off: number, stride: number, rx: number, ry: number, rw: number, rh: number, alpha: Float32Array, reach: Float32Array, white: number): void {
  // Neighbour search radius grows (6, 10, 16) until some untouched pixels are found: inside a wide mark the nearest ones can be far.
  const RADII = [6, 10, 16];
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
    const r = reach[y * rw + x];
    if (r <= 0) continue;
    const a = alpha[y * rw + x];
    const idx = off + (ry + y) * stride + rx + x;
    const rev = (buf[idx] - a * white) / Math.max(1 - a, 0.08);
    const wf = Math.min(1, Math.max(0, (r - 0.03) / 0.15));
    let out = rev;
    if (wf > 0) {
      for (const K of RADII) {
        const sig2 = 2 * (K / 2.7) * (K / 2.7);
        let sw = 0, sv = 0;
        for (let dy = -K; dy <= K; dy++) for (let dx = -K; dx <= K; dx++) {
          const yy = y + dy, xx = x + dx;
          if (yy < 0 || xx < 0 || yy >= rh || xx >= rw || reach[yy * rw + xx] > 0) continue;
          const wgt = Math.exp(-(dx * dx + dy * dy) / sig2);
          sw += wgt; sv += wgt * buf[off + (ry + yy) * stride + rx + xx];
        }
        if (sw > 1e-6) { out = wf * (sv / sw) + (1 - wf) * rev; break; }
      }
    }
    buf[idx] = Math.max(0, Math.min(255, Math.round(out)));
  }
}

const pct = (x: number) => x.toFixed(2);

// Detects the Veo mark and removes it in place (the untouched file goes to originals/ unless one is already there).
export async function cleanVeoMark(file: string): Promise<LogoResult> {
  if (MODE === "keep") return { status: "skipped", note: "logo removal is off (FLOW_AGENT_LOGO=keep)" };
  if (!TPL) return { status: "none", note: "no Veo mark data installed" };
  try {
    const info = await _probe(file);
    const g = veoGeometry(info.w, info.h);
    if (!g || !/^yuvj?420p$/.test(info.pixFmt)) return { status: "none", note: "Veo mark not checked (unsupported size or pixel format)" };
    const alpha = alphaMap(g);
    const before = markCorrelation(await regionMean(file, g), alpha, g.rw, g.rh);
    if (before < 0.45) return { status: "none", note: `no Veo mark found (match ${pct(before)})` };

    // Alpha maps per plane: luma at full resolution, chroma averaged over 2x2 (the colour planes are half size).
    const cw = g.rw / 2, ch = g.rh / 2;
    const aC = new Float32Array(cw * ch);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) aC[y * cw + x] = (alpha[2 * y * g.rw + 2 * x] + alpha[2 * y * g.rw + 2 * x + 1] + alpha[(2 * y + 1) * g.rw + 2 * x] + alpha[(2 * y + 1) * g.rw + 2 * x + 1]) / 4;
    const reachY = reachMap(alpha, g.rw, g.rh), reachC = reachMap(aC, cw, ch);
    const full = /^yuvj/.test(info.pixFmt) || info.range === "pc";
    const whiteY = full ? TPL.white : 16 + (219 * TPL.white) / 255;
    const tmp = join(dirname(file), `.veo-${process.pid}-${basename(file)}`);
    const { w, h } = info;
    await _pipeFrames(file, tmp, "video", info, true, (frame) => {
      cleanPlane(frame, 0, w, g.rx, g.ry, g.rw, g.rh, alpha, reachY, whiteY);
      cleanPlane(frame, w * h, w / 2, g.rx / 2, g.ry / 2, cw, ch, aC, reachC, 128);
      cleanPlane(frame, w * h + (w * h) / 4, w / 2, g.rx / 2, g.ry / 2, cw, ch, aC, reachC, 128);
    });
    const after = markCorrelation(await regionMean(tmp, g), alpha, g.rw, g.rh);
    if (process.env.FLOW_AGENT_DEBUG) console.error(`veo mark: match before ${pct(before)}, after ${pct(after)}`);
    if (!(Math.abs(after) < 0.25 && after < before * 0.5)) {
      if (process.env.FLOW_AGENT_DEBUG) renameSync(tmp, `${file}.veo-failed.mp4`); else rmSync(tmp, { force: true });
      return { status: "failed", note: `Veo mark found but the cleanup did not verify (match ${pct(before)} -> ${pct(after)}); original kept` };
    }
    const keep = join(dirname(file), "originals");
    mkdirSync(keep, { recursive: true });
    const archived = join(keep, basename(file));
    if (existsSync(archived)) rmSync(file, { force: true }); else renameSync(file, archived);
    renameSync(tmp, file);
    return { status: "removed", note: `Veo text mark removed (match ${pct(before)} -> ${pct(after)}; a faint trace may remain on very textured frames, please look at the corner)` };
  } catch (e) {
    return { status: "failed", note: `Veo mark check failed: ${(e as Error).message.split("\n")[0]}` };
  }
}
