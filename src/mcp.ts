#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME_DIR } from "./chrome.js";
import { call } from "./client.js";
import { OUT_ROOT, previewSheet, stitch } from "./media.js";
import { cleanLogo } from "./logo.js";
import { cleanVeoMark } from "./veomark.js";
import { captions, exportPreset, mixAudio, speed, trim } from "./post.js";
import { spendReport } from "./ledger.js";

// Video-only mode (FLOW_AGENT_VIDEO_ONLY=1, set when registering the server in Codex): the client has its own image
// generator, so nothing image-related is ever sent to Flow from it. Claude Code keeps the full toolset.
const VIDEO_ONLY = process.env.FLOW_AGENT_VIDEO_ONLY === "1";
const NO_IMAGES = "Flow is video-only in this client. Make still images with this client's own built-in image generation (the ChatGPT image model), never with Flow. Nothing was sent to Flow.";
const server = new McpServer(
  { name: "flow-agent", version: "0.1.0" },
  VIDEO_ONLY ? { instructions: `${NO_IMAGES} Use the flow_* tools only for video (and for managing the video project: credits, quotes, stitching, previews, exports).` } : undefined,
);
const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
// Confirmation the model cannot skip: before anything that spends credits or moves media to the Trash, the tool server
// asks the USER through the client's own dialog (MCP elicitation). FLOW_AGENT_CONFIRM=auto (default) asks when the
// client supports it and otherwise relies on the model having asked in chat plus the worker's daily budget;
// "require" refuses when the client cannot ask; "off" never asks.
const CONFIRM_MODE = (process.env.FLOW_AGENT_CONFIRM ?? "auto").toLowerCase();
const INSTANT_MS = Number(process.env.FLOW_AGENT_INSTANT_DECLINE_MS ?? 150);
export async function userConfirms(message: string): Promise<{ ok: boolean; how: "asked" | "unsupported" | "off"; reason?: string }> {
  if (CONFIRM_MODE === "off") return { ok: true, how: "off" };
  if (!server.server.getClientCapabilities()?.elicitation) {
    return CONFIRM_MODE === "require"
      ? { ok: false, how: "unsupported", reason: "This client cannot show a confirmation dialog and FLOW_AGENT_CONFIRM=require is set, so nothing was done." }
      : { ok: true, how: "unsupported" };
  }
  const started = Date.now();
  const note = (what: string) => {
    try {
      mkdirSync(HOME_DIR, { recursive: true });
      appendFileSync(join(HOME_DIR, "elicit.log"), JSON.stringify({ at: new Date().toISOString(), client: server.server.getClientVersion()?.name, ms: Date.now() - started, what, message: message.slice(0, 120) }) + "\n");
    } catch {
      /* diagnostic only */
    }
  };
  try {
    const r = await server.server.elicitInput(
      { message, requestedSchema: { type: "object", properties: { approve: { type: "boolean", title: "Approve", description: "Tick to approve exactly what is described above" } }, required: ["approve"] } },
      { timeout: 10 * 60_000 },
    );
    note(`answer: ${r.action} ${JSON.stringify(r.content ?? {})}`);
    if (r.action === "accept" && r.content?.approve === true) return { ok: true, how: "asked" };
    // No person answers a dialog in a few milliseconds: Codex's desktop app declines elicitations instantly without
    // showing anything (seen live: 3 ms). Treat that as "this client cannot show the dialog", not as a refusal.
    if (r.action !== "accept" && Date.now() - started < INSTANT_MS) {
      return CONFIRM_MODE === "require"
        ? { ok: false, how: "unsupported", reason: "This client declined the confirmation dialog instantly without showing it, and FLOW_AGENT_CONFIRM=require is set, so nothing was done." }
        : { ok: true, how: "unsupported" };
    }
    return { ok: false, how: "asked", reason: "The user did not approve in the confirmation dialog, so nothing was done." };
  } catch (e) {
    note(`error: ${(e as Error).message.split("\n")[0]}`);
    return { ok: false, how: "asked", reason: `The confirmation dialog failed (${(e as Error).message.split("\n")[0]}), so nothing was done.` };
  }
}
const guard = async (fn: () => Promise<string>) => {
  try {
    return text(await fn());
  } catch (e) {
    return { ...text(`Error: ${(e as Error).message.split("\n")[0]}`), isError: true };
  }
};

server.tool("flow_status", "Is Google Flow ready (signed in, project open), what is queued, pacing, today's credit use and the daily self-check result.", {}, () =>
  guard(async () => {
    const s = await call<{ flow: string; queued: number; running: number; recent: string[]; pacing?: string; budget?: string; canary?: string }>("/status");
    return [`flow: ${s.flow}`, `queued ${s.queued}, running ${s.running}`, ...(s.pacing ? [`pacing: ${s.pacing}`] : []), ...(s.budget ? [`budget: ${s.budget}`] : []), ...(s.canary ? [s.canary] : []), ...s.recent].join("\n");
  }),
);

server.tool(
  "flow_generate",
  (VIDEO_ONLY ? "Queue Flow VIDEO generation (type must be 'video'; images are not made with Flow in this client). " : "Queue Flow generation. Images cost 0 credits. ") + `Videos SPEND credits (Omni 1.2 Flash 4s 720p ~12 or 4s 360p ~4; Omni 1.1 Flash 4s 720p ~7; Veo Lite ~10, Fast ~20, Quality ~100): set type=video AND max_credits, never without the user's OK for the spend. A scene is skipped if Flow quotes more than max_credits (default 0). Send all scenes in ONE call; returns job ids. Then call flow_jobs with action=wait.`,
  {
    project: z.string().describe("Output folder name, e.g. HotelPromo"),
    scenes: z
      .array(
        z.object({
          prompt: z.string().min(1).describe("Full English prompt: subject, shot, style, light"),
          type: z.enum(["image", "video"]).optional().describe("Default image"),
          aspect_ratio: z.enum(["16:9", "4:3", "1:1", "3:4", "9:16"]).optional().describe("Video: 16:9 or 9:16 only"),
          variants: z.number().int().min(1).max(4).optional().describe("Each variant spends credits for video"),
          model: z.enum(["Omni 1.2 Flash", "Omni 1.1 Flash", "Veo 3.1 - Lite", "Veo 3.1 - Fast", "Veo 3.1 - Quality"]).optional().describe("Video only. Default Omni 1.2 Flash. Omni 1.1 Flash and Veo 3.1 Fast/Quality leave Flow on Dec 5; if Flow no longer lists a model the job fails with the list of offered ones, nothing spent"),
          duration: z.number().int().min(3).max(15).optional().describe("Video seconds. Omni 1.1 Flash: 4, 6, 8 or 10. Omni 1.2 Flash: any whole 3 to 15. Veo is fixed 8s"),
          resolution: z.enum(["360p", "720p"]).optional().describe("Video, Omni only"),
          start_image: z.string().optional().describe("Video: absolute path of a png/jpg/webp used as the first frame"),
          end_image: z.string().optional().describe("Video: absolute path of the last frame; needs start_image"),
          reference_images: z.array(z.string()).max(3).optional().describe("Video: up to 3 absolute image paths as references (Flow Ingredients); not with start/end"),
          chain: z.boolean().optional().describe("Video: start from the last frame of the previous video scene in this project, for a continuous multi-scene film"),
          max_credits: z.number().int().min(0).optional().describe("Most credits you accept for this scene; required to spend any"),
        }),
      )
      .min(1)
      .max(50),
  },
  ({ project, scenes }) =>
    guard(async () => {
      if (VIDEO_ONLY && scenes.some((sc) => sc.type !== "video")) throw new Error(NO_IMAGES);
      const spend = scenes.filter((sc) => sc.type === "video" && (sc.max_credits ?? 0) > 0);
      if (spend.length) {
        const total = spend.reduce((a, sc) => a + (sc.max_credits ?? 0), 0);
        const c = await userConfirms(`Flow video generation in project "${project}": ${spend.length} scene(s), spending up to ${total} credits in total (${spend.map((sc) => `${sc.model ?? "Omni 1.2 Flash"} ${sc.duration ? sc.duration + "s " : ""}${sc.resolution ?? ""} x${sc.variants ?? 1}, up to ${sc.max_credits}`).join("; ")}). Approve?`);
        if (!c.ok) throw new Error(c.reason);
      }
      const r = await call<{ jobs: string[] }>("/generate", { project, scenes: scenes.map((s) => ({ ...s, max_credits: s.max_credits ?? 0 })) });
      return `queued: ${r.jobs.join(",")}`;
    }),
);

server.tool(
  "flow_jobs",
  "Follow the queued jobs. action=wait: wait up to ~35 s, one line per job (id | status | files); call again until finished is true. action=cancel: cancel one queued job by job_id (a running one finishes).",
  { action: z.enum(["wait", "cancel"]), job_ids: z.array(z.string()).optional().describe("wait: default all jobs"), job_id: z.string().optional().describe("cancel: the job to cancel") },
  ({ action, job_ids, job_id }) =>
    guard(async () => {
      if (action === "cancel") {
        if (!job_id) throw new Error("cancel needs job_id.");
        return (await call<{ result: string }>("/cancel", { id: job_id })).result;
      }
      const r = await call<{ finished: boolean; jobs: string[] }>(`/wait?t=35000${job_ids?.length ? `&ids=${job_ids.join(",")}` : ""}`);
      return `finished: ${r.finished}\n${r.jobs.join("\n")}`;
    }),
);

const ref = z.object({ n: z.number().int().min(1).describe("Number from the latest list"), title: z.string().describe("Its exact title, copied from the same list") });
const libCall = async (args: Record<string, unknown>) => (await call<{ text: string }>("/library", args)).text;

server.tool(
  "flow_library",
  "Manage the open Flow project's media (all refused while jobs run). action=list: media newest first (filters kind, query, favorites); use before anything else so numbers and titles are current. trash_list: what is in the Trash. trash: move items to the Trash (recoverable; NEVER permanent): call with items only to get a PREVIEW and a confirm code, show the user that exact list and get approval, then call again with the same items and confirm=<code> (max 25). restore: bring items back from the Trash (safe). rename (needs title) / favorite / unfavorite / cover: act on one item. Items are addressed by number AND exact title from the latest list. Permanent delete, empty-trash and project delete are not possible with this tool.",
  {
    action: z.enum(["list", "trash_list", "trash", "restore", "rename", "favorite", "unfavorite", "cover"]),
    kind: z.enum(["video", "image", "failed", "other"]).optional().describe("list filter"),
    query: z.string().optional().describe("list: only titles containing this text"),
    favorites: z.boolean().optional().describe("list: only favorites"),
    items: z.array(ref).min(1).max(25).optional().describe("trash / restore"),
    confirm: z.string().optional().describe("trash: the code from the preview, only after the user approved the list"),
    item: ref.optional().describe("rename / favorite / unfavorite / cover"),
    title: z.string().optional().describe("rename: the new title"),
  },
  (a) =>
    guard(async () => {
      switch (a.action) {
        case "list": return libCall({ op: "media", kind: a.kind, query: a.query, favorites: a.favorites });
        case "trash_list": return libCall({ op: "trash_list" });
        case "restore":
          if (!a.items) throw new Error("restore needs items.");
          return libCall({ op: "restore", items: a.items });
        case "trash": {
          if (!a.items) throw new Error("trash needs items.");
          if (a.confirm) {
            const c = await userConfirms(`Move ${a.items.length} item(s) to the Flow Trash (recoverable): ${a.items.map((i) => `#${i.n} ${i.title}`).join("; ")}. Approve?`);
            if (!c.ok) throw new Error(c.reason);
          }
          return libCall({ op: "trash", items: a.items, confirm: a.confirm });
        }
        default:
          if (!a.item) throw new Error(`${a.action} needs item.`);
          return libCall({ op: "edit", item: a.item, action: a.action, title: a.title });
      }
    }),
);

server.tool(
  "flow_edit",
  "Edit an existing image or video in the open project with a prompt (Flow's own editor). The result is saved as a new file (logo removed, best size) and the original is untouched. Images are free. A VIDEO EDIT SPENDS CREDITS: get the user's approval of the cost first and pass max_credits (an edit is skipped if Flow quotes more). Use number and title from flow_library action=list. Refused while jobs run.",
  { item: ref, prompt: z.string().min(1).describe("What to change, e.g. 'make the sky stormy'"), max_credits: z.number().int().min(0).optional().describe("Most credits the user approved; 0 (default) is right for images") },
  (a) => guard(async () => {
    if (VIDEO_ONLY) throw new Error(NO_IMAGES);
    if ((a.max_credits ?? 0) > 0) {
      const c = await userConfirms(`Flow edit of #${a.item.n} "${a.item.title}" ("${a.prompt.slice(0, 80)}"), spending up to ${a.max_credits} credits. Approve?`);
      if (!c.ok) throw new Error(c.reason);
    }
    return (await call<{ text: string }>("/edit", a)).text;
  }),
);

server.tool(
  "flow_quote",
  "Ask Flow what a video or image scene would cost WITHOUT submitting anything (no credits spent): returns the credit quote for the settings and whether the balance is short. Use it to give the user exact numbers before asking for approval. Refused while jobs run.",
  {
    type: z.enum(["image", "video"]).optional(),
    model: z.enum(["Omni 1.2 Flash", "Omni 1.1 Flash", "Veo 3.1 - Lite", "Veo 3.1 - Fast", "Veo 3.1 - Quality"]).optional(),
    duration: z.number().int().min(3).max(15).optional().describe("Omni 1.1 Flash: 4, 6, 8 or 10. Omni 1.2 Flash: any whole 3 to 15"),
    resolution: z.enum(["360p", "720p"]).optional(),
    aspect_ratio: z.enum(["16:9", "4:3", "1:1", "3:4", "9:16"]).optional(),
    variants: z.number().int().min(1).max(4).optional(),
  },
  (a) => guard(async () => {
    if (VIDEO_ONLY && a.type === "image") throw new Error(NO_IMAGES);
    const r = await call<{ credits: number; short: boolean }>("/quote", { scene: { prompt: "(quote only)", ...a, ...(VIDEO_ONLY ? { type: "video" } : {}) } });
    return `quote: ${r.credits} credits${r.short ? " (more than the current balance)" : ""}`;
  }),
);

server.tool(
  "flow_account",
  "what=credits: the user's current Google Flow credit balance and reset date (call before choosing a video model so the choice fits; refused while jobs run). what=spend: credits this toolkit has spent today against the daily budget (only if the user set one) and the latest spends (instant, no Flow access). Only the user can change the budget; if a job fails with 'Daily credit budget reached', tell the user and do not look for a way around it.",
  { what: z.enum(["credits", "spend"]) },
  ({ what }) =>
    guard(async () => {
      if (what === "spend") return spendReport();
      const r = await call<{ credits: number; resets?: string }>("/credits");
      return `credits: ${r.credits}${r.resets ? `, resets ${r.resets}` : ""}`;
    }),
);

server.tool(
  "flow_project",
  "Flow projects. action=list: the user's projects (title, last edited, id) and which is open now; always show these to the user and ask which to use, or a new one, before generating. action=open: open the one the user chose (project = full id or unique prefix from the list) or create a new one with project=\"new\"; refused while jobs run. action=rename: rename the open project (name).",
  { action: z.enum(["list", "open", "rename"]), project: z.string().optional().describe('open: project id or prefix, or "new"'), name: z.string().min(1).max(120).optional().describe("rename: the new name") },
  ({ action, project, name }) =>
    guard(async () => {
      if (action === "list") return (await call<{ projects: string[] }>("/projects")).projects.join("\n") || 'No projects yet. Use action=open with project="new".';
      if (action === "open") {
        if (!project) throw new Error("open needs project.");
        return `open project: ${(await call<{ project: string }>("/open-project", { project })).project}`;
      }
      if (!name) throw new Error("rename needs name.");
      return libCall({ op: "project_rename", name });
    }),
);

server.tool(
  "flow_files",
  "Work on finished local files (free, CPU only, never touches Flow or the source file; results go to a new file). action=preview: a small contact-sheet picture to check a result cheaply (file, frames). clean_logo: remove Flow's corner watermark (and Veo's text mark) from older files (files); generated files are already cleaned; originals are kept. stitch: join a project's clips into final.mp4 (project, optional clips, transition cut|fade, fade_seconds). export: re-frame/re-encode for a platform (file, preset reels|tiktok|shorts|youtube|square|small, fit crop|pad, focus 0..1 for which part a crop keeps). trim (file, start, end seconds). speed (file, factor 0.25 to 4). mix_audio (file, audio, volume, clip_volume, replace_audio). captions (file, srt, font_size): burn subtitles from an .srt file you wrote.",
  {
    action: z.enum(["preview", "clean_logo", "stitch", "export", "trim", "speed", "mix_audio", "captions"]),
    file: z.string().optional().describe("Absolute path of the file to work on"),
    files: z.array(z.string()).min(1).max(20).optional().describe("clean_logo: absolute paths"),
    frames: z.number().int().min(1).max(12).optional().describe("preview: frames for a video, default 6"),
    project: z.string().optional().describe("stitch: same project name used in flow_generate"),
    clips: z.array(z.string()).optional().describe("stitch: clip file names inside the project folder, in order; default all scene-*.mp4"),
    transition: z.enum(["cut", "fade"]).optional().describe("stitch"),
    fade_seconds: z.number().min(0.1).max(2).optional().describe("stitch crossfade length, default 0.4"),
    preset: z.enum(["reels", "tiktok", "shorts", "youtube", "square", "small"]).optional().describe("export"),
    fit: z.enum(["crop", "pad"]).optional().describe("export: crop fills the frame (default), pad keeps everything with black bars"),
    focus: z.number().min(0).max(1).optional().describe("export crop: 0 = keep left/top, 0.5 = centre (default), 1 = right/bottom"),
    start: z.number().min(0).optional().describe("trim: seconds"),
    end: z.number().min(0).optional().describe("trim: seconds"),
    factor: z.number().min(0.25).max(4).optional().describe("speed: 0.5 = half speed, 2 = double"),
    audio: z.string().optional().describe("mix_audio: absolute path of a music or voice-over file"),
    volume: z.number().min(0).max(2).optional().describe("mix_audio: added sound volume, default 0.4"),
    clip_volume: z.number().min(0).max(2).optional().describe("mix_audio: the clip's own sound volume, default 1"),
    replace_audio: z.boolean().optional().describe("mix_audio: use only the added sound"),
    srt: z.string().optional().describe("captions: absolute path of an .srt file"),
    font_size: z.number().int().min(10).max(72).optional().describe("captions"),
  },
  (a) =>
    guard(async () => {
      const f = () => {
        if (!a.file) throw new Error(`${a.action} needs file.`);
        return a.file;
      };
      switch (a.action) {
        case "preview": return previewSheet(f(), a.frames);
        case "clean_logo": {
          const files = a.files ?? (a.file ? [a.file] : []);
          if (!files.length) throw new Error("clean_logo needs files.");
          return (
            await Promise.all(
              files.map(async (p) => {
                const video = /\.(mp4|mov|webm)$/i.test(p);
                const notes = [(await cleanLogo(p, video ? "video" : "image")).note];
                if (video) {
                  const veo = await cleanVeoMark(p);
                  if (veo.status !== "none") notes.push(veo.note);
                }
                return `${p}: ${notes.join("; ")}`;
              }),
            )
          ).join("\n");
        }
        case "stitch":
          if (!a.project) throw new Error("stitch needs project.");
          return stitch(join(OUT_ROOT, a.project.replace(/[^\w-]+/g, "_").slice(0, 60) || "project"), { files: a.clips, transition: a.transition, fadeSeconds: a.fade_seconds });
        case "export":
          if (!a.preset) throw new Error("export needs preset.");
          return exportPreset(f(), a.preset, { fit: a.fit, focus: a.focus });
        case "trim": return trim(f(), a.start, a.end);
        case "speed":
          if (a.factor === undefined) throw new Error("speed needs factor.");
          return speed(f(), a.factor);
        case "mix_audio":
          if (!a.audio) throw new Error("mix_audio needs audio.");
          return mixAudio(f(), a.audio, { volume: a.volume, clipVolume: a.clip_volume, replace: a.replace_audio });
        case "captions":
          if (!a.srt) throw new Error("captions needs srt.");
          return captions(f(), a.srt, { fontSize: a.font_size });
      }
    }),
);

server.server.oninitialized = () => {
  // Record what this client can do (used to check elicitation support in Claude Code and Codex).
  try {
    mkdirSync(HOME_DIR, { recursive: true });
    writeFileSync(join(HOME_DIR, "client-capabilities.json"), JSON.stringify({ at: new Date().toISOString(), client: server.server.getClientVersion(), capabilities: server.server.getClientCapabilities() }, null, 2));
  } catch {
    /* diagnostic only */
  }
};
await server.connect(new StdioServerTransport());
