import type { Frame, Page } from "playwright-core";
import { getFlowPage } from "./chrome.js";
import { FlowUiError, find } from "./selectors.js";

export type Credits = { credits: number; resets?: string };

// The balance lives in the account menu (a Google-hosted frame): "<N> Google Flow credits, Resets <date>".
async function readFrames(page: Page): Promise<{ credits?: number; resets?: string; frame?: Frame }> {
  for (const frame of page.frames()) {
    const text = await frame.locator("body").innerText({ timeout: 1500 }).catch(() => "");
    const m = /([\d,]+)\s+Google Flow credits/i.exec(text);
    if (m) return { credits: Number(m[1].replace(/,/g, "")), resets: /Resets\s+([^\n]+)/i.exec(text)?.[1]?.trim(), frame };
  }
  return {};
}

// Opens the account menu, reads the balance, and closes the menu again (it would otherwise block later clicks).
export async function readCredits(): Promise<Credits> {
  const page = await getFlowPage();
  for (let i = 0; i < 4 && (await page.locator(".cdk-overlay-backdrop-showing").count()); i++) { await page.keyboard.press("Escape"); await page.waitForTimeout(300); }
  await (await find(page, "account_menu")).click({ timeout: 8000 });
  let found: Awaited<ReturnType<typeof readFrames>> = {};
  for (let i = 0; i < 12 && found.credits === undefined; i++) {
    await page.waitForTimeout(700);
    found = await readFrames(page);
  }
  const closed = async () => (await readFrames(page)).credits === undefined;
  if (found.frame) await found.frame.getByRole("button", { name: /close/i }).first().click({ timeout: 2000 }).catch(() => {});
  for (let i = 0; i < 3 && !(await closed()); i++) { await page.keyboard.press("Escape"); await page.waitForTimeout(500); }
  if (found.credits === undefined) throw new FlowUiError("Could not read the credit balance from Flow's account menu.");
  return { credits: found.credits, resets: found.resets };
}
