import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkFixtures, checkState, parseAria, sanitizeSnapshot } from "../dist/offline.js";

const selectors = JSON.parse(readFileSync(new URL("../selectors.json", import.meta.url), "utf8"));

test("every control Flow's saved pages show is still found by selectors.json", () => {
  const { verdicts, skipped } = checkFixtures();
  const bad = verdicts.filter((v) => !v.ok).map((v) => `[${v.state}] ${v.action}: ${v.note}`);
  assert.deepEqual(bad, []);
  assert.ok(verdicts.length > 0 || skipped.length > 0);
});

test("the snapshot parser reads roles and names, including quoted names with colons", () => {
  const nodes = parseAria(`- main:\n  - button "Start generation"\n  - 'button "Google Account: X, Google membership"'\n  - heading "Title" [level=1]\n  - /url: "x"`);
  assert.deepEqual(nodes.map((n) => [n.role, n.name]), [["main", ""], ["button", "Start generation"], ["button", "Google Account: X, Google membership"], ["heading", "Title"]]);
});

test("a renamed button is reported, a duplicated one is reported, a fallback candidate rescues it", () => {
  const sel = { go: [{ role: "button", name: "Start generation" }], twice: [{ role: "button", name: "Add" }], saved: [{ role: "button", name: "Old name", exact: true }, { role: "button", pattern: "^New" }] };
  const nodes = parseAria(`- button "Begin generation"\n- button "Add"\n- button "Add"\n- button "New name"`);
  const v = Object.fromEntries(checkState(sel, "t", nodes, [["go"], ["twice"], ["saved"]]).map((x) => [x.action, x.ok]));
  assert.deepEqual(v, { go: false, twice: false, saved: true });
});

test("fixtures contain no personal details", () => {
  const out = sanitizeSnapshot('url: https://flow.google.com/project/11111111-2222-3333-4444-555555555555\n- \'button "Google Account: Jane Doe (jane@x.com), Google membership"\'');
  assert.doesNotMatch(out, /jane|Jane|11111111/);
});
