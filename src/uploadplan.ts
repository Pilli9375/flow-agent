import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join } from "node:path";
import { FlowUiError } from "./selectors.js";

// Pure request checking for flow_upload, kept free of any browser code so the tool server can refuse a bad request
// before it reaches the worker.
export const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp"]);
export const MAX_FILES = 50;
export const MAX_BYTES = 25 * 1024 * 1024; // conservative per-file cap; Flow rejects very large images anyway
export type UploadInput = { files?: string[]; folder?: string; recursive?: boolean };
export type UploadPlan = { files: string[]; ignored: number };

const isImage = (f: string) => IMAGE_EXT.has(extname(f).toLowerCase());

// Images directly inside a folder (and, with recursive, one level of sub-folders: Codex keeps its generated images
// in <generated_images>/<session>/<file>.png). Sorted by name so the order is stable.
function scanFolder(dir: string, recursive: boolean, depth = 0): { found: string[]; ignored: number } {
  const found: string[] = [];
  let ignored = 0;
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (recursive && depth < 1) {
        const sub = scanFolder(p, recursive, depth + 1);
        found.push(...sub.found);
        ignored += sub.ignored;
      }
    } else if (isImage(e.name)) found.push(p);
    else ignored++;
  }
  return { found, ignored };
}

// Pure: validates a request and returns the final list of files, or throws one error listing every problem.
export function planUpload(input: UploadInput): UploadPlan {
  const problems: string[] = [];
  let ignored = 0;
  const all: string[] = [];
  for (const f of input.files ?? []) {
    if (!isAbsolute(f)) problems.push(`Not an absolute path: ${f}`);
    else if (!existsSync(f) || !statSync(f).isFile()) problems.push(`Image not found: ${f}`);
    else if (!isImage(f)) problems.push(`Not a png/jpg/webp image: ${f}`);
    else if (statSync(f).size > MAX_BYTES) problems.push(`Too large (over ${MAX_BYTES / 1024 / 1024} MB): ${f}`);
    else if (statSync(f).size === 0) problems.push(`Empty file: ${f}`);
    else all.push(f);
  }
  if (input.folder) {
    if (!isAbsolute(input.folder)) problems.push(`Not an absolute folder path: ${input.folder}`);
    else if (!existsSync(input.folder) || !statSync(input.folder).isDirectory()) problems.push(`Folder not found: ${input.folder}`);
    else {
      const s = scanFolder(input.folder, !!input.recursive);
      ignored += s.ignored;
      for (const f of s.found) {
        const size = statSync(f).size;
        if (size === 0 || size > MAX_BYTES) ignored++;
        else all.push(f);
      }
      if (!s.found.length) problems.push(`No png/jpg/webp images in ${input.folder}${input.recursive ? "" : " (set recursive to look one level into sub-folders)"}`);
    }
  }
  if (!input.files?.length && !input.folder) problems.push("Give files (absolute paths) or a folder.");
  const files = [...new Set(all)];
  // Flow names an asset by its file name, so two different files with the same name could not be told apart.
  const seen = new Map<string, string>();
  for (const f of files) {
    const n = basename(f).toLowerCase();
    if (seen.has(n)) problems.push(`Two different files are both named ${basename(f)} (${seen.get(n)} and ${f}); rename one.`);
    else seen.set(n, f);
  }
  if (files.length > MAX_FILES) problems.push(`At most ${MAX_FILES} images per call (got ${files.length}); split into several calls.`);
  if (problems.length) throw new FlowUiError(problems.slice(0, 8).join("\n") + (problems.length > 8 ? `\n…and ${problems.length - 8} more problem(s).` : ""));
  return { files, ignored };
}
