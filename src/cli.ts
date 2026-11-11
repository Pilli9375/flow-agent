#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { call } from "./client.js";
import { join, resolve } from "node:path";
import { HOME_DIR, getFlowPage, launchChrome } from "./chrome.js";
import { homedir } from "node:os";
import { doctor, generate, generateImage } from "./flow.js";
import { OUT_ROOT, previewSheet, stitch } from "./media.js";
import { cleanLogo } from "./logo.js";
import { cleanVeoMark } from "./veomark.js";
import { captions, exportPreset, mixAudio, speed, trim } from "./post.js";
import { checkFixtures } from "./offline.js";
import { codeFor, listProjects, moveToTrash, pick, render } from "./cleanup.js";
import { dailyBudget, setDailyBudget, spendReport } from "./ledger.js";

const [cmd, ...rest] = process.argv.slice(2);

async function login(): Promise<void> {
  await launchChrome();
  console.log("Chrome opened on Flow with its own profile. Sign in to Google by hand, open a project, then close nothing.");
}

// Phase-1 spike: log every non-static network response the Flow page makes, so we can see
// which endpoints carry generation status and media URLs. Submit one image by hand meanwhile.
async function spike(seconds: number): Promise<void> {
  const page = await getFlowPage();
  mkdirSync(join(HOME_DIR, "spike"), { recursive: true });
  const file = join(HOME_DIR, "spike", `net-${Date.now()}.jsonl`);
  page.on("response", (res) => {
    const req = res.request();
    const type = req.resourceType();
    if (!["xhr", "fetch", "media", "image"].includes(type)) return;
    const u = new URL(res.url());
    appendFileSync(
      file,
      JSON.stringify({ t: Date.now(), method: req.method(), status: res.status(), type, host: u.host, path: u.pathname, ct: res.headers()["content-type"] }) + "\n",
    );
  });
  console.log(`Recording to ${file} for ${seconds}s. Generate ONE 0-credit image in the Flow window now.`);
  await new Promise((r) => setTimeout(r, seconds * 1000));
  console.log("Done:", file);
  process.exit(0);
}

// Read-only: save the page's accessibility snapshot. Also the input for the later repair loop.
async function snapshot(openButton?: string): Promise<void> {
  const page = await getFlowPage();
  if (openButton) {
    await page.getByRole("button", { name: new RegExp(openButton) }).first().click();
    await page.waitForTimeout(800);
  }
  mkdirSync(join(HOME_DIR, "diag"), { recursive: true });
  const file = join(HOME_DIR, "diag", "snapshot.yml");
  const yml = await page.locator("body").ariaSnapshot();
  writeFileSync(file, `url: ${page.url()}\n${yml}`);
  console.log(`${file} (${yml.length} chars)`);
  if (openButton) await page.keyboard.press("Escape");
  process.exit(0);
}

// Zero-token path: queue a whole scene file through the shared worker.
async function viaWorker(): Promise<void> {
  try {
    await viaWorkerRaw();
  } catch (e) {
    console.error(`Error: ${(e as Error).message.split("\n")[0]}`);
    process.exitCode = 1;
  }
}

async function viaWorkerRaw(): Promise<void> {
  if (cmd === "status") {
    const s = await call<{ flow: string; queued: number; running: number; recent: string[] }>("/status");
    console.log([`flow: ${s.flow}`, `queued ${s.queued}, running ${s.running}`, ...s.recent].join("\n"));
  } else if (cmd === "gen") {
    // flow-agent gen <project> <scenes.json>   (scenes.json: [{"prompt": "...", "aspect_ratio": "16:9"}])
    const [project, file] = rest;
    const scenes = (JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) as object[]).map((s: { max_credits?: number }) => ({ ...s, max_credits: s.max_credits ?? 0 }));
    console.log("queued:", (await call<{ jobs: string[] }>("/generate", { project, scenes })).jobs.join(","));
  } else if (cmd === "wait") {
    for (;;) {
      const r = await call<{ finished: boolean; jobs: string[] }>(`/wait?t=35000${rest[0] ? `&ids=${rest[0]}` : ""}`);
      console.log(r.jobs.join("\n"));
      if (r.finished) break;
    }
  } else if (cmd === "lib") {
    // flow-agent lib <op> '<json args>'   e.g. lib media '{"kind":"image"}'  (dev/testing front end of the library tools)
    const r = await call<{ text: string }>("/library", { op: rest[0], ...(rest[1] ? JSON.parse(rest[1]) : {}) });
    console.log(r.text);
  } else if (cmd === "edit") {
    // flow-agent edit '{"item":{"n":1,"title":"..."},"prompt":"make it stormy","max_credits":0}'
    console.log((await call<{ text: string }>("/edit", JSON.parse(rest[0]))).text);
  } else if (cmd === "quote") {
    // flow-agent quote '{"type":"video","model":"Omni 1.1 Flash","duration":4,"resolution":"720p"}'  (no credits spent)
    const r = await call<{ credits: number; short: boolean }>("/quote", { scene: { prompt: "(quote only)", ...(rest[0] ? JSON.parse(rest[0]) : {}) } });
    console.log(`quote: ${r.credits} credits${r.short ? " (more than the current balance)" : ""}`);
  } else if (cmd === "credits") {
    const r = await call<{ credits: number; resets?: string }>("/credits");
    console.log(`credits: ${r.credits}${r.resets ? `, resets ${r.resets}` : ""}`);
  } else if (cmd === "upload") {
    // flow-agent upload <file-or-folder>... [--recursive]   (free: puts local images into the open Flow project's Uploads)
    const paths = rest.filter((a) => !a.startsWith("--")).map((p) => resolve(p));
    const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();
    const files = paths.filter((p) => !isDir(p)), folders = paths.filter(isDir);
    if (folders.length > 1) throw new Error("Give at most one folder.");
    console.log((await call<{ text: string }>("/upload", { files, folder: folders[0], recursive: rest.includes("--recursive") })).text);
  } else if (cmd === "projects") {
    console.log((await call<{ projects: string[] }>("/projects")).projects.join("\n"));
  } else if (cmd === "open-project") {
    console.log("open project:", (await call<{ project: string }>("/open-project", { project: rest[0] })).project);
  } else if (cmd === "cancel") {
    console.log((await call<{ result: string }>("/cancel", { id: rest[0] })).result);
  }
}

switch (cmd) {
  case "status":
  case "gen":
  case "wait":
  case "cancel":
  case "projects":
  case "lib":
  case "edit":
  case "quote":
  case "credits":
  case "open-project":
  case "upload":
    await viaWorker();
    break;
  case "daemon":
    await import("./daemon.js");
    break;
  case "gen-video": {
    // flow-agent gen-video "<prompt>" --max 7 [--model "Omni 1.1 Flash"] [--duration 4] [--res 360p] [--start img] [--end img] [--ref a.png,b.png]  (direct, spends credits up to --max)
    const flag = (n: string) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };
    const max = Number(flag("max"));
    if (!Number.isFinite(max)) throw new Error("gen-video needs --max <credits> (the most you accept spending).");
    const scene = { type: "video" as const, prompt: rest[0], max_credits: max, model: flag("model") as never, duration: flag("duration") ? (Number(flag("duration")) as never) : undefined, resolution: flag("res") as never, start_image: flag("start"), end_image: flag("end"), reference_images: flag("ref")?.split(",") };
    const r = await generate(scene, join(homedir(), "flow-agent-out", "cli"), `vid-${Date.now()}`, console.log);
    console.log(JSON.stringify(r));
    process.exit(0);
    break;
  }
  case "gen-image": {
    const out = join(homedir(), "flow-agent-out", "cli");
    const r = await generateImage({ prompt: rest.join(" "), max_credits: 0 }, out, `img-${Date.now()}`, console.log);
    console.log(JSON.stringify(r));
    process.exit(0);
    break;
  }
  case "clean-logo": {
    // flow-agent clean-logo <file...>  -> removes Flow's corner sparkle in place (original kept in originals/)
    for (const f of rest) {
      const video = /\.(mp4|mov|webm)$/i.test(f);
      console.log(f, "->", (await cleanLogo(f, video ? "video" : "image")).note);
      if (video) console.log(f, "-> Veo mark:", (await cleanVeoMark(f)).note);
    }
    process.exit(0);
    break;
  }
  case "stitch": {
    // flow-agent stitch <project> [clip.mp4 ...]  -> <out>/<project>/final.mp4 (no credits)
    // add --fade to crossfade between clips
    const fade = rest.includes("--fade");
    console.log(await stitch(join(OUT_ROOT, rest[0]), { files: rest.slice(1).filter((a) => a !== "--fade"), transition: fade ? "fade" : "cut" }));
    process.exit(0);
    break;
  }
  case "preview": {
    // flow-agent preview <file> [frames]  -> a small contact-sheet image (previews/ next to the file)
    console.log(await previewSheet(rest[0], rest[1] ? Number(rest[1]) : undefined));
    process.exit(0);
    break;
  }
  case "doctor": {
    if (rest.includes("--offline")) {
      // No Chrome: check selectors.json against the saved page snapshots in fixtures/aria/.
      const r = checkFixtures();
      const out = [...r.verdicts.map((v) => (v.ok ? "ok   " : "FAIL ") + `[${v.state}] ${v.action}: ${v.note}`), ...r.skipped.map((x) => `skip  ${x} (no fixture)`)];
      console.log(out.join("\n"));
      process.exit(r.verdicts.some((v) => !v.ok) ? 1 : 0);
    }
    const lines = await doctor(rest.includes("--fix"), rest.includes("--capture"));
    console.log(lines.join("\n"));
    process.exit(lines.some((l) => l.startsWith("FAIL")) ? 1 : 0);
    break;
  }
  case "cleanup": {
    // flow-agent cleanup                      list output folders with sizes
    // flow-agent cleanup --older 14 | <name...>   preview what would move (nothing moves yet) and print a code
    // flow-agent cleanup <same selection> --confirm <code>   move them to ~/flow-agent-out/.trash/<date>/ (never erased)
    const ci = rest.indexOf("--confirm"), oi = rest.indexOf("--older");
    const olderDays = oi >= 0 ? Number(rest[oi + 1]) : undefined;
    if (olderDays !== undefined && !(olderDays >= 0)) throw new Error("--older needs a number of days.");
    const names = rest.filter((a, i) => !a.startsWith("--") && i !== ci + 1 && i !== oi + 1);
    const all = listProjects(OUT_ROOT);
    if (!names.length && olderDays === undefined) {
      console.log(render(all));
      console.log("Pick folders by name, or use --older <days>, to preview a cleanup.");
    } else {
      const { chosen, unknown } = pick(all, { names, olderDays });
      if (unknown.length) throw new Error(`No such output folder: ${unknown.join(", ")}`);
      if (!chosen.length) console.log("Nothing matches.");
      else if (ci < 0) {
        console.log(render(all, chosen));
        console.log(`Preview only, nothing moved. To move the [x] folders into ${OUT_ROOT}/.trash (they can be moved back), run again with: --confirm ${codeFor(chosen)}`);
      } else if (rest[ci + 1] !== codeFor(chosen)) throw new Error("That confirm code does not match this selection. Run the preview again.");
      else console.log(`Moved ${chosen.length} folder(s) to ${moveToTrash(OUT_ROOT, chosen)}`);
    }
    break;
  }
  case "export":
  case "trim":
  case "speed":
  case "mix":
  case "captions": {
    // Free local post-production (new files in an exports/ folder next to the source):
    //   export <file> <reels|tiktok|shorts|youtube|square|small> [--pad] [--focus 0..1]
    //   trim <file> <start> [end]      speed <file> <factor>      mix <file> <audio> [--volume 0.4] [--replace]      captions <file> <subs.srt>
    const flag = (n: string) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };
    const [file, a1, a2] = rest;
    const r =
      cmd === "export" ? await exportPreset(file, a1 as never, { fit: rest.includes("--pad") ? "pad" : "crop", focus: flag("focus") ? Number(flag("focus")) : undefined })
      : cmd === "trim" ? await trim(file, Number(a1 ?? 0), a2 !== undefined ? Number(a2) : undefined)
      : cmd === "speed" ? await speed(file, Number(a1))
      : cmd === "mix" ? await mixAudio(file, a1, { volume: flag("volume") ? Number(flag("volume")) : undefined, replace: rest.includes("--replace") })
      : await captions(file, a1);
    console.log(r);
    process.exitCode = 0;
    break;
  }
  case "spend":
    // flow-agent spend  -> today's credits against the daily budget, plus recent spends
    console.log(spendReport());
    process.exitCode = 0;
    break;
  case "budget":
    // flow-agent budget [<credits>]  -> show or set the daily credit budget (only the user does this)
    if (rest[0] !== undefined) setDailyBudget(Number(rest[0]));
    console.log(dailyBudget() > 0 ? `daily credit budget: ${dailyBudget()}` : "daily credit budget: none (no limit). Set one with: budget <credits>");
    break;
  case "snapshot":
    await snapshot(rest[0]);
    break;
  case "login":
    await login();
    break;
  case "spike":
    await spike(Number(rest[0] ?? 90));
    break;
  default:
    console.log("usage: flow-agent <login|spike [seconds]>");
}
