import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MCP = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "mcp.js");

// A client that can answer elicitation requests. The worker is never reached: a declined confirmation stops first.
async function session(env, capabilities, answer, delay = 400) {
  const home = mkdtempSync(join(tmpdir(), "fa-conf-"));
  const p = spawn(process.execPath, [MCP], { env: { ...process.env, FLOW_AGENT_HOME: home, FLOW_AGENT_PORT: "1", ...env }, stdio: ["pipe", "pipe", "ignore"] });
  const waiting = new Map();
  const asked = [];
  let buf = "";
  p.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        const m = JSON.parse(line);
        if (m.method === "elicitation/create") {
          asked.push(m.params.message);
          setTimeout(() => p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: answer }) + "\n"), delay);
        } else waiting.get(m.id)?.(m);
      } catch {
        /* not JSON */
      }
    }
  });
  let id = 0;
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const n = ++id;
    const t = setTimeout(() => reject(new Error(`no answer to ${method}`)), 10000);
    waiting.set(n, (m) => { clearTimeout(t); resolve(m); });
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
  });
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities, clientInfo: { name: "test", version: "1" } });
  p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const tool = async (name, args) => (await rpc("tools/call", { name, arguments: args })).result;
  return { tool, asked, close: () => p.kill() };
}

const video = { project: "T", scenes: [{ prompt: "x", type: "video", model: "Omni 1.2 Flash", duration: 4, resolution: "720p", max_credits: 12 }] };

test("a declined spend dialog stops a video before the worker is even contacted", async () => {
  const s = await session({}, { elicitation: {} }, { action: "decline" });
  const r = await s.tool("flow_generate", video);
  s.close();
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /did not approve/);
  assert.match(s.asked[0], /up to 12 credits/);
});

test("a declined Trash confirmation stops the move", async () => {
  const s = await session({}, { elicitation: {} }, { action: "accept", content: { approve: false } });
  const r = await s.tool("flow_library", { action: "trash", items: [{ n: 1, title: "scene" }], confirm: "abc" });
  s.close();
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /did not approve/);
  assert.match(s.asked[0], /Trash/);
});

test("require mode refuses when the client cannot show a dialog", async () => {
  const s = await session({ FLOW_AGENT_CONFIRM: "require" }, {}, {});
  const r = await s.tool("flow_generate", video);
  s.close();
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /cannot show a confirmation dialog/);
});


test("an instant decline (a client that cannot show the dialog) counts as unsupported, not as a refusal", async () => {
  // Fast decline + require mode: refused with the explanatory message. The worker is never reached.
  const s = await session({ FLOW_AGENT_CONFIRM: "require" }, { elicitation: {} }, { action: "decline" }, 0);
  const r = await s.tool("flow_generate", video);
  s.close();
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /declined the confirmation dialog instantly/);
});
