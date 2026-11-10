import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOW_AGENT_HOME = mkdtempSync(join(tmpdir(), "fa-ledger-"));
delete process.env.FLOW_AGENT_DAILY_BUDGET;
const l = await import("../dist/ledger.js");

test("no daily limit by default; the user can switch one on", () => {
  assert.equal(l.dailyBudget(), 0);
  assert.equal(l.budgetBlocked(1000), null);
  l.setDailyBudget(20);
  assert.equal(l.dailyBudget(), 20);
});

test("free generations never count or block", () => {
  assert.equal(l.budgetBlocked(0), null);
  l.recordSpend({ credits: 0, what: "image" });
  assert.equal(l.spentToday(), 0);
});

test("spends add up today and the next one is refused when it would pass the budget", () => {
  const now = Date.now();
  l.recordSpend({ credits: 7, what: "a", model: "Omni 1.1 Flash" }, now);
  l.recordSpend({ credits: 7, what: "b" }, now);
  assert.equal(l.spentToday(now), 14);
  assert.equal(l.budgetBlocked(6, now), null); // 20 exactly
  assert.match(l.budgetBlocked(7, now) ?? "", /Daily credit budget reached: 14 of 20/);
});

test("an unreadable cost is never allowed through", () => {
  assert.match(l.budgetBlocked(NaN) ?? "", /Could not read the credit cost/);
});

test("yesterday's spends do not count today", () => {
  const dir = mkdtempSync(join(tmpdir(), "fa-ledger2-"));
  assert.ok(dir);
  const yesterday = Date.now() - 36 * 3_600_000;
  l.recordSpend({ credits: 5, what: "old" }, yesterday);
  assert.equal(l.spentToday(Date.now()), 14);
});

test("the report shows the total, the budget and recent spends", () => {
  const r = l.spendReport();
  assert.match(r, /today: 14 of 20 credits used \(6 left/);
  assert.match(r, /recent spends:/);
});

test("a negative budget is rejected", () => {
  assert.throws(() => l.setDailyBudget(-1));
});
