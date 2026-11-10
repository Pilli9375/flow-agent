#!/usr/bin/env node
// One-command setup for flow-agent: builds it, registers the MCP server in Claude Code (full toolset) and in Codex
// (video-only: Codex keeps its own image generation), and installs the skill / instructions for each.
//
//   npm run setup                 both clients, whichever are installed
//   npm run setup -- --claude     only Claude Code
//   npm run setup -- --codex      only Codex
//   npm run setup -- --dry-run    show what would change, change nothing
//   npm run setup -- --uninstall  remove everything this installer added
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MCP = join(ROOT, "dist", "mcp.js");
const args = new Set(process.argv.slice(2));
const dry = args.has("--dry-run");
const uninstall = args.has("--uninstall");
const wantClaude = args.has("--claude") || !args.has("--codex");
const wantCodex = args.has("--codex") || !args.has("--claude");
const BEGIN = "<!-- flow-agent:begin";
const END = "<!-- flow-agent:end -->";

const say = (s = "") => console.log(s);
const quote = (s) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
const sh = (cmd, ...a) => spawnSync([cmd, ...a].map(quote).join(" "), { shell: true, encoding: "utf8" });
const has = (cmd, flag = "--version") => sh(cmd, flag).status === 0;
const act = (label, fn) => {
  say(`${dry ? "[dry run] would " : ""}${label}`);
  if (!dry) fn();
};

say(`flow-agent setup${dry ? " (dry run)" : ""}${uninstall ? " (uninstall)" : ""}\n`);

// ---- prerequisites (install only) ----
if (!uninstall) {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) { say(`Node 20 or newer is required (this is ${process.versions.node}).`); process.exit(1); }
  for (const t of ["ffmpeg", "ffprobe"]) if (!has(t, "-version")) say(`! ${t} was not found on PATH. Video stitching, previews and logo removal need it (https://ffmpeg.org).`);
  if (!existsSync(join(ROOT, "node_modules"))) act("install npm dependencies", () => { if (sh("npm", "install", "--prefix", ROOT).status !== 0) { say("npm install failed"); process.exit(1); } });
  if (!args.has("--no-build")) act("build the project (npm run build)", () => { const r = sh("npm", "run", "build", "--prefix", ROOT); if (r.status !== 0) { say(r.stdout + r.stderr); process.exit(1); } });
  if (!dry && !existsSync(MCP)) { say(`Build output missing: ${MCP}`); process.exit(1); }
}

// ---- Claude Code ----
if (wantClaude) {
  say("\nClaude Code");
  if (!has("claude")) say("  not found on PATH, skipping (install Claude Code, then run this again).");
  else {
    const skillDir = join(homedir(), ".claude", "skills", "flow-agent");
    if (uninstall) {
      act("remove the flow-agent MCP server (user scope)", () => sh("claude", "mcp", "remove", "flow-agent", "-s", "user"));
      act(`remove the skill folder ${skillDir}`, () => rmSync(skillDir, { recursive: true, force: true }));
    } else {
      act("register the MCP server in Claude Code (user scope, all tools)", () => {
        sh("claude", "mcp", "remove", "flow-agent", "-s", "user");
        const r = sh("claude", "mcp", "add", "flow-agent", "-s", "user", "--", process.execPath, MCP);
        if (r.status !== 0) say("  claude mcp add failed: " + (r.stderr || r.stdout).trim());
      });
      act(`install the skill into ${skillDir}`, () => {
        mkdirSync(skillDir, { recursive: true });
        // The skill source has placeholders instead of personal paths; fill them in for this machine.
        const text = readFileSync(join(ROOT, "skill", "flow-agent", "SKILL.md"), "utf8")
          .replaceAll("{{FLOW_AGENT_DIR}}", ROOT)
          .replaceAll("{{OUT_DIR}}", process.env.FLOW_AGENT_OUT || join(homedir(), "flow-agent-out"))
          .replaceAll("{{HOME_DIR}}", process.env.FLOW_AGENT_HOME || join(homedir(), ".flow-agent"));
        writeFileSync(join(skillDir, "SKILL.md"), text);
      });
    }
  }
}

// ---- Codex ----
if (wantCodex) {
  say("\nCodex");
  if (!has("codex")) say("  not found on PATH, skipping (install the Codex CLI, then run this again).");
  else {
    const home = process.env.CODEX_HOME || join(homedir(), ".codex");
    const agentsFile = join(home, "AGENTS.md");
    const block = readFileSync(join(ROOT, "codex", "AGENTS.block.md"), "utf8").trim();
    const without = (text) => {
      const a = text.indexOf(BEGIN), b = text.indexOf(END);
      return a >= 0 && b > a ? (text.slice(0, a) + text.slice(b + END.length)).replace(/\n{3,}/g, "\n\n").trim() : text.trim();
    };
    const current = existsSync(agentsFile) ? readFileSync(agentsFile, "utf8") : "";
    if (uninstall) {
      act("remove the flow-agent MCP server from Codex", () => sh("codex", "mcp", "remove", "flow-agent"));
      act(`remove the flow-agent block from ${agentsFile}`, () => { if (current.includes(BEGIN)) writeFileSync(agentsFile, without(current) + "\n"); });
    } else {
      act("register the MCP server in Codex (video-only: images stay with Codex's own image generation)", () => {
        sh("codex", "mcp", "remove", "flow-agent");
        const r = sh("codex", "mcp", "add", "flow-agent", "--env", "FLOW_AGENT_VIDEO_ONLY=1", "--", process.execPath, MCP);
        if (r.status !== 0) say("  codex mcp add failed: " + (r.stderr || r.stdout).trim());
      });
      act(`add the flow-agent instructions to ${agentsFile}`, () => {
        mkdirSync(home, { recursive: true });
        if (current && !current.includes(BEGIN)) copyFileSync(agentsFile, `${agentsFile}.bak-flow-agent`);
        const base = without(current);
        writeFileSync(agentsFile, (base ? base + "\n\n" : "") + block + "\n");
      });
    }
  }
}

say(uninstall ? "\nDone. Restart open Claude Code / Codex sessions." : "\nDone. Start a NEW Claude Code or Codex session so it picks up the tools and instructions.\nFirst run: `npm run login` opens the dedicated Chrome window; sign in to Google there and open a Flow project.");
