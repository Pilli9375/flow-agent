import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Candidate } from "./selectors.js";

// Offline check of selectors.json against saved accessibility snapshots of Flow's pages (fixtures/aria/*.yml), so a
// selector edit, or a Flow redesign captured in new fixtures, is caught without Chrome and without a live Flow page.
// Mirrors the live rule: the first candidate that matches exactly one element wins. Visibility is not in the snapshot
// (it only lists what is exposed on the page), so css/text candidates cannot be judged offline and are skipped.

export type AriaNode = { role: string; name: string };
export type Expectation = [action: string, vars?: Record<string, string>];
export type Expected = Record<string, Expectation[]>;

const sub = (s: string, vars: Record<string, string>) => s.replace(/\$\{(\w+)\}/g, (_, k) => vars[k] ?? "");
const unescape = (s: string) => s.replace(/\\(["\\])/g, "$1");

// Lines look like:  - button "Name" [checked]:   or   - 'button "Name: with colon"'   or   - heading "Title" [level=1]
export function parseAria(yml: string): AriaNode[] {
  const nodes: AriaNode[] = [];
  for (const raw of yml.split(/\r?\n/)) {
    const m = /^\s*- (?:'(\w+)(?: "((?:[^"\\]|\\.)*)")?[^']*'|(\w+)(?: "((?:[^"\\]|\\.)*)")?)/.exec(raw);
    if (!m) continue;
    const role = m[1] ?? m[3];
    if (role) nodes.push({ role, name: unescape(m[2] ?? m[4] ?? "") });
  }
  return nodes;
}

function matches(c: Candidate, nodes: AriaNode[], vars: Record<string, string>): number | null {
  if (!c.role) return null; // css / text: not judged offline
  const inRole = nodes.filter((n) => n.role === c.role);
  if (c.pattern) {
    const re = new RegExp(sub(c.pattern, vars));
    return inRole.filter((n) => re.test(n.name)).length;
  }
  if (c.name === undefined) return inRole.length;
  const want = sub(c.name, vars);
  return inRole.filter((n) => (c.exact ? n.name === want : n.name.toLowerCase().includes(want.toLowerCase()))).length;
}

export type Verdict = { action: string; state: string; ok: boolean; note: string };

export function checkState(selectors: Record<string, Candidate[]>, state: string, nodes: AriaNode[], expected: Expectation[]): Verdict[] {
  return expected.map(([action, vars = {}]) => {
    const cands = selectors[action];
    if (!cands) return { action, state, ok: false, note: "no selectors defined" };
    let unjudged = 0;
    const counts: string[] = [];
    for (const c of cands) {
      const n = matches(c, nodes, vars);
      if (n === null) { unjudged++; continue; }
      if (n === 1) return { action, state, ok: true, note: "matches exactly one element" };
      counts.push(String(n));
    }
    if (unjudged === cands.length) return { action, state, ok: true, note: "only css/text candidates (not judged offline)" };
    return { action, state, ok: false, note: `no candidate matches exactly one element (matches per candidate: ${counts.join(", ") || "none"})` };
  });
}

export const FIXTURE_DIR = new URL("../fixtures/aria/", import.meta.url);
const dirPath = (d: URL | string) => (typeof d === "string" ? d : decodeURIComponent(d.pathname.replace(/^\/([A-Za-z]:)/, "$1")));

// Runs every state that has a fixture. States without a fixture file are reported as skipped, not failed.
export function checkFixtures(dir: URL | string = FIXTURE_DIR, selectorsFile: URL | string = new URL("../selectors.json", import.meta.url)): { verdicts: Verdict[]; skipped: string[] } {
  const d = dirPath(dir);
  const selectors = JSON.parse(readFileSync(typeof selectorsFile === "string" ? selectorsFile : selectorsFile, "utf8")) as Record<string, Candidate[]>;
  const expectedFile = join(d, "expected.json");
  if (!existsSync(expectedFile)) return { verdicts: [], skipped: ["(no fixtures captured yet)"] };
  const expected = JSON.parse(readFileSync(expectedFile, "utf8")) as Expected;
  const verdicts: Verdict[] = [];
  const skipped: string[] = [];
  for (const [state, exp] of Object.entries(expected)) {
    const f = join(d, `${state}.yml`);
    if (!existsSync(f)) { skipped.push(state); continue; }
    verdicts.push(...checkState(selectors, state, parseAria(readFileSync(f, "utf8")), exp));
  }
  return { verdicts, skipped };
}

// Personal details never go into fixtures (they are committed): emails, the account's name, ids.
export function sanitizeSnapshot(yml: string): string {
  return yml
    .replace(/[\w.+-]+(?:@|%40)[\w-]+(\.[\w-]+)+/g, "user@example.com")
    .replace(/([?&]Email=)[^&\s"']*/gi, "$1REDACTED")
    .replace(/Google Account: [^"]*?, Google membership/g, "Google Account: REDACTED, Google membership")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "00000000-0000-0000-0000-000000000000")
    .replace(/^url: .*$/m, "url: (removed)");
}

export function saveFixture(state: string, yml: string, dir: URL | string = FIXTURE_DIR): string {
  const d = dirPath(dir);
  mkdirSync(d, { recursive: true });
  const file = join(d, `${state}.yml`);
  writeFileSync(file, sanitizeSnapshot(yml));
  return file;
}

export const listFixtures = (dir: URL | string = FIXTURE_DIR): string[] => (existsSync(dirPath(dir)) ? readdirSync(dirPath(dir)).filter((f) => f.endsWith(".yml")) : []);
