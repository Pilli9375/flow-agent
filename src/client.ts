import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.FLOW_AGENT_PORT ?? 8788);
const BASE = `http://127.0.0.1:${PORT}`;
const HEADERS = { "x-flow-agent": "1", "content-type": "application/json" };

async function up(): Promise<boolean> {
  try {
    return (await fetch(`${BASE}/health`, { headers: HEADERS, signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
}

// Every front end (CLI, MCP in any Claude/Codex session) talks to the one worker; start it if it is not running.
export async function ensureWorker(): Promise<void> {
  if (await up()) return;
  spawn(process.execPath, [fileURLToPath(new URL("./daemon.js", import.meta.url))], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  for (let i = 0; i < 40; i++) {
    if (await up()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("The flow-agent worker did not start.");
}

export async function call<T = unknown>(path: string, body?: unknown): Promise<T> {
  await ensureWorker();
  const res = await fetch(`${BASE}${path}`, { method: body === undefined ? "GET" : "POST", headers: HEADERS, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok || data.error) throw new Error(data.error ?? `worker error ${res.status}`);
  return data;
}
