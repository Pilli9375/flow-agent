import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "playwright-core";
import { HOME_DIR } from "./chrome.js";

export type Candidate = { role?: string; name?: string; pattern?: string; exact?: boolean; text?: string; css?: string };
const FILE = new URL("../selectors.json", import.meta.url);

export class FlowUiError extends Error {}

const sub = (s: string, vars: Record<string, string>) => s.replace(/\$\{(\w+)\}/g, (_, k) => vars[k] ?? "");

function locatorFor(page: Page, c: Candidate, vars: Record<string, string>): Locator {
  if (c.role) {
    const name = c.pattern ? new RegExp(sub(c.pattern, vars)) : c.name ? sub(c.name, vars) : undefined;
    return page.getByRole(c.role as Parameters<Page["getByRole"]>[0], name === undefined ? {} : { name, exact: c.exact });
  }
  if (c.text) return page.getByText(sub(c.text, vars), { exact: c.exact });
  return page.locator(sub(c.css ?? "", vars));
}

// Returns the single visible element for an action, trying each candidate in order.
// More than one visible match counts as a miss (that is how an unscoped regex bit flow-mcp).
export async function find(page: Page, action: string, vars: Record<string, string> = {}, timeoutMs = 8000): Promise<Locator> {
  const loc = await tryFind(page, action, vars, timeoutMs);
  if (!loc) throw new FlowUiError(await saveDiag(page, action));
  return loc;
}

// Same as find but returns null instead of failing, for controls that are only sometimes on the page.
export async function tryFind(page: Page, action: string, vars: Record<string, string> = {}, timeoutMs = 1500): Promise<Locator | null> {
  const all = JSON.parse(readFileSync(FILE, "utf8")) as Record<string, Candidate[]>;
  const candidates = all[action];
  if (!candidates) throw new FlowUiError(`No selectors defined for "${action}".`);
  const deadline = Date.now() + timeoutMs;
  do {
    for (const c of candidates) {
      const loc = locatorFor(page, c, vars);
      const visible = await loc.filter({ visible: true }).count().catch(() => 0);
      if (visible === 1) return loc.filter({ visible: true });
    }
    await page.waitForTimeout(250);
  } while (Date.now() < deadline);
  return null;
}

const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
const similarity = (a: string, b: string): number => {
  const [x, y] = [words(a), words(b)];
  const both = [...x].filter((w) => y.has(w)).length;
  const jaccard = both / (x.size + y.size - both || 1);
  const [la, lb] = [a.toLowerCase(), b.toLowerCase()];
  const word = jaccard + (la && lb && (la.includes(lb) || lb.includes(la)) ? 0.3 : 0);
  // Character bigram overlap (Dice) catches small renames such as "Frames" -> "Framez".
  const grams = (s: string) => Array.from({ length: Math.max(0, s.length - 1) }, (_, i) => s.slice(i, i + 2));
  const [ga, gb] = [grams(la), grams(lb)];
  const common = ga.filter((g) => gb.includes(g)).length;
  return Math.max(word, ga.length + gb.length ? (2 * common) / (ga.length + gb.length) : 0);
};

// Zero-model repair: find the control on the live page whose accessible name is closest to the one the broken
// action used, and accept it only if it matches exactly one visible element. Returns the verified candidate or null.
export async function suggest(page: Page, action: string, vars: Record<string, string> = {}): Promise<Candidate | null> {
  const all = JSON.parse(readFileSync(FILE, "utf8")) as Record<string, Candidate[]>;
  const base = (all[action] ?? []).find((c) => c.role && (c.name || c.pattern));
  if (!base?.role) return null;
  const expected = sub(base.name ?? (base.pattern ?? "").replace(/[\\^$.*+?()[\]{}|]/g, " "), vars).trim();
  if (!expected) return null;
  const role = base.role as Parameters<Page["getByRole"]>[0];
  const els = await page.getByRole(role).filter({ visible: true }).all();
  const scored: { name: string; score: number }[] = [];
  for (const el of els.slice(0, 60)) {
    const snap = await el.ariaSnapshot({ timeout: 1500 }).catch(() => "");
    const name = /^- \w+ "((?:[^"\\]|\\.)*)"/.exec(snap.trim())?.[1];
    if (name) scored.push({ name, score: similarity(expected, name) });
  }
  scored.sort((a, b) => b.score - a.score);
  const [best, next] = scored;
  if (!best || best.score < 0.5 || (next && best.score - next.score < 0.2)) return null;
  if ((await page.getByRole(role, { name: best.name, exact: true }).filter({ visible: true }).count()) !== 1) return null;
  let name = best.name;
  for (const [k, v] of Object.entries(vars)) if (v && name.includes(v)) name = name.replace(v, `\${${k}}`);
  return { role: base.role, name, exact: true };
}

// Appends a verified fallback candidate to selectors.json (a JSON edit, no rebuild).
export function addCandidate(action: string, c: Candidate): void {
  const all = JSON.parse(readFileSync(FILE, "utf8")) as Record<string, Candidate[]>;
  all[action] = [...(all[action] ?? []), c];
  // One candidate per line, like the hand-written file, so the diff stays small.
  const fmt = (x: Candidate) => `{ ${Object.entries(x).map(([k, v]) => `"${k}": ${JSON.stringify(v)}`).join(", ")} }`;
  const rows = Object.entries(all).map(([k, v]) => (Array.isArray(v) ? (v.length === 1 ? `  "${k}": [${fmt(v[0])}]` : `  "${k}": [\n${v.map((x) => `    ${fmt(x)}`).join(",\n")}\n  ]`) : `  "${k}": ${JSON.stringify(v)}`));
  writeFileSync(FILE, `{\n${rows.join(",\n")}\n}\n`);
}

// Short error for the model; the screenshot and accessibility snapshot stay on disk.
export async function saveDiag(page: Page, action: string): Promise<string> {
  const dir = join(HOME_DIR, "diag", new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, "page.png") }).catch(() => {});
  const yml = await page.locator("body").ariaSnapshot().catch(() => "");
  writeFileSync(join(dir, "snapshot.yml"), `url: ${page.url()}\naction: ${action}\n${yml}`);
  return `Flow UI changed: could not find "${action}". Diagnostics saved in ${dir}. Fix selectors.json.`;
}
