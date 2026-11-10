import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

// Local cleanup of old output in ~/flow-agent-out. Nothing is ever erased: chosen folders are MOVED into
// <out>/.trash/<date>/ (so they can be moved back by hand), and only after a preview + one-time code, like the Flow
// Trash tools. It never touches anything outside the output folder and never touches Flow itself.

export type Entry = { name: string; bytes: number; mtime: number };
const SKIP = new Set([".trash"]);

function size(dir: string): number {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    try {
      total += e.isDirectory() ? size(p) : statSync(p).size;
    } catch {
      /* unreadable entry: skip it */
    }
  }
  return total;
}

function newest(dir: string): number {
  let t = statSync(dir).mtimeMs;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    try {
      t = Math.max(t, e.isDirectory() ? newest(p) : statSync(p).mtimeMs);
    } catch {
      /* skip */
    }
  }
  return t;
}

export function listProjects(root: string): Entry[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith("."))
    .map((e) => ({ name: e.name, bytes: size(join(root, e.name)), mtime: newest(join(root, e.name)) }))
    .sort((a, b) => a.mtime - b.mtime);
}

export const mb = (b: number) => `${(b / 1048576).toFixed(1)} MB`;
const day = (t: number) => new Date(t).toISOString().slice(0, 10);

// Which folders to propose: those named, or those whose newest file is older than `olderDays`. Names must exist.
export function pick(all: Entry[], opts: { names?: string[]; olderDays?: number }, now = Date.now()): { chosen: Entry[]; unknown: string[] } {
  const unknown = (opts.names ?? []).filter((n) => !all.some((e) => e.name === n));
  const byName = all.filter((e) => opts.names?.includes(e.name));
  const byAge = opts.olderDays === undefined ? [] : all.filter((e) => now - e.mtime > opts.olderDays! * 86_400_000);
  const chosen = [...new Map([...byName, ...byAge].map((e) => [e.name, e])).values()];
  return { chosen, unknown };
}

export const codeFor = (chosen: Entry[]) => createHash("sha1").update(chosen.map((e) => e.name).sort().join("\n")).digest("hex").slice(0, 6);

export function render(all: Entry[], chosen: Entry[] = []): string {
  const marked = new Set(chosen.map((e) => e.name));
  const rows = all.map((e) => `${marked.has(e.name) ? "[x]" : "[ ]"} ${e.name.padEnd(24)} ${mb(e.bytes).padStart(10)}  last change ${day(e.mtime)}`);
  const total = all.reduce((a, e) => a + e.bytes, 0);
  return [...rows, `total ${mb(total)} in ${all.length} folders` + (chosen.length ? `; selected ${chosen.length} (${mb(chosen.reduce((a, e) => a + e.bytes, 0))})` : "")].join("\n");
}

// Moves the chosen folders into <root>/.trash/<date>/. Returns where they went.
export function moveToTrash(root: string, chosen: Entry[], now = new Date()): string {
  const dest = join(root, ".trash", now.toISOString().slice(0, 10));
  mkdirSync(dest, { recursive: true });
  for (const e of chosen) {
    let target = join(dest, e.name);
    for (let i = 2; existsSync(target); i++) target = join(dest, `${e.name}-${i}`);
    renameSync(join(root, e.name), target);
  }
  return dest;
}
