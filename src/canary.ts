import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME_DIR } from "./chrome.js";

// Daily doctor canary: Flow's UI changes often, so the worker runs the non-spending doctor about once a day (when it is
// idle and Chrome is already up) and keeps the result, so flow_status can warn before a real job hits a broken control.
// FLOW_AGENT_CANARY=off turns it off.
const FILE = join(HOME_DIR, "canary.json");
export const CANARY_EVERY_MS = 24 * 3_600_000;
export const canaryEnabled = () => (process.env.FLOW_AGENT_CANARY ?? "on").toLowerCase() !== "off";

export type Canary = { at: number; failures: string[]; fixed: string[] };

export function readCanary(): Canary | null {
  try {
    return existsSync(FILE) ? (JSON.parse(readFileSync(FILE, "utf8")) as Canary) : null;
  } catch {
    return null;
  }
}

export const canaryDue = (now = Date.now(), last = readCanary()) => !last || now - last.at >= CANARY_EVERY_MS;

// Turns a doctor report into the saved result (pure, tested).
export function summarize(report: string[], now = Date.now()): Canary {
  return {
    at: now,
    failures: report.filter((l) => l.startsWith("FAIL")).map((l) => l.replace(/^FAIL\s+/, "").slice(0, 200)),
    fixed: report.filter((l) => l.startsWith("FIXED")).map((l) => l.replace(/^FIXED\s+/, "").slice(0, 200)),
  };
}

export function saveCanary(c: Canary): void {
  try {
    mkdirSync(HOME_DIR, { recursive: true });
    writeFileSync(FILE, JSON.stringify(c));
  } catch {
    /* best effort */
  }
}

export function canaryLine(now = Date.now(), c = readCanary()): string {
  if (!c) return "doctor canary: not run yet";
  const age = Math.round((now - c.at) / 3_600_000);
  const when = age < 1 ? "less than an hour ago" : `${age} h ago`;
  return c.failures.length ? `doctor canary: ${c.failures.length} control(s) BROKEN (${when}): ${c.failures.slice(0, 3).join("; ")}. Run: node dist/cli.js doctor --fix` : `doctor canary: all controls ok (${when})`;
}
