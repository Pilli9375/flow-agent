import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME_DIR } from "./chrome.js";

// Gentle pacing so the automation behaves like a patient person. When Flow rejects a generation (its "unusual
// activity" check) we stop submitting for a cooldown that grows with repeated rejections; we never try to get around
// the check. The state is saved so a restart cannot wipe a cooldown.
const FILE = join(HOME_DIR, "state.json");
const HOURLY_CAP = Number(process.env.FLOW_AGENT_MAX_PER_HOUR ?? 15);
const BASE_COOLDOWN_MIN = Number(process.env.FLOW_AGENT_COOLDOWN_MIN ?? 30);
const MAX_COOLDOWN_MIN = 240;
const HOUR = 3_600_000;

type State = { cooldownUntil: number; strikes: number; lastStrikeAt: number; submissions: number[] };

function load(): State {
  try {
    if (existsSync(FILE)) return { cooldownUntil: 0, strikes: 0, lastStrikeAt: 0, submissions: [], ...JSON.parse(readFileSync(FILE, "utf8")) };
  } catch {
    /* fall through to a fresh state */
  }
  return { cooldownUntil: 0, strikes: 0, lastStrikeAt: 0, submissions: [] };
}
function save(s: State): void {
  try {
    mkdirSync(HOME_DIR, { recursive: true });
    writeFileSync(FILE, JSON.stringify(s));
  } catch {
    /* best effort */
  }
}

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

// null when a submission may go ahead, otherwise the reason it may not (nothing gets submitted).
export function submissionBlocked(now = Date.now()): string | null {
  const s = load();
  if (s.cooldownUntil > now) return `Cooling down until ${clock(s.cooldownUntil)} because Flow recently rejected a generation (its "unusual activity" check). Nothing was submitted; try again after that, or make the next one by hand in Flow.`;
  const recent = s.submissions.filter((t) => t > now - HOUR);
  if (recent.length >= HOURLY_CAP) return `Hourly limit of ${HOURLY_CAP} submissions reached (a slower pace keeps Flow from flagging the account). Next slot at ${clock(Math.min(...recent) + HOUR)}.`;
  return null;
}

export function recordSubmission(now = Date.now()): void {
  const s = load();
  s.submissions = [...s.submissions.filter((t) => t > now - HOUR), now];
  save(s);
}

// Call when Flow shows a rejected ("Failed") tile. Returns the new cooldown end.
export function recordRejection(now = Date.now()): number {
  const s = load();
  if (now - s.lastStrikeAt > 24 * HOUR) s.strikes = 0;
  s.strikes += 1;
  s.lastStrikeAt = now;
  s.cooldownUntil = now + Math.min(MAX_COOLDOWN_MIN, BASE_COOLDOWN_MIN * 2 ** (s.strikes - 1)) * 60_000;
  save(s);
  return s.cooldownUntil;
}

export function recordSuccess(): void {
  const s = load();
  if (s.strikes > 0) { s.strikes = Math.max(0, s.strikes - 1); save(s); }
}

export function guardStatus(now = Date.now()): string {
  const s = load();
  const recent = s.submissions.filter((t) => t > now - HOUR).length;
  return `${recent}/${HOURLY_CAP} submissions in the last hour${s.cooldownUntil > now ? `, COOLING DOWN until ${clock(s.cooldownUntil)}` : ""}`;
}

// Short random pause between UI steps, a few seconds at most.
export const pause = (page: { waitForTimeout(ms: number): Promise<void> }, minMs = 500, maxMs = 1800) => page.waitForTimeout(minMs + Math.random() * (maxMs - minMs));
