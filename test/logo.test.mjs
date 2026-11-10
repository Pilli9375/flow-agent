import { test } from "node:test";
import assert from "node:assert/strict";
import { _geometry, _repairPlane } from "../dist/logo.js";

test("video logo scales with the shorter side, so landscape and portrait give the same star", () => {
  const land = _geometry("video", 1920, 1080);
  const port = _geometry("video", 1080, 1920);
  assert.equal(land.f, 1.5);
  assert.equal(port.f, 1.5);
  assert.equal(land.cx, 1920 - 180.5);
  assert.equal(port.cy, 1920 - 180.5);
  // Half the size gives half the star and half the margin.
  const small = _geometry("video", 640, 360);
  assert.ok(Math.abs(small.f - 0.5) < 1e-9);
  assert.ok(Math.abs(small.cx - (640 - 180.5 / 3)) < 1e-9);
});

test("image logo is a fixed 48 px star 96.5 px in from the corner at any size", () => {
  for (const [w, h] of [[1376, 768], [1024, 1024], [768, 1376]]) {
    const g = _geometry("image", w, h);
    assert.equal(g.f, 1);
    assert.equal(g.cx, w - 96.5);
    assert.equal(g.cy, h - 96.5);
  }
});

// shown = 0.7 * original + 0.3 * white * coverage; reversing it must give the original back.
test("reversing the 30% white blend recovers the original exactly inside the star", () => {
  const w = 40, h = 40, white = 255;
  const bg = new Uint8Array(w * h), s = new Float32Array(w * h), shown = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    bg[i] = 20 + x * 4 + y; // a smooth gradient
    s[i] = Math.hypot(x - 20, y - 20) < 12 ? 1 : 0;
    shown[i] = Math.round((1 - 0.3 * s[i]) * bg[i] + 0.3 * s[i] * white);
  }
  const out = _repairPlane(shown, w, h, s, new Uint8Array(w * h), white, 2);
  let worst = 0;
  for (let i = 0; i < w * h; i++) worst = Math.max(worst, Math.abs(out[i] - bg[i]));
  assert.ok(worst <= 2, `largest error ${worst}`);
});

test("pixels outside the star are never changed", () => {
  const w = 30, h = 30, white = 255;
  const shown = new Uint8Array(w * h).map((_, i) => (i * 7) % 251);
  const s = new Float32Array(w * h); // empty coverage
  const out = _repairPlane(shown, w, h, s, new Uint8Array(w * h), white, 2);
  assert.deepEqual(Array.from(out), Array.from(shown));
});

test("the edge band is filled from trusted neighbours (a bad edge pixel disappears)", () => {
  const w = 21, h = 21, white = 255;
  const shown = new Uint8Array(w * h).fill(100);
  const s = new Float32Array(w * h), band = new Uint8Array(w * h);
  shown[10 * w + 10] = 250; // one wrong pixel...
  band[10 * w + 10] = 1; // ...marked as band
  const out = _repairPlane(shown, w, h, s, band, white, 2);
  assert.ok(Math.abs(out[10 * w + 10] - 100) <= 1);
});

test("the cleanup verdict: ok, texture-compensated ok, soft, fail", async () => {
  const { judge } = await import("../dist/logo.js");
  assert.equal(judge(0.1, -0.1, 20), "ok");
  // a bright corner: contrast of only 8 grey levels, residual 0.35 = under 3 levels
  assert.equal(judge(0.35, 0.3, 8), "ok");
  // textured corner: the star contrast dropped by about one star (0.55 -> -0.58), leftover is the picture's own texture
  assert.equal(judge(-0.58, -0.16, 20, { core: 0.55, edge: 0.94 }), "ok");
  // no real drop and a big leftover: rejected
  assert.equal(judge(0.8, 0.8, 20, { core: 0.9, edge: 0.9 }), "fail");
  // a modest leftover without a clean before/after drop is only a labelled soft pass
  assert.equal(judge(-0.5, 0.2, 15), "soft");
});
