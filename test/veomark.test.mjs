import { test } from "node:test";
import assert from "node:assert/strict";
import { alphaMap, markCorrelation, reachMap, veoGeometry } from "../dist/veomark.js";

test("the Veo mark sits near the bottom-right corner and scales with the short side", () => {
  const g = veoGeometry(1920, 1080);
  assert.deepEqual([g.x, g.y, g.tw, g.th], [1858, 1036, 44, 26]);
  assert.ok(g.x + g.tw <= 1920 - 15 && g.y + g.th <= 1080 - 15);
  const small = veoGeometry(1280, 720);
  assert.ok(small.tw < g.tw && small.tw >= 28 && small.x % 2 === 0 && small.y % 2 === 0);
  const portrait = veoGeometry(1080, 1920);
  assert.ok(portrait.x + portrait.tw < 1080 && portrait.y + portrait.th < 1920);
});

test("the alpha map holds the mark inside its region, with strong thin strokes", () => {
  const g = veoGeometry(1920, 1080);
  const a = alphaMap(g);
  assert.equal(a.length, g.rw * g.rh);
  const strong = a.filter((v) => v > 0.5).length;
  assert.ok(strong > 60 && strong < 250, `strong pixels: ${strong}`);
  assert.ok(Math.max(...a) <= 0.93);
});

test("a corner that carries the mark correlates with the map, a plain one does not", () => {
  const g = veoGeometry(1920, 1080);
  const a = alphaMap(g);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const plain = new Float32Array(a.length).map((_, i) => 80 + 20 * Math.sin(i / 17) + 6 * rnd());
  const marked = plain.map((v, i) => (1 - a[i]) * v + a[i] * 205);
  assert.ok(markCorrelation(marked, a, g.rw, g.rh) > 0.8);
  assert.ok(Math.abs(markCorrelation(plain, a, g.rw, g.rh)) < 0.2);
});

test("the reach map grows the mark by a couple of pixels and fades", () => {
  const w = 20, h = 20;
  const a = new Float32Array(w * h); a[10 * w + 10] = 0.9;
  const r = reachMap(a, w, h);
  assert.ok(Math.abs(r[10 * w + 10] - 0.9) < 1e-6);
  assert.ok(r[10 * w + 11] > 0 && r[10 * w + 11] < 0.9);
  assert.ok(r[10 * w + 12] > 0 && r[10 * w + 12] < r[10 * w + 11]);
  assert.equal(r[10 * w + 14], 0);
});
