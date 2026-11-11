import { basename } from "node:path";
import { getFlowPage } from "./chrome.js";
import { dismissOverlays, ensureProject, optionNameRe } from "./flow.js";
import { pause } from "./guard.js";
import { log } from "./library.js";
import { currentProjectId } from "./projects.js";
import { find } from "./selectors.js";
import { planUpload, type UploadInput } from "./uploadplan.js";

// Bulk upload of local images into the open Flow project (they land in its Uploads). Free: no credits are involved.
// Typical use: the client (Codex or Claude Code) generated a batch of images and wants them in Flow, so they can be
// used there or passed as start_image / end_image / reference_images when making videos.
//
// Safety rules:
//  - Only png/jpg/jpeg/webp files that exist, checked in full BEFORE Flow is touched (one bad path stops the whole call).
//  - Nothing is ever deleted, replaced or renamed; a file whose name already exists in the project is skipped, not overwritten.
//  - The asset picker is closed afterwards without adding anything to the prompt.

const BATCH = 8; // files handed to Flow's file chooser at once
const chunk = <T,>(a: T[], n: number): T[][] => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, (i + 1) * n));

export async function uploadMedia(input: UploadInput, onProgress?: (s: string) => void): Promise<string> {
  const plan = planUpload(input); // before anything is clicked
  const page = await getFlowPage();
  await ensureProject(page);
  await dismissOverlays(page);
  const project = currentProjectId(page) ?? "?";

  // The asset picker (the same one video frames and ingredients use) lists the project's media and has "Upload media".
  await (await find(page, "ingredient_add")).click();
  const list = await find(page, "picker_list");
  const uploading = list.getByRole("option", { name: /^Uploading / });
  const present = async (f: string) => (await list.getByRole("option", { name: optionNameRe(basename(f)) }).count()) > 0;

  const skipped: string[] = [];
  const todo: string[] = [];
  for (const f of plan.files) ((await present(f)) ? skipped : todo).push(f);

  const done: string[] = [];
  const failed: string[] = [];
  try {
    let n = 0;
    for (const batch of chunk(todo, BATCH)) {
      const pending = [...batch];
      while (pending.length) {
        const [chooser] = await Promise.all([page.waitForEvent("filechooser", { timeout: 10_000 }), (await find(page, "picker_upload")).click()]);
        // If Flow's chooser takes only one file, hand the files over one at a time.
        const take = chooser.isMultiple() ? pending.splice(0, pending.length) : pending.splice(0, 1);
        await chooser.setFiles(take);
        onProgress?.(`uploading ${n + 1}-${n + take.length} of ${todo.length}`);
        // Each file is listed as "Uploading <name>" and then becomes "<name>". Wait until all are swapped.
        const start = Date.now(), limit = 90_000 + 30_000 * take.length;
        let sawUploading = false;
        for (;;) {
          const busy = await uploading.count();
          if (busy > 0) sawUploading = true;
          let have = 0;
          for (const f of take) if ((await list.getByRole("option", { name: optionNameRe(basename(f)) }).count()) > 0) have++;
          if (busy === 0 && (sawUploading || Date.now() - start > 4000) && have === take.length) break;
          if (Date.now() - start > limit) break;
          await page.waitForTimeout(600);
        }
        for (const f of take) ((await present(f)) ? done : failed).push(f);
        n += take.length;
        if (pending.length || n < todo.length) await pause(page, 1200, 3200);
      }
    }
  } finally {
    // Close the picker without adding anything to the prompt.
    await page.keyboard.press("Escape").catch(() => {});
    await dismissOverlays(page).catch(() => {});
  }

  log({ action: "upload", project, uploaded: done.map((f) => basename(f)), skipped: skipped.map((f) => basename(f)), failed: failed.map((f) => basename(f)) });
  const out = [`Uploaded ${done.length} of ${plan.files.length} image(s) to the open Flow project${project === "?" ? "" : ` (${project.slice(0, 8)})`}; they are in its Uploads. No credits were used.`];
  if (done.length) out.push(`uploaded: ${done.map((f) => basename(f)).join(", ")}`);
  if (skipped.length) out.push(`skipped (a file with that name is already in the project, nothing replaced): ${skipped.map((f) => basename(f)).join(", ")}`);
  if (failed.length) out.push(`NOT confirmed in Flow (check the Uploads page or try again): ${failed.map((f) => basename(f)).join(", ")}`);
  if (plan.ignored) out.push(`ignored ${plan.ignored} non-image, empty or too-large file(s) found in the folder`);
  if (done.length) out.push("To use one in a video, pass its absolute path as start_image, end_image or reference_images in flow_generate.");
  return out.join("\n");
}
