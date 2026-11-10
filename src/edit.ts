import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Page } from "playwright-core";
import { getFlowPage } from "./chrome.js";
import { downloadBest, tiles, typePrompt, videoUrl } from "./flow.js";
import { pause, recordRejection, recordSubmission, submissionBlocked } from "./guard.js";
import { budgetBlocked, recordSpend } from "./ledger.js";
import { dismiss, ensureView, locate, resolve, sweep, type Ref } from "./library.js";
import { cleanLogo, cleanLogoHybrid } from "./logo.js";
import { OUT_ROOT } from "./media.js";
import { FlowUiError } from "./selectors.js";

// Edit an existing image with a prompt (Flow's own editor). Flow stores the edit as a new VERSION of the same item (the
// original version stays in its history); the edited version is downloaded, the corner logo is removed, and the file is
// saved under Edits/. Images cost no credits.
//
// Video edits spend credits and have not been verified live yet, so they stay switched off unless
// FLOW_AGENT_VIDEO_EDIT=1 is set; they also need an explicit max_credits that covers Flow's quote.
const VIDEO_EDIT = process.env.FLOW_AGENT_VIDEO_EDIT === "1";

const PROMPT_BOX = /What do you want to change|Describe how to edit/i;

async function readQuote(page: Page): Promise<number | null> {
  const link = () => page.getByRole("link", { name: /^\d+ credits?$/ }).first();
  const read = async () => ((await link().count()) ? Number(/\d+/.exec(await link().innerText())?.[0]) : null);
  const direct = await read();
  if (direct !== null) return direct;
  const trigger = page.getByRole("button", { name: /Settings trigger/ });
  if (await trigger.count()) {
    await trigger.first().click({ timeout: 4000 });
    await page.waitForTimeout(700);
    const q = await read();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    return q;
  }
  return null;
}

const rejected = async (page: Page) => (await page.getByText(/unusual activity/i).count()) > 0;

function nextEditStem(dir: string): string {
  const n = existsSync(dir) ? Math.max(0, ...readdirSync(dir).map((f) => Number(/^edit-(\d+)/.exec(f)?.[1] ?? 0))) : 0;
  return `edit-${String(n + 1).padStart(2, "0")}`;
}

export async function editItem(ref: Ref, prompt: string, maxCredits = 0, onProgress?: (s: string) => void): Promise<string> {
  if (!prompt.trim()) throw new FlowUiError("A prompt describing the change is required.");
  const blocked = submissionBlocked();
  if (blocked) throw new FlowUiError(blocked);
  const page = await getFlowPage();
  const projectId = await ensureView(page, "grid");
  const [item] = resolve(await sweep(page), [ref]);
  if (item.kind !== "image" && item.kind !== "video") throw new FlowUiError(`Only images and videos can be edited ("${item.title}" is ${item.kind}).`);
  const video = item.kind === "video";
  if (video && !VIDEO_EDIT) throw new FlowUiError("Editing an existing video is not switched on: it spends credits and has not been verified live yet. Ask the user whether to test it (a small test costs a few credits), or regenerate with a changed prompt instead.");
  const before = await tiles(page);

  // Open the item in Flow's editor.
  const tile = await locate(page, item);
  await tile.click({ position: { x: 90, y: 90 } });
  await page.waitForURL(/\/edit\//, { timeout: 15_000 });
  const box = page.getByRole("textbox", { name: PROMPT_BOX }).first();
  await box.waitFor({ timeout: 15_000 });

  const leave = async () => {
    await dismiss(page).catch(() => {});
    const done = page.getByRole("button", { name: /Done/ }).first();
    if (await done.count()) await done.click({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(1500);
  };

  // Cost check before anything is submitted. An unreadable video quote is never guessed.
  let credits = await readQuote(page);
  // Flow's video editor shows no price. Only when the user has explicitly set the price to assume (and approved it) does
  // an unreadable video quote proceed, using that number for the cap and the spend ledger; the real cost is then
  // checked against the balance before and after (see the delivered text).
  const assumed = Number(process.env.FLOW_AGENT_VIDEO_EDIT_COST);
  if (credits === null && video && Number.isFinite(assumed) && assumed > 0) credits = assumed;
  if (credits === null && video) {
    await leave();
    throw new FlowUiError("Could not read Flow's cost for this video edit, so nothing was submitted.");
  }
  if ((credits ?? 0) > maxCredits) {
    await leave();
    throw new FlowUiError(`Skipped: Flow quotes ${credits} credits for this edit, over the cap of ${maxCredits}. Nothing was spent.`);
  }
  if (await page.getByRole("button", { name: "Insufficient credits warning" }).count()) {
    await leave();
    throw new FlowUiError("Flow reports insufficient credits, so nothing was submitted.");
  }
  const overBudget = budgetBlocked(credits ?? 0);
  if (overBudget) {
    await leave();
    throw new FlowUiError(overBudget);
  }

  // The editor's main view always shows the selected version; an edit is done when its bytes differ from the start.
  const main = page.locator('img[alt="Read-only image view"]').first();
  const mainBytes = async (): Promise<Buffer | null> => {
    const src = await main.getAttribute("src").catch(() => null);
    if (!src) return null;
    const res = await page.context().request.get(src);
    return res.ok() ? await res.body() : null;
  };
  const md5 = (b: Buffer) => createHash("md5").update(b).digest("hex");
  const startBytes = video ? null : await mainBytes();
  const startHash = startBytes ? md5(startBytes) : "";
  const fresh = new Map<string, string>();
  const outDir = join(OUT_ROOT, "Edits");
  mkdirSync(outDir, { recursive: true });
  const stem = nextEditStem(outDir);
  const files: string[] = [];
  const notes: string[] = [];
  try {
    await typePrompt(page, box, prompt);
    await pause(page, 700, 2000);
    recordSubmission();
    await page.getByRole("button", { name: "Start generation" }).click({ timeout: 8000 });
    recordSpend({ credits: credits ?? 0, what: `edit: ${prompt.slice(0, 40)}`, model: video ? "video edit" : "image edit" });
    onProgress?.("submitted");

    if (!video) {
      if (!startHash) throw new FlowUiError("Could not read the current image in Flow's editor, so nothing was submitted.");
      const deadline = Date.now() + 240_000;
      let edited: Buffer | null = null;
      while (!edited && Date.now() < deadline) {
        await page.waitForTimeout(3000);
        if (await rejected(page)) {
          recordRejection();
          throw new FlowUiError('Flow rejected the edit (its "unusual activity" check) and nothing was delivered. Pausing submissions for a while.');
        }
        const now = await mainBytes();
        if (now && now.length > 10_000 && md5(now) !== startHash) {
          await page.waitForTimeout(1500); // let the new version finish loading, then read it once more
          edited = (await mainBytes()) ?? now;
        }
      }
      if (!edited) throw new FlowUiError("Timed out waiting for the edited image.");
      void fresh;
      const file = join(outDir, `${stem}.jpeg`);
      writeFileSync(file, edited);
      const clean = await cleanLogo(file, "image");
      if (clean.status !== "none") notes.push(clean.note);
      files.push(file);
    } else {
      // The edit is generated server side: go back to the grid and wait for the new tile, as for a normal generation.
      await leave();
      await ensureView(page, "grid");
      const deadline = Date.now() + 600_000;
      let index = -1;
      let url = "";
      while (Date.now() < deadline) {
        await page.waitForTimeout(1500);
        const now = await tiles(page);
        const added = now.length - before.length;
        const isNew = added > 0 && now.slice(added).every((t, i) => t.label === before[i].label);
        const bad = isNew ? now.slice(0, added).find((t) => t.failed) : undefined;
        if (bad) {
          if (/unusual activity/i.test(bad.failed)) recordRejection();
          throw new FlowUiError(`Flow rejected the edit and nothing was delivered. Flow says: "${bad.failed}"`);
        }
        const ready = isNew ? now.slice(0, added).findIndex((t) => t.isVideo && t.src) : -1;
        if (ready >= 0) {
          index = ready;
          url = videoUrl(now[ready].src);
          break;
        }
      }
      if (index < 0) throw new FlowUiError("Timed out waiting for the edited video.");
      const res = await page.context().request.get(url);
      if (!res.ok()) throw new FlowUiError(`Download failed (${res.status()}) for the edited video.`);
      const file = join(outDir, `${stem}.mp4`);
      writeFileSync(file, await res.body());
      const srcFile = join(outDir, `.src-${basename(file)}`);
      let quality = "";
      try {
        quality = await downloadBest(page, page.locator("[role=group]").nth(index), file, onProgress, srcFile);
      } catch (e) {
        await page.keyboard.press("Escape").catch(() => {});
        quality = `original size kept, upscale failed: ${(e as Error).message.split("\n")[0]}`;
      }
      const clean = existsSync(srcFile) ? await cleanLogoHybrid(file, srcFile) : await cleanLogo(file, "video");
      rmSync(srcFile, { force: true });
      if (clean.status !== "none") notes.push(clean.note);
      notes.push(`quality: ${quality}`);
      files.push(file);
    }
  } finally {
    if (!video) await leave().catch(() => {});
  }
  return [
    `edited "${item.title}" in project ${projectId.slice(0, 8)} (the original item is unchanged; the edit is a new item)`,
    `file: ${files[0]}`,
    `credits: ${credits ?? 0}`,
    ...(notes.length ? [notes.join("; ")] : ["no watermark found, nothing to remove"]),
  ].join("\n");
}
