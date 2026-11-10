import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME_DIR } from "./chrome.js";

// Spend ledger and daily credit budget, enforced by the worker itself (not by the model's good behaviour).
// Every generation or edit that spends credits is written down at the moment Start is clicked. Before that click the
// worker refuses anything that would take today's total over the daily budget, whatever max_credits the client sent.
// Off by default (0 = no limit): the user can switch it on with `budget <n>` or FLOW_AGENT_DAILY_BUDGET. Only the user can change it (CLI: `budget <n>`, or FLOW_AGENT_DAILY_BUDGET); no MCP tool changes it.
// Conservative: a spend is never refunded in the ledger, even if the generation later fails (Flow's refund is unverified).
const LEDGER = join(HOME_DIR, "spend.jsonl");
const SETTINGS = join(HOME_DIR, "budget.json");
export const DEFAULT_DAILY_BUDGET = 0; // 0 = no daily limit

export type Spend = { at: number; credits: number; what: string; project?: string; model?: string };

export function dailyBudget(): number {
  const env = process.env.FLOW_AGENT_DAILY_BUDGET;
  if (env !== undefined && env !== "" && Number.isFinite(Number(env))) return Math.max(0, Number(env));
  try {
    if (existsSync(SETTINGS)) {
      const n = Number(JSON.parse(readFileSync(SETTINGS, "utf8")).daily);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  } catch {
    /* fall back to the default */
  }
  return DEFAULT_DAILY_BUDGET;
}

export function setDailyBudget(n: number): void {
  if (!Number.isFinite(n) || n < 0) throw new Error("The budget must be a number of credits, 0 or more.");
  mkdirSync(HOME_DIR, { recursive: true });
  writeFileSync(SETTINGS, JSON.stringify({ daily: Math.floor(n) }));
}

export function readLedger(): Spend[] {
  try {
    if (!existsSync(LEDGER)) return [];
    return readFileSync(LEDGER, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as Spend];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

const dayKey = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function spentToday(now = Date.now()): number {
  const k = dayKey(now);
  return readLedger().filter((s) => dayKey(s.at) === k).reduce((a, s) => a + s.credits, 0);
}

// null when `credits` fits in today's budget, otherwise the reason nothing may be submitted.
export function budgetBlocked(credits: number, now = Date.now()): string | null {
  if (!Number.isFinite(credits)) return "Could not read the credit cost, so the daily budget cannot be checked. Nothing was spent.";
  if (credits <= 0) return null;
  const budget = dailyBudget();
  if (budget <= 0) return null; // no daily limit set
  const spent = spentToday(now);
  if (spent + credits > budget) {
    return `Daily credit budget reached: ${spent} of ${budget} credits already used today and this needs ${credits}. Nothing was spent. Only the user can raise the budget (run "node dist/cli.js budget <credits>" or set FLOW_AGENT_DAILY_BUDGET).`;
  }
  return null;
}

export function recordSpend(s: Omit<Spend, "at">, now = Date.now()): void {
  if (!(s.credits > 0)) return;
  try {
    mkdirSync(HOME_DIR, { recursive: true });
    appendFileSync(LEDGER, JSON.stringify({ at: now, ...s }) + "\n");
  } catch {
    /* best effort: the budget check above still saw every earlier entry */
  }
}

export function spendReport(now = Date.now()): string {
  const all = readLedger();
  const k = dayKey(now);
  const today = all.filter((s) => dayKey(s.at) === k);
  const used = today.reduce((a, s) => a + s.credits, 0);
  const budget = dailyBudget();
  const fmt = (s: Spend) => `${new Date(s.at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}  ${s.credits} credits  ${[s.model, s.project, s.what].filter(Boolean).join(" | ")}`;
  const lines = [budget > 0 ? `today: ${used} of ${budget} credits used (${Math.max(0, budget - used)} left in the daily budget)` : `today: ${used} credits used (no daily limit set)`];
  const recent = all.slice(-8);
  lines.push(recent.length ? "recent spends:" : "no spends recorded yet", ...recent.map((s) => "  " + fmt(s)));
  return lines.join("\n");
}
