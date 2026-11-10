#!/usr/bin/env node
// Runs every test/*.test.mjs with node's built-in runner. The files are listed here instead of using a glob in the npm
// script, because Windows' shell does not expand globs and Node 20 cannot expand them itself.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = readdirSync(join(root, "test"))
  .filter((f) => f.endsWith(".test.mjs"))
  .sort()
  .map((f) => join("test", f));
if (!files.length) {
  console.error("No test files found in test/");
  process.exit(1);
}
const r = spawnSync(process.execPath, ["--test", ...files], { cwd: root, stdio: "inherit" });
process.exit(r.status ?? 1);
