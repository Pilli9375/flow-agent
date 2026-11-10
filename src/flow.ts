import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import type { Locator, Page } from "playwright-core";
import { HOME_DIR, getFlowPage } from "./chrome.js";
import { FlowUiError, addCandidate, find, suggest, tryFind } from "./selectors.js";
import { cleanLogo, cleanLogoHybrid } from "./logo.js";
import { pause } from "./guard.js";
import { budgetBlocked, recordSpend } from "./ledger.js";
import { saveFixture } from "./offline.js";
import { cleanVeoMark } from "./veomark.js";

type Common = { prompt: string; variants?: 1 | 2 | 3 | 4; max_credits?: number };
export type ImageScene = Common & { type?: "image"; aspect_ratio?: "16:9" | "4:3" | "1:1" | "3:4" | "9:16" };
export type VideoScene = Common & {
  type: "video";
  aspect_ratio?: "16:9" | "9:16";
  model?: "Omni 1.2 Flash" | "Omni 1.1 Flash" | "Veo 3.1 - Lite" | "Veo 3.1 - Fast" | "Veo 3.1 - Quality";
  duration?: number; // Omni models only: 4, 6, 8 or 10 s for Omni 1.1 Flash; any whole 3 to 15 s for Omni 1.2 Flash (slider)
  resolution?: "360p" | "720p"; // Omni models only
  // Local image files. Start/end frames animate between the two; references (Flow "Ingredients") steer subject or style.
  start_image?: string;
  end_image?: string;
  // Start from the last frame of the previous scene's video in the same project (the queue fills in start_image).
  chain?: boolean;
  reference_images?: string[];
};
export type Scene = ImageScene | VideoScene;
export type GenResult = { credits: number; files: string[]; quality?: string; logo?: string };

// Images come from flow-content.google/image/<uuid>; videos stream from flow.google.com/asb/<token>=<format>.
const MEDIA = /^https:\/\/(?:flow-content\.google\/(?:image|video)\/([0-9a-f-]{36})|flow\.google\.com\/asb\/([\w-]{40,}))/;
export const idOf = (url: string) => {
  const m = MEDIA.exec(url);
  return m?.[1] ?? m?.[2];
};

// Format suffix Flow's own player uses for the mp4 (seen on the tile's <video>); change here if Flow changes it.
const VIDEO_FORMAT = "mm,18,15";
export const videoUrl = (url: string) => `${url.replace(/=.*$/, "")}=${VIDEO_FORMAT}`;

async function ensureProject(page: Page): Promise<void> {
  if (!/flow\.google\.com\/project\//.test(page.url())) {
    throw new FlowUiError("No Flow project is open. Open or create a project in the Flow Chrome window (run: flow-agent login).");
  }
}

// Material toggle radios: click only when not already on, then wait for aria-checked to flip.
async function choose(loc: Locator): Promise<void> {
  if ((await loc.getAttribute("aria-checked")) === "true") return;
  await loc.click();
  for (let i = 0; i < 12; i++) {
    if ((await loc.getAttribute("aria-checked")) === "true") return;
    await loc.page().waitForTimeout(250);
  }
  throw new FlowUiError("A settings option did not switch on after clicking it.");
}

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp"]);

// Checked before anything is spent or clicked.
function checkImages(scene: Scene): void {
  if (scene.type !== "video") return;
  const files = [scene.start_image, scene.end_image, ...(scene.reference_images ?? [])].filter((f): f is string => !!f);
  for (const f of files) {
    if (!existsSync(f)) throw new FlowUiError(`Image not found: ${f}`);
    if (!IMAGE_EXT.has(extname(f).toLowerCase())) throw new FlowUiError(`Not a png/jpg/webp image: ${f}`);
  }
  if (scene.reference_images && scene.reference_images.length > 3) throw new FlowUiError("At most 3 reference images.");
  if (scene.reference_images?.length && (scene.start_image || scene.end_image)) throw new FlowUiError("Use either start/end frames or reference images, not both.");
  if (scene.end_image && !scene.start_image) throw new FlowUiError("end_image needs a start_image.");
}

// Every media tile in grid order (newest first). A finished video carries a <video> (recent ones) or a
// "Generated video thumbnail" image (older ones). Their links are signed and change between page loads, so tiles
// are told apart by position and title, never by link.
type Tile = { label: string; src: string; isVideo: boolean; failed: string };
export async function tiles(page: Page): Promise<Tile[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll("[role=group]")].map((g) => {
      const v = g.querySelector("video");
      const i = g.querySelector<HTMLImageElement>('img[alt="Generated video thumbnail"]');
      const text = (g as HTMLElement).innerText.replace(/\s+/g, " ").trim();
      return { label: g.getAttribute("aria-label") ?? "", src: v?.currentSrc || v?.src || (i && i.complete && i.naturalWidth > 0 ? i.src : "") || "", isVideo: !!v || !!i, failed: /^(warning )?Failed\b/i.test(text) ? text.slice(0, 300) : "" };
    }),
  );
}

// The grid is newest-first and may be scrolled by earlier clicks; make sure the newest tiles are rendered.
async function scrollGridToTop(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const e of document.querySelectorAll<HTMLElement>("*")) if (e.scrollTop > 0) e.scrollTop = 0;
  });
  await page.waitForTimeout(800);
}

// Highest-quality download for a finished video tile: the best "<N>p Original size|Upscaled" entry in the tile's
// Download menu, within MIN_HEIGHT..MAX_HEIGHT (4K and GIF are ignored). Flow upscales on its side and then offers the file.
const MIN_HEIGHT = 720;
const MAX_HEIGHT = 1080;
type SizeOption = { text: string; height: number; upscaled: boolean };

// Opens the tile's Download submenu and returns its "<N>p Original size|Upscaled" entries (4K and GIF are ignored).
async function readSizes(page: Page, tile: Locator): Promise<SizeOption[]> {
  await tile.hover({ timeout: 10_000 });
  await tile.getByRole("button", { name: "More options" }).click();
  await page.getByRole("menuitem", { name: /Download/ }).first().hover();
  await page.waitForTimeout(800);
  const texts = await page.getByRole("menuitem").evaluateAll((els) => els.map((e) => (e as HTMLElement).innerText.replace(/\s+/g, " ").trim()));
  return texts.flatMap((t) => {
    const m = /^(\d+)p (Original size|Upscaled)$/.exec(t);
    return m ? [{ text: t, height: Number(m[1]), upscaled: m[2] === "Upscaled" }] : [];
  });
}

// Clicks one entry of the open Download submenu and saves the file that arrives.
async function saveSize(page: Page, text: string, file: string, timeoutMs: number): Promise<void> {
  // Own download folder, set right before the click: Chrome keeps one download setting for the whole browser and any
  // other client that connected since (even one that has exited) may have left it pointing at a deleted folder.
  const dlDir = mkdtempSync(join(tmpdir(), "flow-agent-dl-"));
  try {
    const cdp = await page.context().browser()!.newBrowserCDPSession();
    await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dlDir, eventsEnabled: true });
    await page.getByRole("menuitem", { name: text, exact: true }).click();
    let got: string | undefined;
    let lastSize = -1;
    for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await page.waitForTimeout(1500)) {
      const done = readdirSync(dlDir).find((f) => f.endsWith(".mp4"));
      if (!done) continue;
      const size = statSync(join(dlDir, done)).size;
      if (size > 0 && size === lastSize) {
        got = join(dlDir, done);
        break;
      }
      lastSize = size;
    }
    if (!got) throw new FlowUiError(`The "${text}" file did not arrive in time.`);
    copyFileSync(got, file);
  } finally {
    rmSync(dlDir, { recursive: true, force: true });
  }
}

// With srcFile, the untouched original-size download is saved too (the logo is cleaned most exactly there).
export async function downloadBest(page: Page, tile: Locator, file: string, onProgress?: (s: string) => void, srcFile?: string): Promise<string> {
  let options = await readSizes(page, tile);
  const best = options.filter((o) => o.height <= MAX_HEIGHT).sort((a, b) => b.height - a.height)[0];
  if (!best || !best.upscaled) {
    await page.keyboard.press("Escape");
    return best ? `${best.height}p original` : "original (no download sizes found)";
  }
  const original = options.find((o) => !o.upscaled);
  if (srcFile && original) {
    await saveSize(page, original.text, srcFile, 90_000).catch(() => rmSync(srcFile, { force: true }));
    options = await readSizes(page, tile);
  }
  onProgress?.(`upscaling to ${best.height}p`);
  await saveSize(page, best.text, file, 300_000);
  return `${best.height}p${best.height < MIN_HEIGHT ? " (below the 720p minimum)" : ""}`;
}

// Opens Flow's asset picker from a frame slot or the ingredient button, uploads the file, and adds it to the prompt.
async function attach(page: Page, trigger: Locator, file: string): Promise<void> {
  await trigger.click();
  const list = await find(page, "picker_list");
  const name = basename(file);
  // The Ingredients picker appends the media type ("scene-01.jpeg Image"), the Frames picker does not.
  const exact = list.getByRole("option", { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( Image)?$`) });
  const uploading = list.getByRole("option", { name: /^Uploading / });
  const [chooser] = await Promise.all([page.waitForEvent("filechooser", { timeout: 10_000 }), (await find(page, "picker_upload")).click()]);
  await chooser.setFiles(file);
  // The new asset is listed as "Uploading <name>" and then becomes "<name>" (newest first). Wait for that swap.
  const start = Date.now();
  let sawUploading = false;
  for (;;) {
    const busy = await uploading.count();
    if (busy > 0) sawUploading = true;
    if (busy === 0 && (sawUploading || Date.now() - start > 4000) && (await exact.count()) > 0) break;
    if (Date.now() - start > 90_000) throw new FlowUiError(`Upload of ${name} did not finish in Flow.`);
    await page.waitForTimeout(500);
  }
  await exact.first().click();
  await (await find(page, "picker_add")).click();
  await page.waitForTimeout(800);
}

// Fills the frame slots or ingredient list; clears whatever an earlier run left behind first.
export async function attachImages(page: Page, scene: Scene): Promise<void> {
  if (scene.type !== "video") return;
  const clear = await tryFind(page, "clear_prompt");
  if (clear) await clear.click();
  if (scene.start_image) await attach(page, await find(page, "frame_start"), scene.start_image);
  if (scene.end_image) await attach(page, await find(page, "frame_end"), scene.end_image);
  for (const ref of scene.reference_images ?? []) await attach(page, await find(page, "ingredient_add"), ref);
}

// A menu or popup left open by an earlier step or run puts an invisible backdrop over the page that swallows clicks.
async function dismissOverlays(page: Page): Promise<void> {
  const open = page.locator(".cdk-overlay-backdrop-showing");
  for (let i = 0; i < 4 && (await open.count()) > 0; i++) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    if ((await open.count()) > 0) await open.last().click({ position: { x: 2, y: 2 }, force: true, timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(400);
  }
}

// Types the prompt in short bursts like a person would; falls back to a plain fill for very long prompts or if the
// typed text did not come out right.
export async function typePrompt(page: Page, box: Locator, text: string): Promise<void> {
  const clean = text.replace(/\s*\n+\s*/g, " ").trim();
  await box.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  if (clean.length <= 900) {
    for (let i = 0; i < clean.length; ) {
      const n = 10 + Math.floor(Math.random() * 20);
      await box.pressSequentially(clean.slice(i, i + n), { delay: 5 + Math.random() * 12 });
      i += n;
      if (Math.random() < 0.25) await page.waitForTimeout(80 + Math.random() * 260);
    }
    const got = (await box.innerText()).replace(/\s+/g, " ").trim();
    if (got === clean.replace(/\s+/g, " ")) return;
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Delete");
  }
  await box.fill(clean);
}

// Omni 1.2 Flash picks the length with a slider (3 to 15 s in 1 s steps) instead of 4/6/8/10 s buttons.
const durationSlider = async (page: Page) => ((await page.getByRole("slider", { name: "Length" }).count()) > 0 ? page.getByRole("slider", { name: "Length" }) : null);
async function setDuration(page: Page, seconds: number): Promise<void> {
  const slider = await durationSlider(page);
  if (slider) {
    if (!Number.isInteger(seconds) || seconds < 3 || seconds > 15) throw new FlowUiError("This model takes a whole number of seconds from 3 to 15.");
    // The slider renders a moment after the model switch and Flow may re-render it, so settle first, then set and
    // verify, trying the key presses a second time before giving up (seen once as a false failure right after a model change).
    await page.waitForTimeout(700);
    for (let attempt = 0; attempt < 3; attempt++) {
      await slider.focus();
      await page.keyboard.press("Home");
      for (let i = 0; i < seconds - 3; i++) await page.keyboard.press("ArrowRight");
      for (let w = 0; w < 8; w++) {
        if (await page.getByText(`${seconds} Sec`, { exact: true }).count()) return;
        await page.waitForTimeout(250);
      }
    }
    throw new FlowUiError(`Could not set the length to ${seconds} s.`);
  }
  if (![4, 6, 8, 10].includes(seconds)) throw new FlowUiError("This model takes 4, 6, 8 or 10 seconds (Omni 1.2 Flash takes any 3 to 15).");
  await choose(await find(page, "duration", { duration: String(seconds) }));
}

// Omni 1.2 Flash is the newest model; Omni 1.1 Flash leaves Flow on Dec 5.
export const DEFAULT_VIDEO_MODEL = "Omni 1.2 Flash";

// Pure helper (tested): the message when a requested model is not in Flow's model menu.
export function modelGoneMessage(model: string, offeredRaw: string[]): string {
  const offered = offeredRaw.map((t) => t.replace(/\s*Leaving.*$/is, "").replace(/\s+/g, " ").trim()).filter(Boolean);
  const list = offered.length ? offered.join(", ") : "none could be read";
  return `Flow does not offer the model "${model}" any more (it offers: ${list}). Pick one of those.`;
}

// Opens the settings popover, picks mode and options, returns the credit cost Flow quotes, then closes it.
async function applySettings(page: Page, scene: Scene): Promise<number> {
  const video = scene.type === "video";
  // Only open the panel if it is not already open (clicking the trigger again would close it).
  if (!(await tryFind(page, "mode_video", {}, 700))) await (await find(page, "settings_trigger")).click();
  await choose(await find(page, video ? "mode_video" : "mode_image"));
  if (scene.type === "video") {
    // Model first: Veo hides the resolution and duration choices Omni has.
    const model = scene.model ?? DEFAULT_VIDEO_MODEL;
    const menu = await find(page, "model_menu");
    if (!(await menu.innerText()).includes(model)) {
      await menu.click();
      const item = await tryFind(page, "model_item", { model }, 3000);
      if (!item) {
        // Flow retires models (Omni 1.1 Flash and Veo 3.1 Fast/Quality leave on Dec 5): say what is offered, spend nothing.
        const offered = await page.getByRole("menuitem").allInnerTexts().catch(() => [] as string[]);
        await page.keyboard.press("Escape");
        throw new FlowUiError(`${modelGoneMessage(model, offered)} Nothing was spent.`);
      }
      await item.click();
    }
    // Frames (start/end slots, also plain text-to-video) or Ingredients (reference images). Set before the size
    // options in case a mode switch resets them; the re-check at the end of this function guards the rest.
    await choose(await find(page, scene.reference_images?.length ? "mode_ingredients" : "mode_frames"));
    if (scene.resolution) await choose(await find(page, "resolution", { resolution: scene.resolution }));
    if (scene.duration) await setDuration(page, scene.duration);
  }
  await choose(await find(page, "ratio", { ratio: scene.aspect_ratio ?? "16:9" }));
  await choose(await find(page, "count", { count: String(scene.variants ?? 1) }));
  // Nothing may have been reset by a later click: re-read the options that decide quality before any spend.
  if (scene.type === "video") {
    const wanted: [string, Record<string, string>][] = [];
    if (scene.resolution) wanted.push(["resolution", { resolution: scene.resolution }]);
    if (scene.duration) wanted.push(["duration", { duration: String(scene.duration) }]);
    for (const [action, vars] of wanted) {
      if (action === "duration" && (await durationSlider(page))) {
        if (!(await page.getByText(`${vars.duration} Sec`, { exact: true }).count())) throw new FlowUiError("Flow reset the duration setting; nothing was spent.");
        continue;
      }
      if ((await (await find(page, action, vars)).getAttribute("aria-checked")) !== "true") throw new FlowUiError(`Flow reset the ${action} setting; nothing was spent.`);
    }
  }
  const quote = await (await find(page, "credit_quote")).innerText();
  await page.keyboard.press("Escape");
  return Number(/\d+/.exec(quote)?.[0] ?? NaN);
}

// Submits one scene through the UI; completion and files come from the network (media URLs).
export async function generate(scene: Scene, outDir: string, stem: string, onProgress?: (s: string) => void): Promise<GenResult> {
  const page = await getFlowPage();
  await ensureProject(page);
  const video = scene.type === "video";
  checkImages(scene);
  await dismissOverlays(page);
  const credits = await applySettings(page, scene).catch(async (e) => {
    await dismissOverlays(page).catch(() => {});
    throw e;
  });
  const cap = scene.max_credits ?? 0;
  if (!(credits <= cap)) throw new FlowUiError(`Skipped: Flow quotes ${credits} credits, over the cap of ${cap}. Nothing was spent.`);
  const overBudget = budgetBlocked(credits);
  if (overBudget) {
    await dismissOverlays(page).catch(() => {});
    throw new FlowUiError(overBudget);
  }

  // Before the media snapshot below, so the uploaded images' own thumbnails are not mistaken for results.
  await attachImages(page, scene);
  // Flow disables Start and shows this warning when the balance cannot cover the quote; without the check we would wait for nothing.
  if (await page.getByRole("button", { name: "Insufficient credits warning" }).count()) {
    throw new FlowUiError("Flow reports insufficient credits for this generation, so nothing was submitted. Check the credit balance in Flow.");
  }
  await scrollGridToTop(page);
  const before = await tiles(page);
  const seen = new Set<string>(
    (await page.locator("img, video").evaluateAll((els) => els.map((e) => (e as HTMLImageElement).currentSrc || (e as HTMLImageElement).src)))
      .map((u) => idOf(u))
      .filter((x): x is string => !!x),
  );
  const fresh = new Map<string, string>();
  mkdirSync(join(HOME_DIR, "diag"), { recursive: true });
  const mediaLog = join(HOME_DIR, "diag", "last-media.jsonl");
  writeFileSync(mediaLog, "");
  // Images finish as image/jpeg from flow-content.google. A finished video first shows up as its thumbnail
  // (image/jpeg from flow.google.com/asb/<token>); the mp4 is that same address plus the format suffix.
  const onResponse = (res: { url(): string; status(): number; headers(): Record<string, string> }) => {
    const id = idOf(res.url());
    if (!id) return;
    const ct = res.headers()["content-type"] ?? "";
    appendFileSync(mediaLog, JSON.stringify({ url: res.url().slice(0, 140), status: res.status(), ct, len: res.headers()["content-length"] }) + "\n");
    if (seen.has(id) || (res.status() !== 200 && res.status() !== 206)) return;
    const asb = res.url().startsWith("https://flow.google.com/asb/");
    // Videos are not detected from responses: old tiles re-fetch their thumbnails when the grid re-renders.
    if (!video && !asb && ct.startsWith("image/")) fresh.set(id, res.url());
  };
  page.on("response", onResponse);
  try {
    const box = await find(page, "prompt_box");
    await typePrompt(page, box, scene.prompt);
    await pause(page, 700, 2000);
    await (await find(page, "start")).click();
    recordSpend({ credits, what: scene.prompt.slice(0, 50), project: basename(outDir), model: video ? (scene.model ?? DEFAULT_VIDEO_MODEL) : "image" });
    onProgress?.("submitted");

    const want = scene.variants ?? 1;
    const deadline = Date.now() + (video ? 600_000 : 240_000);
    while (fresh.size < want && Date.now() < deadline) {
      await page.waitForTimeout(1500);
      // New tiles are added above everything that was in the grid before Start (the old tiles keep their order).
      // A new tile counts once it holds a playable video; fresh is keyed by the tile's position from the top.
      const now = await tiles(page);
      const added = now.length - before.length;
      const isNew = added > 0 && now.slice(added).every((t, i) => t.label === before[i].label);
      // Flow marks a rejected generation with a "Failed" tile (for example its "unusual activity" check). Stop at once:
      // waiting longer or retrying would only repeat it, and the message is Flow's own.
      const rejected = isNew ? now.slice(0, added).find((t) => t.failed) : undefined;
      if (rejected) throw new FlowUiError(`Flow rejected the generation and nothing was delivered. Flow says: "${rejected.failed}"`);
      if (!video) continue;
      if (added >= want && isNew) {
        const ready = now.slice(0, added).flatMap((t, index) => (t.isVideo && t.src ? [{ index, url: videoUrl(t.src) }] : []));
        if (ready.length >= want) for (const r of ready.slice(0, want)) fresh.set(String(r.index), r.url);
      }
    }
    if (fresh.size < want) throw new FlowUiError(`Timed out: got ${fresh.size} of ${want} ${video ? "videos" : "images"}.`);
  } finally {
    page.off("response", onResponse);
  }

  mkdirSync(outDir, { recursive: true });
  const files: string[] = [];
  let n = 0;
  let quality = "";
  const logo: string[] = [];
  for (const [key, url] of fresh) {
    // Browser-context request: carries the signed-in cookies, no CORS (a page fetch is blocked cross-site).
    const res = await page.context().request.get(url);
    const ct = res.headers()["content-type"] ?? "";
    if (!res.ok() || (video && !ct.startsWith("video/"))) throw new FlowUiError(`Download failed (${res.status()} ${ct}) for a finished ${video ? "video" : "image"}.`);
    const file = join(outDir, `${stem}${fresh.size > 1 ? `-${++n}` : ""}.${video ? "mp4" : "jpeg"}`);
    writeFileSync(file, await res.body());
    // The direct file above is Flow's original size; replace it with the best (up to 1080p) upscale when Flow offers one.
    // The untouched original-size download is kept next to the file while the logo is removed (cleaned most exactly there).
    const srcFile = join(outDir, `.src-${basename(file)}`);
    if (video) {
      try {
        quality = await downloadBest(page, page.locator("[role=group]").nth(Number(key)), file, onProgress, srcFile);
      } catch (e) {
        await page.keyboard.press("Escape").catch(() => {});
        quality = `original size kept, upscale failed: ${(e as Error).message.split("\n")[0]}`;
      }
      onProgress?.(`quality: ${quality}`);
    }
    // Free (daily) credits stamp Flow's sparkle into the corner; take it out of the delivered file (original kept).
    onProgress?.("checking the file for a watermark (removed only if one is found; this can take a while on a slow PC)");
    const clean = video && existsSync(srcFile) ? await cleanLogoHybrid(file, srcFile) : await cleanLogo(file, video ? "video" : "image");
    rmSync(srcFile, { force: true });
    if (clean.status !== "none") logo.push(clean.note);
    // Veo models also stamp a small "Veo" text mark; it is detected from the clip itself, so it is only looked for on Veo output.
    if (video && /^Veo/.test(scene.model ?? "")) {
      const veo = await cleanVeoMark(file);
      if (veo.status !== "none") logo.push(veo.note);
    }
    files.push(file);
  }
  return { credits, files, quality: quality || undefined, logo: logo.length ? [...new Set(logo)].join("; ") : "no watermark found, nothing to remove" };
}

export const generateImage = (scene: ImageScene, outDir: string, stem: string, onProgress?: (s: string) => void) => generate(scene, outDir, stem, onProgress);

// What would this scene cost? Sets the options in Flow's settings panel and reads the quote, without typing a prompt or
// pressing Start, so nothing is submitted and nothing is spent.
export async function quote(scene: Scene): Promise<{ credits: number; short: boolean }> {
  const page = await getFlowPage();
  await ensureProject(page);
  checkImages(scene);
  await dismissOverlays(page);
  const credits = await applySettings(page, scene).catch(async (e) => {
    await dismissOverlays(page).catch(() => {});
    throw e;
  });
  const short = (await page.getByRole("button", { name: "Insufficient credits warning" }).count()) > 0;
  return { credits, short };
}

// Cheap state read for status calls: no clicking, no screenshots.
export async function ensureProjectOpen(): Promise<string> {
  try {
    const url = (await getFlowPage()).url();
    if (/accounts\.google\.com/.test(url)) return "not signed in: sign in in the Flow Chrome window";
    return /flow\.google\.com\/project\//.test(url) ? "ready" : "signed in, but no project open: open one in the Flow Chrome window";
  } catch (e) {
    return `Chrome not reachable: ${(e as Error).message.split("\n")[0]}`;
  }
}

// Non-spending health check: every UI action Flow must still offer.
// With fix=true, a broken action gets a suggested replacement (closest control on the live page, verified unique)
// saved to selectors.json. No model is involved, so it costs no Claude usage.
export async function doctor(fix = false, capture = false): Promise<string[]> {
  const page = await getFlowPage();
  const report: string[] = [];
  // --capture: save sanitized accessibility snapshots of each state as offline test fixtures (fixtures/aria/).
  const snap = async (state: string) => {
    if (!capture) return;
    const yml = await page.locator("body").ariaSnapshot().catch(() => "");
    if (yml) report.push(`saved fixture ${state}: ${saveFixture(state, `url: ${page.url()}
${yml}`)}`);
  };
  const check = async (action: string, vars: Record<string, string> = {}) => {
    try {
      await find(page, action, vars, 4000);
      report.push(`ok    ${action}`);
    } catch (e) {
      const c = fix ? await suggest(page, action, vars).catch(() => null) : null;
      if (c) {
        addCandidate(action, c);
        report.push(`FIXED ${action}: added fallback ${c.role} "${c.name}"`);
      } else report.push(`FAIL  ${action}: ${(e as Error).message}`);
    }
  };
  await ensureProject(page).then(() => report.push("ok    project open"), (e) => report.push(`FAIL  ${e.message}`));
  for (const a of ["prompt_box", "start", "settings_trigger"]) await check(a);
  await snap("project");
  try {
    await (await find(page, "settings_trigger")).click();
    for (const a of ["mode_image", "mode_video"]) await check(a);
    await check("ratio", { ratio: "16:9" });
    await check("count", { count: "1" });
    await check("credit_quote");
    await snap("settings-image");
    // Video-only controls appear after switching mode; put it back to image afterwards.
    await choose(await find(page, "mode_video"));
    await check("model_menu");
    await check("mode_frames");
    await check("mode_ingredients");
    await check("resolution", { resolution: "720p" });
    // Omni 1.2 Flash has a Length slider instead of 4/6/8/10 s buttons; only check the buttons when they exist.
    if (!(await durationSlider(page))) await check("duration", { duration: "8" });
    await snap("settings-video");
    if (capture) {
      // Open the model list only to read it (nothing is selected), then put the panel back as it was.
      await (await find(page, "model_menu")).click();
      await page.waitForTimeout(700);
      await snap("model-menu");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
      if (!(await tryFind(page, "mode_image", {}, 700))) await (await find(page, "settings_trigger")).click();
    }
    await choose(await find(page, "mode_image"));
    await page.keyboard.press("Escape");
  } catch {
    report.push("FAIL  could not open settings");
  }
  // Library menus (read-only: opens a tile's menu, reads it, closes it).
  try {
    await dismissOverlays(page);
    const tile = page.locator("[role=group]").filter({ has: page.getByRole("button", { name: "More options", exact: true }) }).first();
    if (!(await tile.count())) report.push("skip  library menu (no media in this project to check)");
    else {
      await tile.hover();
      await tile.getByRole("button", { name: "More options", exact: true }).click({ timeout: 5000 });
      await page.waitForTimeout(600);
      const items = await page.getByRole("menuitem").evaluateAll((els) => els.map((e) => (e as HTMLElement).innerText.replace(/\s+/g, " ").trim()));
      await page.keyboard.press("Escape");
      for (const [name, re] of [["rename", /Rename$/], ["trash", /Move to trash$/], ["cover", /Set project cover$/]] as const) {
        report.push(items.some((t) => re.test(t)) ? `ok    library menu: ${name}` : `FAIL  library menu: ${name} not found (menu has: ${items.join(", ")})`);
      }
    }
  } catch (e) {
    report.push(`FAIL  library menu: ${(e as Error).message.split("\n")[0]}`);
  }
  await dismissOverlays(page).catch(() => {});
  return report;
}
