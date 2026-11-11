import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Locator, Page } from "playwright-core";
import { FLOW_URL, HOME_DIR, getFlowPage, inEnglish } from "./chrome.js";
import { currentProjectId } from "./projects.js";
import { FlowUiError } from "./selectors.js";

// Library management for the open project: list, trash, restore, rename, favorite, set cover, rename project.
//
// Safety rules, enforced here and not only in the skill:
//  - "Delete" only ever means Move to Trash (recoverable). Nothing here can delete permanently, empty the Trash,
//    delete a project, or press any button whose name contains "delete": every menu entry or button we click must be
//    on the allow-list below, and the guard throws for anything else.
//  - Moving to Trash is two steps: a preview that returns a one-time confirm code, then the call with that code.
//  - Items are addressed by number AND exact title; if the grid changed since the list was read, nothing is touched.
//  - Every action is written to ~/.flow-agent/actions.log.

export type Item = { n: number; title: string; kind: "video" | "image" | "failed" | "other"; favorite: boolean; note: string; y: number; x: number };
export type Ref = { n: number; title: string };

// Every UI string the library clicks lives here (and only these may be clicked).
const UI = {
  more: "More options",
  menu: { rename: /Rename$/, trash: /Move to trash$/, cover: /Set project cover$/ },
  favorite: "Favorite",
  unfavorite: "Remove favorite",
  restore: "Restore",
} as const;
const FORBIDDEN = /delet|erase|permanent|empty trash|remove all|restore all/i;
function guard(name: string | RegExp): void {
  const s = String(name);
  if (FORBIDDEN.test(s)) throw new FlowUiError(`Refusing to click "${s}": the library only moves items to the Trash and restores them.`);
}

export const log = (entry: Record<string, unknown>) => {
  try {
    mkdirSync(HOME_DIR, { recursive: true });
    appendFileSync(join(HOME_DIR, "actions.log"), JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n");
  } catch {
    /* the journal is best effort */
  }
};

export async function dismiss(page: Page): Promise<void> {
  for (let i = 0; i < 4 && (await page.locator(".cdk-overlay-backdrop-showing").count()) > 0; i++) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  }
}

// Opens the project's media grid or its Trash page and waits until tiles (or the empty state) are there.
export async function ensureView(page: Page, view: "grid" | "trash"): Promise<string> {
  const id = currentProjectId(page);
  if (!id) throw new FlowUiError("No Flow project is open. Open one first (flow_open_project).");
  const want = `/project/${id}${view === "trash" ? "/trash" : ""}`;
  const path = new URL(page.url()).pathname;
  if (path !== want) await page.goto(inEnglish(`${FLOW_URL.replace(/\/$/, "")}${want}`), { waitUntil: "domcontentloaded" });
  await dismiss(page);
  for (let i = 0; i < 20; i++) {
    if ((await page.locator("[role=group]").count()) > 0) break;
    const text = await page.locator("body").innerText().catch(() => "");
    if (/Trash is empty|0 items in trash|Start creating or drop media/i.test(text)) break;
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(500);
  return id;
}

// The grid only draws the rows in view, so read it by scrolling from top to bottom.
export async function sweep(page: Page): Promise<Item[]> {
  const raw = await page.evaluate(async () => {
    const sc = document.querySelector<HTMLElement>(".cdk-virtual-scrollable") ?? [...document.querySelectorAll<HTMLElement>("*")].filter((e) => e.scrollHeight > e.clientHeight + 50 && getComputedStyle(e).overflowY !== "visible").sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
    const seen = new Map<string, { title: string; kind: string; favorite: boolean; note: string; y: number; x: number }>();
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const collect = () => {
      const top = sc ? sc.getBoundingClientRect().top : 0;
      for (const g of document.querySelectorAll<HTMLElement>("[role=group]")) {
        const r = g.getBoundingClientRect();
        const y = Math.round(r.top - top + (sc?.scrollTop ?? 0)), x = Math.round(r.left);
        const title = g.getAttribute("aria-label") ?? "";
        // The same tile can move a few pixels between scroll positions (the scrollbar changes the width), so tiles with the
        // same title within 40 px count as one.
        if ([...seen.values()].some((s) => s.title === title && Math.abs(s.y - y) < 40 && Math.abs(s.x - x) < 40)) continue;
        const key = `${title}|${y}|${x}`;
        const text = g.innerText.replace(/\s+/g, " ").trim();
        const failed = /^(warning )?Failed\b/i.test(text);
        const video = !!g.querySelector("video") || !!g.querySelector('img[alt="Generated video thumbnail"]');
        seen.set(key, { title, kind: failed ? "failed" : video ? "video" : g.querySelector("img") ? "image" : "other", favorite: !!g.querySelector('button[aria-label="Remove favorite"]'), note: failed ? text.slice(0, 160) : "", y, x });
      }
    };
    if (sc) { sc.scrollTop = 0; await wait(800); }
    collect();
    for (let i = 0; sc && i < 120 && sc.scrollTop + sc.clientHeight < sc.scrollHeight - 2; i++) {
      sc.scrollTop += Math.max(200, sc.clientHeight * 0.6);
      await wait(650);
      collect();
    }
    if (sc) sc.scrollTop = 0;
    return [...seen.values()];
  });
  raw.sort((a, b) => Math.round(a.y / 40) - Math.round(b.y / 40) || a.x - b.x);
  return raw.map((r, i) => ({ n: i + 1, ...r, kind: r.kind as Item["kind"] }));
}

// Scrolls so the item is on screen and returns its tile (matched by title AND position).
export async function locate(page: Page, it: Item): Promise<Locator> {
  const idx = await (async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.evaluate((y) => {
        const sc = document.querySelector<HTMLElement>(".cdk-virtual-scrollable");
        if (sc) sc.scrollTop = Math.max(0, y - 140);
      }, it.y);
      await page.waitForTimeout(900);
      const found = await page.evaluate(({ title, y, x }) => {
        const sc = document.querySelector<HTMLElement>(".cdk-virtual-scrollable");
        const top = sc ? sc.getBoundingClientRect().top : 0;
        return [...document.querySelectorAll<HTMLElement>("[role=group]")].findIndex((g) => {
          const r = g.getBoundingClientRect();
          return g.getAttribute("aria-label") === title && Math.abs(r.top - top + (sc?.scrollTop ?? 0) - y) < 40 && Math.abs(r.left - x) < 40;
        });
      }, { title: it.title, y: it.y, x: it.x });
      if (found >= 0) return found;
    }
    return -1;
  })();
  if (idx < 0) throw new FlowUiError(`Could not find "${it.title}" on screen; the grid may have changed. List again.`);
  return page.locator("[role=group]").nth(idx);
}

export function resolve(items: Item[], refs: Ref[]): Item[] {
  return refs.map((r) => {
    const it = items[r.n - 1];
    if (!it || it.title !== r.title) throw new FlowUiError(`Item #${r.n} is ${it ? `"${it.title}"` : "not there"} now, not "${r.title}". Nothing was changed; list again.`);
    return it;
  });
}

const kindLabel = (k: Item["kind"]) => (k === "failed" ? "FAILED" : k);
const line = (i: Item) => `${i.n}. [${kindLabel(i.kind)}] ${i.title}${i.favorite ? " ♥" : ""}${i.note ? ` (${i.note.slice(0, 90)})` : ""}`;

async function menuAction(page: Page, tile: Locator, entry: RegExp): Promise<void> {
  guard(entry);
  await tile.hover();
  await tile.getByRole("button", { name: UI.more, exact: true }).click({ timeout: 8000 });
  await page.getByRole("menuitem", { name: entry }).first().click({ timeout: 8000 });
}

// ---- reads ----

export async function listMedia(opts: { kind?: string; query?: string; favorites?: boolean } = {}): Promise<string> {
  const page = await getFlowPage();
  const id = await ensureView(page, "grid");
  let items = await sweep(page);
  const total = items.length;
  if (opts.kind) items = items.filter((i) => i.kind === opts.kind);
  if (opts.query) items = items.filter((i) => i.title.toLowerCase().includes(opts.query!.toLowerCase()));
  if (opts.favorites) items = items.filter((i) => i.favorite);
  return [`project ${id.slice(0, 8)}: ${total} item${total === 1 ? "" : "s"}${items.length !== total ? `, showing ${items.length}` : ""}`, ...items.map(line)].join("\n");
}

export async function listTrash(): Promise<string> {
  const page = await getFlowPage();
  const id = await ensureView(page, "trash");
  const items = await sweep(page);
  return [`trash of project ${id.slice(0, 8)}: ${items.length} item${items.length === 1 ? "" : "s"}`, ...items.map(line)].join("\n");
}

// ---- Move to Trash: preview, then confirm ----

const pending = new Map<string, { project: string; titles: string; expires: number }>();
const MAX_TRASH = 25;

export async function trashMedia(refs: Ref[], confirm?: string): Promise<string> {
  if (!refs.length) throw new FlowUiError("No items given.");
  if (refs.length > MAX_TRASH) throw new FlowUiError(`At most ${MAX_TRASH} items per call; do it in batches.`);
  if (new Set(refs.map((r) => r.n)).size !== refs.length) throw new FlowUiError("The same item was given twice.");
  const page = await getFlowPage();
  const id = await ensureView(page, "grid");
  const items = await sweep(page);
  const targets = resolve(items, refs);
  const titles = targets.map((t) => `${t.n}:${t.title}`).join("|");
  if (!confirm) {
    const code = randomBytes(3).toString("hex");
    pending.set(code, { project: id, titles, expires: Date.now() + 10 * 60_000 });
    log({ action: "trash-preview", project: id, items: targets.map((t) => t.title) });
    return [
      `PREVIEW (nothing has been changed). These ${targets.length} item(s) would be moved to the Trash of project ${id.slice(0, 8)} (recoverable with restore):`,
      ...targets.map(line),
      `Ask the user to approve this exact list, then call again with confirm="${code}" (valid 10 minutes).`,
    ].join("\n");
  }
  const p = pending.get(confirm);
  if (!p || p.project !== id || p.titles !== titles || p.expires < Date.now()) throw new FlowUiError("The confirm code is missing, expired, or does not match this exact list. Run the preview again.");
  pending.delete(confirm);
  // Highest number first, so the positions of the remaining targets do not shift.
  for (const t of [...targets].sort((a, b) => b.n - a.n)) {
    const tile = await locate(page, t);
    await menuAction(page, tile, UI.menu.trash);
    await page.waitForTimeout(1200);
    await dismiss(page);
  }
  const after = await sweep(page);
  const left = targets.filter((t) => after.some((a) => a.title === t.title && Math.abs(a.y - t.y) < 14 && Math.abs(a.x - t.x) < 14));
  const moved = targets.length - left.length;
  log({ action: "trash", project: id, items: targets.map((t) => t.title), moved });
  if (left.length) throw new FlowUiError(`Moved ${moved} of ${targets.length}; still in the grid: ${left.map((t) => `#${t.n} ${t.title}`).join(", ")}. Check Flow.`);
  return `Moved ${moved} item(s) to the Trash. They can be restored with flow_restore.`;
}

// ---- Restore from Trash (safe: no confirmation needed) ----

export async function restoreMedia(refs: Ref[]): Promise<string> {
  const page = await getFlowPage();
  const id = await ensureView(page, "trash");
  const items = await sweep(page);
  const targets = resolve(items, refs);
  for (const t of [...targets].sort((a, b) => b.n - a.n)) {
    const tile = await locate(page, t);
    guard(UI.restore);
    await tile.hover();
    await tile.getByRole("button", { name: UI.restore, exact: true }).click({ timeout: 8000 });
    await page.waitForTimeout(1200);
    await dismiss(page);
  }
  // Flow shows restored items in the grid a few seconds later: wait for them, so "restored" means they are really back.
  const want = new Map<string, number>();
  for (const t of targets) want.set(t.title, (want.get(t.title) ?? 0) + 1);
  const have = (items: Item[], title: string) => items.filter((i) => i.title === title).length;
  await ensureView(page, "grid");
  const before = await sweep(page);
  const base = new Map([...want.keys()].map((k) => [k, have(before, k)]));
  let back = false;
  for (let i = 0; i < 6 && !back; i++) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await ensureView(page, "grid");
    const now = await sweep(page);
    back = [...want].every(([title, n]) => have(now, title) >= (base.get(title) ?? 0) + n || have(now, title) >= n);
    if (!back) await page.waitForTimeout(2500);
  }
  log({ action: "restore", project: id, items: targets.map((t) => t.title), verified: back });
  if (!back) throw new FlowUiError("Restore was clicked but the items did not appear in the grid yet. Check Flow before retrying.");
  return `Restored ${targets.length} item(s) to the project.`;
}

// ---- Rename, favorite, cover ----

export async function editMedia(ref: Ref, action: "rename" | "favorite" | "unfavorite" | "cover", title?: string): Promise<string> {
  const page = await getFlowPage();
  const id = await ensureView(page, "grid");
  const [it] = resolve(await sweep(page), [ref]);
  const tile = await locate(page, it);
  if (action === "rename") {
    if (!title || !title.trim()) throw new FlowUiError("A new title is required.");
    if (title.length > 120) throw new FlowUiError("Title too long (120 characters max).");
    await menuAction(page, tile, UI.menu.rename);
    await page.waitForTimeout(600);
    await page.keyboard.press("Control+A");
    await page.keyboard.type(title.trim(), { delay: 15 });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1200);
    await dismiss(page);
    const after = (await sweep(page))[it.n - 1];
    log({ action: "rename", project: id, from: it.title, to: title.trim() });
    if (after?.title !== title.trim()) throw new FlowUiError(`The rename did not take effect (item #${it.n} is "${after?.title}").`);
    return `Renamed #${it.n} to "${title.trim()}".`;
  }
  if (action === "cover") {
    await menuAction(page, tile, UI.menu.cover);
    await page.waitForTimeout(1000);
    await dismiss(page);
    log({ action: "cover", project: id, item: it.title });
    return `Set "${it.title}" as the project cover.`;
  }
  const want = action === "favorite";
  if (it.favorite === want) return `"${it.title}" is already ${want ? "a favorite" : "not a favorite"}.`;
  await tile.hover();
  await tile.getByRole("button", { name: want ? UI.favorite : UI.unfavorite, exact: true }).click({ timeout: 8000 });
  await page.waitForTimeout(900);
  const after = (await sweep(page))[it.n - 1];
  log({ action, project: id, item: it.title });
  if (after?.favorite !== want) throw new FlowUiError("The favorite change did not take effect.");
  return `"${it.title}" is ${want ? "now a favorite" : "no longer a favorite"}.`;
}

// ---- Project title ----

export async function renameProject(name: string): Promise<string> {
  if (!name.trim() || name.length > 120) throw new FlowUiError("Give a project name of 1 to 120 characters.");
  const page = await getFlowPage();
  const id = await ensureView(page, "grid");
  const box = page.getByRole("textbox", { name: "Editable text" }).first();
  const old = await page.getByRole("heading", { level: 1 }).first().innerText().catch(() => "");
  await box.click({ timeout: 8000 });
  await page.keyboard.press("Control+A");
  await page.keyboard.type(name.trim(), { delay: 15 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1200);
  await dismiss(page);
  const now = await page.getByRole("heading", { level: 1 }).first().innerText().catch(() => "");
  log({ action: "project-rename", project: id, from: old, to: name.trim() });
  if (now.trim() !== name.trim()) throw new FlowUiError(`The project rename did not take effect (title is "${now}").`);
  return `Project renamed to "${name.trim()}".`;
}

// Exposed for tests only.
export const _guard = guard;
