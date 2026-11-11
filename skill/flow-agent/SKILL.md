---
name: flow-agent
description: Use whenever the user wants to generate images or videos with Google Flow / Nano Banana / Veo / Omni, make Flow stills, scenes or clips, or says "generate in Flow", or asks to redo/regenerate/fix a Flow image or video. Drives the local flow-agent MCP tools (flow_status, flow_account, flow_quote, flow_project, flow_generate, flow_jobs, flow_edit, flow_library, flow_files, flow_upload); it asks the user which Flow project to use and, for images, how many to make. Images cost 0 credits; videos SPEND credits, so ask the user to pick settings with clickable choices and approve the cost first.
---

# Flow generation via flow-agent

## Always
1. Call `flow_status` once. If it says Chrome is unreachable or the user is not signed in, tell the user exactly what it says (sign in in the Flow Chrome window; `npm run login` in `{{FLOW_AGENT_DIR}}`) and stop. "signed in, but no project open" is fine: step 2 opens one.
2. **Ask which Flow project to use** (once per conversation, skip only if the user already named it). Call `flow_project (action=list)`, then use `AskUserQuestion` (header "Project") with the 3 most recent projects as options plus "New project"; show the full list in the question text so projects beyond the options can be chosen through "Other". Label untitled projects by their edited date, and mention the short id (first 8 characters) in each description. Then call `flow_project (action=open)` with the chosen id, or `new` for a new one (not needed if the chosen one is already `OPEN NOW`). It is refused while jobs are queued or running. Use the project's title (or "NewProject") as the `project` folder name in `flow_generate`.
3. Send all scenes in ONE `flow_generate` call, then `flow_jobs (action=wait)` repeatedly until `finished: true` (each call blocks ~35 s).
4. Prompt style: subject and action, shot and camera move, location, style, light. English. Repeat full character descriptions in every scene.

## Images (0 credits)
No spend approval needed, but **ask how many images to generate per prompt** with `AskUserQuestion` (header "How many", options 1, 2, 3, 4; recommend 2), unless the user already gave a number. Pass the answer as `variants` on each image scene (Flow makes that many per prompt). Aspect ratio defaults to 16:9; use another only if the user asks. Then generate and show the results in chat (see Delivering).

## Videos (SPEND credits): settings picker, then approval, every time
Never call `flow_generate` with `type: "video"` before the user has picked settings AND approved the cost in chat. Use the `AskUserQuestion` tool so the user clicks choices instead of typing.

### Step 0: check the balance and choose the model by what the user can afford
Call `flow_account (what=credits)` first (refused while jobs run; wait for them). The user's rule: quality matters, but never at the cost of running out, so when credits are low pick the cheaper model; when credits are plentiful pick the better one. Work it out like this and tell the user the numbers:
- Total for the planned batch = clips x variants x per-clip cost (see the rough costs in step 2; Flow's live quote decides).
- Recommend the best-quality model whose whole batch costs at most about half of the balance. The usual order, best first: Omni 1.2 Flash (newest, about 12 per 4s 720p clip), then Omni 1.1 Flash (about 7, leaves Dec 5), then a 360p draft.
- Example with 29 credits and one 4s 720p clip: Omni 1.2 Flash (about 12, leaves about 17) is more than a third of the balance, so recommend Omni 1.1 Flash (about 7, leaves about 22). With 100+ credits recommend Omni 1.2 Flash. After Dec 5 Omni 1.1 Flash is gone, so choose between Omni 1.2 Flash and a 360p draft in the same way.
- If even the cheapest option does not fit the balance, say so, show the reset date from `flow_account (what=credits)`, and offer a cheaper plan (360p draft, fewer or shorter clips) or waiting.
- Put the balance and "what each choice leaves you with" in the model question's descriptions, mark the affordable best as (Recommended), and let the user override. After the generation, call `flow_account (what=credits)` again and tell the user the new balance.

### Step 1: settings picker (one AskUserQuestion call, 4 questions)
Put your recommendation first in each list and add "(Recommended)" to its label. The user's baseline is at least 720p, so recommend 720p. If the user already stated a setting in their request, make that the recommended option (or skip that question). Questions:
1. **Model** (4 options, Flow now lists 5): Omni 1.1 Flash (cheapest, about 7 credits for 4s 720p, leaves Flow on Dec 5), Omni 1.2 Flash (newest, about 12 credits for 4s 720p), Veo 3.1 - Lite, and one more of Veo 3.1 - Fast / Veo 3.1 - Quality (the other through "Other"; both leave Dec 5). Which one is (Recommended) comes from step 0 (the balance), not from habit. Note in each description its rough cost and what it leaves the user; Flow's live quote decides.
2. **Resolution** (Omni only): 720p (Recommended), 360p (cheaper draft).
3. **Duration** (Omni only): 4s, 6s, 8s, 10s. Recommend 8s, or what the scene needs.
4. **Aspect ratio**: 16:9 (Recommended), 9:16.

The worker's default model is Omni 1.2 Flash when `model` is omitted, but always pass the model the user picked. From Dec 5 Flow no longer lists Omni 1.1 Flash or Veo 3.1 Fast/Quality: then offer only Omni 1.2 Flash and Veo 3.1 - Lite (plus whatever `flow_quote` shows works). If a job fails with "Flow does not offer the model ...", nothing was spent: tell the user which models Flow offers and ask again.

Veo models have no resolution or duration choice in the Flow UI, so if the user picks a Veo model, tell them those two settings are fixed by Veo (the tool ignores them). Because the model choice decides whether questions 2 and 3 apply, if the user already named a Veo model in their request, ask only the ratio.
Variants default to 1; mention the variant count in the confirmation and let the user change it there (via "Other").

### Reference images (start/end frames, ingredients)
If the user attaches or names image files for a video, use their absolute paths (an image pasted in chat has a saved path; ask for the path if you don't have one). Pass them on the scene:
- `start_image` (first frame) and optionally `end_image` (last frame; needs a start): Flow animates from one to the other.
- `reference_images` (up to 3): Flow "Ingredients", the subject or style the video should use. Cannot be combined with start/end.
Mention which images and which mode in the step 2 summary. The prompt should describe the motion, not re-describe what the image already shows. Each image is uploaded into the Flow project, so only use files the user gave you.

### Longer films: chained scenes + stitch
One clip is 4 to 10 seconds. For a longer film, send several video scenes in ONE `flow_generate` call and set `chain: true` on every scene after the first: each one starts from the last frame of the previous scene, so the motion continues across cuts. Write each prompt as the next beat of the story, not a repeat. When all jobs are `done`, call `flow_files (action=stitch)` with the same `project` name (no credits) to get one `final.mp4`, then deliver that file. The step 2 total must cover every scene (scenes x variants x per-clip cost). If a scene fails, the chain stops there and later scenes cost nothing; tell the user, and re-run only from the failed scene after a new approval. Chaining needs ffmpeg on PATH.

### Step 2: cost confirmation (second AskUserQuestion call)
Get exact prices with `flow_quote` (one call per distinct setting combination; it only reads Flow's quote and spends nothing), then summarise the choices in one line and give the TOTAL credits for the whole batch (scenes x variants x per-clip quote). Options: "Go ahead" (Recommended), "Change settings". "Other" lets the user type a change. Typical quotes seen so far: Omni 1.1 Flash 4s 360p 4, 4s 720p 7, 8s 720p 12; Omni 1.2 Flash 4s 360p 4, 4s 720p 12, 8s 720p 24 (it takes any whole 3 to 15 seconds); Veo Lite ~10, Fast ~20, Quality ~100 (8s). The live quote always wins.
Wait for "Go ahead". A yes covers only that exact plan, not different settings, extra variants or a regeneration.

### Step 3: run
The user may also see a confirmation dialog from the tool server (it lists the scenes and the credits); if they decline, nothing was spent: say so and ask what they want. If the user has set a daily credit budget (see `flow_account (what=spend)` and the `budget:` line in `flow_status`), the worker enforces it; if a job fails with "Daily credit budget reached", tell the user and stop. Only the user can raise it (`node dist/cli.js budget <credits>` in the flow-agent folder). Never look for a way around it.
Call `flow_generate` with `type: "video"`, the chosen model/duration/resolution/aspect_ratio/variants, and `max_credits` set to the approved per-scene amount (round up a little to the estimate, never above what the user accepted). If a scene fails with "Skipped: Flow quotes N credits, over the cap", nothing was spent: tell the user N and ask again (step 2).

## Bulk upload of local images (`flow_upload`)
`flow_upload` puts many local images into the open Flow project's Uploads in one call: `files` (up to 50 absolute paths of png/jpg/jpeg/webp) and/or `folder` (every image directly inside it; `recursive: true` also looks one level into sub-folders). It is free (0 credits), generates nothing and needs no approval of a cost, but ask which project first like for everything else, because the images go into the open project. The whole request is checked before Flow is touched (missing file, wrong type, empty or over 25 MB, two different files with the same name, more than 50); nothing is replaced or deleted, and a file whose name already exists in the project is skipped and reported. It is refused while jobs run. To animate an uploaded image, pass its absolute path as `start_image`, `end_image` or `reference_images` in `flow_generate` (that still follows the video spend rules: settings, quote, cost approval).

## Managing the open project's media (list, trash, restore, rename, favorite, cover)
Tools: `flow_library` with action list, trash_list, trash, restore, rename, favorite, unfavorite or cover; and `flow_project` with action=rename (all refused while jobs run).
- **Deleting only means Move to Trash.** The tools cannot delete permanently, empty the Trash, delete a project, or "Delete all" (the code blocks any delete-style button). If the user wants something erased for good or a project deleted, tell them to do it themselves in Flow's Trash or home page.
- **Trashing is two steps and the user must approve in between.** First `flow_library (action=list)` (so numbers and titles are current), then `flow_library (action=trash)` with `items` only: it returns a PREVIEW and a confirm code and changes nothing. Show the user that exact list with `AskUserQuestion` ("Move these N items to the Trash? You can restore them.", options "Move to Trash" / "Cancel"). Only after they approve, call `flow_library (action=trash)` again with the same items and `confirm=<code>`. Never trash anything the user did not name or approve; never guess titles. For a big cleanup, group by what the user said and keep batches under 25.
- Items are addressed by number AND exact title, copied from the latest list. If a call says the grid changed, list again; never retry with guessed values.
- `flow_library (action=restore)` is safe and needs no approval. Restored items reappear at the top of the grid, so numbers change; list again afterwards.
- `flow_library (action=rename/favorite/unfavorite/cover)` renames an item, favorites or unfavorites it, or sets it as the project cover. `flow_project (action=rename)` renames the project. Ask first only if the user did not clearly request it.
- Everything is logged to `~/.flow-agent/actions.log`; mention it if the user wants to see what was done.

## Editing an existing image (`flow_edit`)
`flow_edit` changes an image that is already in the open project, with a prompt ("make the sky stormy", "add a candle"). Use number and title from `flow_library (action=list)`. Images are free (leave `max_credits` at 0). Flow stores the edit as a new version of the same item (its stack icon in the grid; the original version stays in its history); the tool downloads the edited version, removes the corner logo and saves it under `Edits/` (`edit-NN.jpeg`). Deliver it like any image. Editing an existing VIDEO is switched off by default (it spends credits and Flow's video editor shows no price, so the tool cannot quote it; it was verified once live: a 4 s clip generated at 360p cost 4 credits and the edit came back as a new version of the same item, warmer light as asked; set FLOW_AGENT_VIDEO_EDIT=1 and FLOW_AGENT_VIDEO_EDIT_COST=<credits the user approves> to use it): offer to regenerate with a changed prompt instead, or to test video editing for a few credits if the user wants. Note that an image that already has Flow's star baked into its pixels (for example an old download that was uploaded again) makes the model redraw the star, and that cannot be removed; edit the original Flow-made image, not a downloaded copy.

## Checking results cheaply, stitching, and planning a film
- After a job finishes, `flow_files (action=preview)` (path of the file) makes a small contact-sheet image: a grid of six frames for a video, a scaled copy for an image. Read it to check that the result matches the prompt before deciding to redo anything, and send the full file to the user only when it is good. Previews are a few hundred KB at most.
- Every delivered file has a `.json` next to it with the prompt, model, settings, credits and logo status; use it to reproduce or tweak a result ("same as scene 2 but at night").
- `flow_files (action=stitch)` joins clips. Use the default plain cut for chained scenes (they already continue) and `transition: "fade"` for separate shots (crossfade, 0.4 s by default).
- To plan a film: (1) agree the story as a short scene list (one beat each, same full character description in every prompt); (2) `flow_account (what=credits)` for the balance and `flow_quote` for exact per-clip prices; (3) propose a draft pass first with 360p clips (about 4 credits each), review them with `flow_files (action=preview)`, then spend on 720p finals only for the scenes the user approves; (4) chain scenes that must flow, fade between ones that do not; (5) state the total credits for each pass before asking for approval, stay within the balance, and report the new balance at the end.

## Pacing and Flow's "unusual activity" check
`flow_status` shows a `pacing:` line (submissions in the last hour, and any cooldown). Flow sometimes rejects an automated generation with its own "unusual activity" message. The worker then stops at once and starts a cooldown (30 minutes, doubling on repeats, 4 hours at most), and jobs queued during it fail without submitting anything. When that happens: tell the user plainly, quote Flow's message, say when the cooldown ends, and suggest they make the next generation by hand in the Flow Chrome window (then you can download and clean it). Never retry in a loop, never try to get around the check, and keep batches modest (the worker allows 15 submissions per hour). The queue history is saved, but unfinished jobs are never resubmitted after a restart.

## Veo's text mark
Veo models (3.1 Lite/Fast/Quality) also stamp a small white "Veo" text bottom-right. The worker removes it too (blend reversal plus filling the thin strokes from the neighbouring picture); the job line then says `Veo text mark removed (...)`. It is less exact than the sparkle removal and was tuned on one clip: tell the user a faint smudge can remain on very textured frames, and if the line says `did not verify` or `check failed`, deliver the file as is and say so. Original kept in `originals/`.

## Flow's corner logo (sparkle)
Files made with Flow's free daily credits carry a white star in the bottom-right corner. The worker removes it automatically after every download by reversing the exact 30% white blend (no cropping, no loss of detail) and rebuilding only a thin edge band; the untouched original is kept in an `originals/` folder next to the file. The job line says `logo: logo removed (...)` or `logo: no watermark found, nothing to remove` (plan credits). If it says `cleanup did not verify`, `check failed` or `not located`, tell the user, deliver the file as is, and do not claim it is clean. For older files use `flow_files (action=clean_logo)` (absolute paths, 0 credits). The user can turn it off with `FLOW_AGENT_LOGO=keep`. Chained scenes start from the cleaned last frame, so the star never feeds into the next scene.

## Post-production (free, local, `flow_files`)
After a clip is delivered the user may want it for a platform or polished. `flow_files` never touches Flow or the source file; each result is a NEW file in an `exports/` folder next to it:
- `action=export` with `preset` reels / tiktok / shorts (1080x1920, 9:16), youtube (1920x1080), square (1080x1080), small (720p). `fit=crop` (default) fills the frame; `focus` 0 to 1 picks which part a crop keeps (0.5 centre); `fit=pad` keeps the whole picture with black bars. Ask which platform and, for a 16:9 clip going to 9:16, whether cropping is OK (it cuts the sides) or padding is better.
- `action=trim` (start, end seconds), `action=speed` (factor 0.25 to 4), `action=mix_audio` (audio file, volume default 0.4, clip_volume, replace_audio), `action=captions` (an .srt file you write: numbered cues with times like `00:00:01,000 --> 00:00:03,000`).
- Check results with `action=preview`, then deliver the file with SendUserFile.

## Delivering (in chat)
When jobs are `done`, show the files in the conversation: use `SendUserFile` with the saved paths (images and videos, display "render") when it is available; otherwise give the full paths. Videos are `.mp4` under `{{OUT_DIR}}\<project>\`. The worker downloads the highest quality Flow offers, never below 720p and never above 1080p: a 720p video is upscaled by Flow to 1080p (takes up to a few minutes, no credit cost was shown), and the job line says `quality: 1080p`. A 360p draft can only reach 720p. If the line says "original size kept, upscale failed" or "below the 720p minimum", tell the user the delivered size and offer a regeneration at 720p (needs approval as a new spend). Don't re-describe or re-read media unless asked, to save tokens. Say how many credits were used (the job reports `credits` for failed/skipped scenes in its message; otherwise quote the approved estimate and say it is an estimate).

## Errors, regenerate, edit
- If a job `failed`, read the one-line reason. Nothing is auto-retried for videos.
- "Regenerate": treat it as a NEW spend. Re-run step 2 (cost confirmation, keeping the previous settings as the recommended ones) before any video. Images can be redone freely.
- "Edit"/"change X": there is no in-place video editing yet. Rewrite the prompt with the change (keep everything else identical), tell the user it is a regeneration with its credit cost, run step 1 (offer the previous settings as recommended) and step 2, then run. Offer a cheaper draft first (Omni 360p) before an expensive final.
- If `flow_status` shows `doctor canary: ... BROKEN`, Flow's UI changed: do the "Flow UI changed" repair below before generating.
- "Flow UI changed": first run `node {{FLOW_AGENT_DIR}}\dist\cli.js doctor --fix` yourself (0 credits, no model use): it finds the closest matching control for each broken action and saves a verified fallback to `selectors.json`. Re-run `doctor` to confirm. If something still FAILS, the diagnostics are under `{{HOME_DIR}}/diag` (screenshot + accessibility snapshot); read the snapshot and edit `{{FLOW_AGENT_DIR}}\selectors.json` yourself, then re-run `doctor`.
