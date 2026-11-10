import { createServer, type IncomingMessage } from "node:http";
import { doctor, ensureProjectOpen, quote } from "./flow.js";
import { canaryDue, canaryEnabled, canaryLine, saveCanary, summarize } from "./canary.js";
import { guardStatus } from "./guard.js";
import { dailyBudget, spentToday } from "./ledger.js";
import { Queue, type Job } from "./queue.js";
import { listProjects, openProject } from "./projects.js";
import { readCredits } from "./account.js";
import { editItem } from "./edit.js";
import { editMedia, listMedia, listTrash, renameProject, restoreMedia, trashMedia } from "./library.js";

export const PORT = Number(process.env.FLOW_AGENT_PORT ?? 8788);
const queue = new Queue();

const line = (j: Job) =>
  [j.id, j.status, j.progress && j.status === "running" ? j.progress : "", j.files.join(","), j.quality ? `quality: ${j.quality}` : "", j.status === "done" && j.logo ? `logo: ${j.logo}` : "", j.error ?? ""].filter(Boolean).join(" | ");

const body = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
};

// Local-only worker: loopback bind, Host check, and a custom header a web page cannot send cross-site.
const server = createServer(async (req, res) => {
  const send = (code: number, data: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  };
  try {
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host ?? "") || req.headers["x-flow-agent"] !== "1") return send(403, { error: "forbidden" });
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/health") return send(200, { ok: true });
    if (url.pathname === "/status") {
      const jobs = queue.get();
      return send(200, { flow: await ensureProjectOpen(), queued: jobs.filter((j) => j.status === "queued").length, running: jobs.filter((j) => j.status === "running").length, recent: jobs.slice(-5).map(line), pacing: guardStatus(), budget: dailyBudget() > 0 ? `${spentToday()} of ${dailyBudget()} credits used today` : `${spentToday()} credits used today (no daily limit set)`, canary: canaryLine() });
    }
    if (url.pathname === "/quote" && req.method === "POST") {
      if (queue.get().some((j) => j.status === "queued" || j.status === "running")) return send(409, { error: "Jobs are queued or running; ask for a quote after they finish." });
      return send(200, await quote((await body(req)).scene));
    }
    if (url.pathname === "/edit" && req.method === "POST") {
      if (queue.get().some((j) => j.status === "queued" || j.status === "running")) return send(409, { error: "Jobs are queued or running; edit after they finish." });
      const a = await body(req);
      // A video edit can take many minutes. Send the headers now and a blank every 15 s (JSON allows leading
      // whitespace) so the client's fetch does not time out at 5 minutes; the result or {error} follows at the end.
      res.writeHead(200, { "content-type": "application/json" });
      const beat = setInterval(() => res.write(" "), 15_000);
      try {
        res.end(JSON.stringify({ text: await editItem(a.item, a.prompt, a.max_credits ?? 0) }));
      } catch (e) {
        res.end(JSON.stringify({ error: (e as Error).message }));
      } finally {
        clearInterval(beat);
      }
      return;
    }
    if (url.pathname === "/library" && req.method === "POST") {
      if (queue.get().some((j) => j.status === "queued" || j.status === "running")) return send(409, { error: "Jobs are queued or running; use the library after they finish." });
      const a = await body(req);
      const text =
        a.op === "media" ? await listMedia(a)
        : a.op === "trash_list" ? await listTrash()
        : a.op === "trash" ? await trashMedia(a.items, a.confirm)
        : a.op === "restore" ? await restoreMedia(a.items)
        : a.op === "edit" ? await editMedia(a.item, a.action, a.title)
        : a.op === "project_rename" ? await renameProject(a.name)
        : null;
      if (text === null) return send(400, { error: `unknown library op ${a.op}` });
      return send(200, { text });
    }
    if (url.pathname === "/credits") {
      if (queue.get().some((j) => j.status === "queued" || j.status === "running")) return send(409, { error: "Jobs are queued or running; read the balance after they finish." });
      return send(200, await readCredits());
    }
    if (url.pathname === "/projects") {
      const r = await listProjects();
      return send(200, { current: r.current, projects: r.projects.map((p, i) => `${i + 1}. ${p.title || "(untitled)"} | edited ${p.edited || "?"} | id ${p.id}${p.id === r.current ? " | OPEN NOW" : ""}`) });
    }
    if (url.pathname === "/open-project" && req.method === "POST") {
      if (queue.get().some((j) => j.status === "queued" || j.status === "running")) return send(409, { error: "Jobs are queued or running; switch projects after they finish." });
      return send(200, { project: await openProject((await body(req)).project) });
    }
    if (url.pathname === "/generate" && req.method === "POST") {
      const { project, scenes } = await body(req);
      return send(200, { jobs: queue.add(project, scenes).map((j) => j.id) });
    }
    if (url.pathname === "/wait") {
      const ids = url.searchParams.get("ids")?.split(",").filter(Boolean);
      const r = await queue.wait(ids, Math.min(Number(url.searchParams.get("t") ?? 35000), 40000));
      return send(200, { finished: r.finished, jobs: r.jobs.map(line) });
    }
    if (url.pathname === "/cancel" && req.method === "POST") return send(200, { result: queue.cancel((await body(req)).id) });
    send(404, { error: "not found" });
  } catch (e) {
    send(500, { error: (e as Error).message });
  }
});

server.listen(PORT, "127.0.0.1");

// Daily canary: only when nothing is queued or running and Chrome is already open on a Flow project. Never spends credits.
let canaryRunning = false;
async function canaryTick(): Promise<void> {
  if (!canaryEnabled() || canaryRunning || !canaryDue()) return;
  if (queue.get().some((j) => j.status === "queued" || j.status === "running")) return;
  canaryRunning = true;
  try {
    if ((await ensureProjectOpen()) !== "ready") return;
    saveCanary(summarize(await doctor(false)));
  } catch {
    /* try again at the next tick */
  } finally {
    canaryRunning = false;
  }
}
if (canaryEnabled()) {
  setTimeout(() => void canaryTick(), 60_000);
  setInterval(() => void canaryTick(), 30 * 60_000).unref();
}
