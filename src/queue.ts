import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME_DIR } from "./chrome.js";
import { generate, type Scene } from "./flow.js";
import { recordRejection, recordSubmission, recordSuccess, submissionBlocked } from "./guard.js";
import { OUT_ROOT, lastFrame } from "./media.js";

const PAUSE_MIN_S = Number(process.env.FLOW_AGENT_PAUSE_MIN_S ?? 25);
const PAUSE_MAX_S = Number(process.env.FLOW_AGENT_PAUSE_MAX_S ?? 70);

export type Job = {
  id: string;
  project: string;
  scene: Scene;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  files: string[];
  credits?: number;
  quality?: string;
  logo?: string;
  progress?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
};

// The queue is saved after every change so history survives a worker restart. Anything that had not finished is marked
// failed on load and is NOT resubmitted: a restart must never spend credits that were approved for an earlier moment.
const QUEUE_FILE = join(HOME_DIR, "queue.json");
const KEEP_JOBS = 200;
function loadJobs(): Map<string, Job> {
  const jobs = new Map<string, Job>();
  try {
    if (existsSync(QUEUE_FILE)) {
      for (const j of JSON.parse(readFileSync(QUEUE_FILE, "utf8")) as Job[]) {
        if (j.status === "queued" || j.status === "running") {
          j.status = "failed";
          j.error = "Interrupted: the worker restarted before this finished, so it was not resubmitted. Check Flow before retrying.";
        }
        jobs.set(j.id, j);
      }
    }
  } catch {
    /* an unreadable file just means no history */
  }
  return jobs;
}

const finished = (j: Job) => j.status === "done" || j.status === "failed" || j.status === "cancelled";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const safe = (s: string) => s.replace(/[^\w-]+/g, "_").slice(0, 60) || "project";

function nextStem(dir: string): string {
  // Highest existing scene number + 1 (variants add -1/-2 suffixes, chained scenes leave helper frames).
  const n = existsSync(dir) ? Math.max(0, ...readdirSync(dir).map((f) => Number(/^scene-(\d+)/.exec(f)?.[1] ?? 0))) : 0;
  return `scene-${String(n + 1).padStart(2, "0")}`;
}

// One job at a time with human-like pauses between jobs. In memory: owned by the single worker process.
// Next to every delivered file: the prompt and settings that made it, so a result can be reproduced or tweaked later.
function writeSidecars(job: Job): void {
  for (const f of job.files) {
    try {
      writeFileSync(
        `${f}.json`,
        JSON.stringify({ created: new Date().toISOString(), project: job.project, job: job.id, credits: job.credits ?? 0, quality: job.quality, logo: job.logo, scene: job.scene }, null, 2),
      );
    } catch {
      /* the sidecar is a convenience */
    }
  }
}

export class Queue {
  private jobs = loadJobs();
  private pumping = false;

  private save(): void {
    try {
      mkdirSync(HOME_DIR, { recursive: true });
      const all = [...this.jobs.values()].slice(-KEEP_JOBS);
      const tmp = `${QUEUE_FILE}.tmp`;
      writeFileSync(tmp, JSON.stringify(all));
      renameSync(tmp, QUEUE_FILE);
    } catch {
      /* history is best effort */
    }
  }

  add(project: string, scenes: Scene[]): Job[] {
    const jobs = scenes.map((scene): Job => ({ id: randomBytes(4).toString("hex"), project: safe(project), scene, status: "queued", files: [] }));
    for (const j of jobs) this.jobs.set(j.id, j);
    this.save();
    void this.pump();
    return jobs;
  }

  get(ids?: string[]): Job[] {
    const all = [...this.jobs.values()];
    return ids?.length ? all.filter((j) => ids.includes(j.id)) : all;
  }

  cancel(id: string): string {
    const j = this.jobs.get(id);
    if (!j) return "unknown job";
    if (j.status === "queued") {
      j.status = "cancelled";
      this.save();
      return "cancelled";
    }
    return j.status === "running" ? "already running; it will finish (nothing more is queued from it)" : `already ${j.status}`;
  }

  async wait(ids: string[] | undefined, timeoutMs: number): Promise<{ finished: boolean; jobs: Job[] }> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const jobs = this.get(ids);
      const active = jobs.filter((j) => !finished(j));
      if (!active.length || Date.now() >= end) return { finished: !active.length, jobs };
      await sleep(500);
    }
  }

  // A chained scene starts from the last frame of the video queued just before it in the same project.
  private async withChain(job: Job, dir: string, stem: string): Promise<Scene> {
    const s = job.scene;
    if (s.type !== "video" || !s.chain) return s;
    if (s.start_image || s.reference_images?.length) throw new Error("chain cannot be combined with start_image or reference_images.");
    const all = [...this.jobs.values()].filter((j) => j.project === job.project);
    const prev = all[all.indexOf(job) - 1];
    if (!prev || prev.scene.type !== "video") throw new Error("chain needs a video scene before it in the same project.");
    if (prev.status !== "done" || !prev.files[0]) throw new Error("Chain broken: the previous scene did not finish, so nothing was spent on this one.");
    return { ...s, start_image: await lastFrame(prev.files[0], join(dir, `chain-${stem.slice(6)}.png`)) };
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (let ran = 0; ; ran++) {
        const job = [...this.jobs.values()].find((j) => j.status === "queued");
        if (!job) return;
        if (ran > 0) await sleep((PAUSE_MIN_S + Math.random() * (PAUSE_MAX_S - PAUSE_MIN_S)) * 1000);
        if (job.status !== "queued") continue; // cancelled during the pause
        // Pacing guard: a cooldown or the hourly cap fails the job at once, before anything is submitted.
        const blocked = submissionBlocked();
        if (blocked) {
          job.status = "failed";
          job.error = blocked;
          job.finishedAt = Date.now();
          this.save();
          continue;
        }
        job.status = "running";
        job.startedAt = Date.now();
        this.save();
        try {
          const dir = join(OUT_ROOT, job.project);
          const stem = nextStem(dir);
          recordSubmission();
          const r = await generate(await this.withChain(job, dir, stem), dir, stem, (s) => (job.progress = s));
          job.files = r.files;
          job.credits = r.credits;
          job.quality = r.quality;
          job.logo = r.logo;
          job.status = "done";
          recordSuccess();
          writeSidecars(job);
        } catch (e) {
          job.status = "failed";
          job.error = (e as Error).message.split("\n").filter((l) => l.trim()).slice(0, 3).join(" ").slice(0, 400);
          if (/Flow rejected the generation/i.test(job.error)) {
            const until = recordRejection();
            job.error += ` Pausing submissions until ${new Date(until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`;
          }
        }
        job.finishedAt = Date.now();
        this.save();
      }
    } finally {
      this.pumping = false;
    }
  }
}
