import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";

export const FLOW_URL = "https://flow.google.com/";
export const HOME_DIR = process.env.FLOW_AGENT_HOME ?? join(homedir(), ".flow-agent");
// Dedicated Flow profile, never the everyday Chrome profile. Sign in once by hand; the login persists here.
export const PROFILE_DIR = process.env.FLOW_AGENT_PROFILE ?? join(HOME_DIR, "chrome-profile");
const CDP_PORT = Number(process.env.FLOW_AGENT_CDP_PORT ?? 9444);
const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;
const FLOW_HOSTS = /^https:\/\/(flow\.google\.com|labs\.google\/fx)/;

// Every label is matched by its English name, so Flow is always loaded with hl=en.
export const inEnglish = (url: string): string => {
  const u = new URL(url);
  u.searchParams.set("hl", "en");
  return u.toString();
};

const CHROME_PATHS = [
  process.env.FLOW_AGENT_CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : undefined,
].filter((p): p is string => Boolean(p));

let browser: Browser | null = null;

async function cdpUp(): Promise<boolean> {
  try {
    return (await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

// Real Chrome with its own profile: Google sign-in works normally and persists, and the
// user's everyday Chrome profile is never touched.
export async function launchChrome(url = FLOW_URL): Promise<void> {
  const exe = CHROME_PATHS.find((p) => existsSync(p));
  if (!exe) throw new Error("Google Chrome not found. Set FLOW_AGENT_CHROME to its executable path.");
  mkdirSync(PROFILE_DIR, { recursive: true });
  spawn(
    exe,
    [`--user-data-dir=${PROFILE_DIR}`, `--remote-debugging-port=${CDP_PORT}`, "--no-first-run", "--no-default-browser-check", inEnglish(url)],
    { detached: true, stdio: "ignore" },
  ).unref();
  for (let i = 0; i < 40; i++) {
    if (await cdpUp()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Chrome started but CDP port ${CDP_PORT} never came up.`);
}

export async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  if (!(await cdpUp())) await launchChrome();
  browser = await chromium.connectOverCDP(CDP_URL);
  return browser;
}

export async function getFlowPage(): Promise<Page> {
  const ctx = (await getBrowser()).contexts()[0];
  if (!ctx) throw new Error("Chrome has no browser context; close the Flow Chrome window and retry.");
  const existing = ctx.pages().find((p) => FLOW_HOSTS.test(p.url()));
  if (existing) return existing;
  const page = await ctx.newPage();
  await page.goto(inEnglish(FLOW_URL), { waitUntil: "domcontentloaded" });
  return page;
}
