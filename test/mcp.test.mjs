import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MCP = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "mcp.js");

// Talks to the tool server over stdio like a real client. The worker is never reached: these calls are refused first.
async function session(env) {
  const p = spawn(process.execPath, [MCP], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "ignore"] });
  const waiting = new Map();
  let buf = "";
  p.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        const m = JSON.parse(line);
        waiting.get(m.id)?.(m);
      } catch {
        /* not a JSON line */
      }
    }
  });
  let id = 0;
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const n = ++id;
    const t = setTimeout(() => reject(new Error(`no answer to ${method}`)), 8000);
    waiting.set(n, (m) => { clearTimeout(t); resolve(m); });
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
  });
  const init = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  return { rpc, init, close: () => p.kill() };
}

test("full mode lists the whole toolset", async () => {
  const s = await session({ FLOW_AGENT_VIDEO_ONLY: "" });
  const names = (await s.rpc("tools/list", {})).result.tools.map((t) => t.name);
  s.close();
  for (const n of ["flow_generate", "flow_edit", "flow_quote", "flow_library", "flow_files", "flow_account", "flow_project", "flow_jobs", "flow_status"]) assert.ok(names.includes(n), n);
});

test("video-only mode: instructions say images stay with the client, and image requests are refused", async () => {
  const s = await session({ FLOW_AGENT_VIDEO_ONLY: "1" });
  assert.match(s.init.result.instructions ?? "", /video-only/i);
  assert.match(s.init.result.instructions ?? "", /built-in image generation/i);
  for (const scenes of [[{ prompt: "a cat" }], [{ prompt: "a cat", type: "image" }], [{ prompt: "a", type: "video" }, { prompt: "b", type: "image" }]]) {
    const r = (await s.rpc("tools/call", { name: "flow_generate", arguments: { project: "T", scenes } })).result;
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /video-only/i);
    assert.match(r.content[0].text, /Nothing was sent to Flow/);
  }
  const edit = (await s.rpc("tools/call", { name: "flow_edit", arguments: { item: { n: 1, title: "x" }, prompt: "make it blue" } })).result;
  assert.equal(edit.isError, true);
  assert.match(edit.content[0].text, /video-only/i);
  const q = (await s.rpc("tools/call", { name: "flow_quote", arguments: { type: "image" } })).result;
  assert.equal(q.isError, true);
  s.close();
});

test("the toolset is merged into a small set of tools", async () => {
  const s = await session({ FLOW_AGENT_VIDEO_ONLY: "" });
  const names = (await s.rpc("tools/list", {})).result.tools.map((t) => t.name).sort();
  s.close();
  assert.deepEqual(names, ["flow_account", "flow_edit", "flow_files", "flow_generate", "flow_jobs", "flow_library", "flow_project", "flow_quote", "flow_status"]);
});

test("merged tools refuse a missing argument before doing anything", async () => {
  const s = await session({ FLOW_AGENT_VIDEO_ONLY: "" });
  const a = (await s.rpc("tools/call", { name: "flow_library", arguments: { action: "trash" } })).result;
  const b = (await s.rpc("tools/call", { name: "flow_files", arguments: { action: "export", file: "x.mp4" } })).result;
  const c = (await s.rpc("tools/call", { name: "flow_project", arguments: { action: "open" } })).result;
  s.close();
  for (const r of [a, b, c]) assert.equal(r.isError, true);
  assert.match(a.content[0].text, /trash needs items/);
  assert.match(b.content[0].text, /export needs preset/);
  assert.match(c.content[0].text, /open needs project/);
});
