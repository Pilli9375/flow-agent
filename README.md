# flow-agent

Let **Claude Code** or **Codex** make images and videos with [Google Flow](https://flow.google.com) for you, then tidy the results, all from a chat.

You say "make me a 4-second video of a paper boat on a stream". The assistant asks which Flow project to use and what settings you want, shows you the exact credit price, waits for your "go ahead", then flow-agent does the clicking, waiting and downloading in its own Chrome window. It also removes Flow's corner watermark when the file has one, and can cut the clip for Reels, YouTube, TikTok and so on.

> **Unofficial.** This project is not made by or connected to Google. It drives Flow's website like a person would. Flow's terms apply to everything you make, and Flow can change its page at any time (see [When Flow changes](#when-flow-changes)). It paces itself and never tries to get around Flow's anti-abuse checks. Use it at your own risk.

## What you need

- A computer with **Windows, macOS or Linux**. No GPU is needed (everything here runs on the CPU). Most use so far is on Windows; Mac and Linux are only covered by automated tests.
- **Node.js 20 or newer**, **Google Chrome**, and **[ffmpeg](https://ffmpeg.org)** on your PATH.
- A **Google account with Google Flow** (credits are yours; videos cost credits, images are free).
- **Claude Code** and/or **Codex** (the Codex CLI or desktop app).

## Quick start

```bash
git clone https://github.com/Pilli9375/flow-agent.git
cd flow-agent
npm install
npm run setup     # builds, then registers with Claude Code and Codex (whichever are installed)
npm run login     # opens a separate Chrome window: sign in to Google by hand and open a Flow project
npm run doctor    # checks that every button the tool needs is still on Flow's page
```

Then start a **new** Claude Code or Codex session and ask for something, for example:

> Make a 4 second video of a paper boat on a calm stream at sunrise.

Handy variants: `npm run setup -- --claude`, `-- --codex`, `-- --dry-run` (shows what it would change, changes nothing) and `npm run uninstall-agent` (removes everything the installer added).

What `npm run setup` changes, and nothing else: a user-level MCP server named `flow-agent` in Claude Code plus the skill file `~/.claude/skills/flow-agent/SKILL.md`; in Codex, an MCP server `flow-agent` and a marked block in `~/.codex/AGENTS.md` (an existing file is backed up once as `AGENTS.md.bak-flow-agent`).

### Claude Code and Codex are set up differently on purpose

- **Claude Code** gets everything: images, video, editing, library, post-production.
- **Codex** gets **video only**. Codex already has its own image generator, so still images stay there and nothing image-related is ever sent to Flow from Codex.

## How it works, in plain words

1. One small local program (the *worker*, `127.0.0.1:8788`, started on demand) owns a Chrome window with its **own profile** (`~/.flow-agent/chrome-profile`), never your everyday one.
2. The assistant talks to the worker through a few tools (see [Tools](#tools)). The worker uses Flow's page only to submit: type the prompt, pick model and settings, press Start.
3. It then watches Flow's grid for the new result, downloads it with your signed-in session, removes the watermark if there is one, and saves it with a small `.json` next to it (prompt, settings, credits).
4. Jobs run one at a time with random pauses, so it behaves like a patient person.

Output goes to `~/flow-agent-out/<project>/scene-NN.mp4` (or `.jpeg`). Edits go to `~/flow-agent-out/Edits/`; post-production results go to an `exports/` folder next to the source.

## Your credits are protected

Videos cost Flow credits. The rules, enforced in code and not just in the assistant's instructions:

- **Never spent without your approval.** The assistant must show settings, an exact price from Flow (`flow_quote`, which spends nothing) and the total, then wait for your "go ahead". A yes covers only that exact plan.
- **Per-scene cap.** Every scene carries `max_credits`; the worker skips any scene Flow quotes above it, before pressing Start.
- **Confirmation box** (where the app supports it): before a video spend, a video edit, or a Trash move, the tool server asks you in the app's own dialog. Claude Code shows it. Codex's desktop app declines such dialogs instantly without showing them, so there the chat approval and the cap are your protection. `FLOW_AGENT_CONFIRM=require` refuses when the app cannot ask; `off` never asks.
- **Optional daily budget**: off by default. Turn it on with `node dist/cli.js budget <credits>` (or `FLOW_AGENT_DAILY_BUDGET`); `budget 0` turns it off. Only you can change it, no tool can.
- **Spend log**: every spend is written to `~/.flow-agent/spend.jsonl`; `node dist/cli.js spend` or the `flow_account` tool shows it.
- **Model choice follows your balance**: the assistant recommends the best model the balance can comfortably afford and always lets you decide.

"Delete" only ever means **Move to Trash**. Trashing is two steps (a preview with a one-time code, then the confirm after you approve the exact list), and permanent delete, "Delete all", empty trash and project delete are blocked in code.

## Watermark removal, checked first and only when needed

Flow can stamp a mark into the corner of what it makes. Whether it does depends on your account and region, so **every downloaded file is checked first**; if there is nothing to remove, the file is left alone and the job says `no watermark found, nothing to remove`.

Both marks are *see-through overlays*, so they can be undone:

- **Flow's star (sparkle).** Flow lays a white star over the picture at 30% strength: what you see is 70% real picture plus 30% white. The star's exact shape, size and position are known, so for each pixel under it the tool does the maths backwards (take away the white, then scale back up). That returns the original pixel. A thin ring at the star's blurry edge is rebuilt from the pixels just outside it. For upscaled video, the smaller original-size download has a crisp star: that one is cleaned exactly and only the small corner patch of the big file is replaced.
- **The "Veo" text** (Veo models only). Its shape was not known, but it never moves while the picture does, so averaging all frames of a clip makes the moving picture blur away and leaves the text sharp, which gives a map of the mark. The faint edges of the letters are reversed like the star; the thin solid strokes are filled from the picture around them, because undoing the maths there would only amplify noise.

After cleaning, the corner is measured again and the original file is kept if the check fails. Untouched originals are saved in `originals/`.

Be honest with yourself about quality: the star removal is exact maths; the Veo removal is partly a fill, so **a faint soft smudge can remain on very textured frames**. Look at the corner of your result. Set `FLOW_AGENT_LOGO=keep` to skip the check and the removal. This only removes the visible mark, not Google's invisible tag; if you publish AI-made content, check the rules that apply to you.

**Speed:** no GPU, no AI model. About 5 seconds for an 8-second 1080p clip on an 8-core laptop CPU. A slow or old PC will take noticeably longer (not measured); the progress line says it is checking for a watermark.

## Tools

The assistant sees ten tools:

| Tool | What it does |
|---|---|
| `flow_status` | Is Flow ready, what is queued, pacing, today's credit use, and the daily self-check result |
| `flow_account` | `credits`: your balance and reset date. `spend`: what this toolkit spent |
| `flow_project` | `list` your Flow projects, `open` one (or create a new one), `rename` |
| `flow_quote` | Flow's exact price for a scene, **without submitting** |
| `flow_generate` | Queue images or videos (returns job ids) |
| `flow_jobs` | `wait` for the queued jobs, or `cancel` one |
| `flow_edit` | Edit an existing image with a prompt (free). Video editing works but is off by default: set `FLOW_AGENT_VIDEO_EDIT=1` and `FLOW_AGENT_VIDEO_EDIT_COST=<credits you accept>`, because Flow's video editor shows no price |
| `flow_upload` | Bulk-upload local images (up to 50, as file paths or a whole folder) into the open project's Uploads. Free. Checked in full before Flow is touched; a file whose name is already in the project is skipped, never replaced |
| `flow_library` | `list` media, `trash_list`, `trash` (preview then confirm), `restore`, `rename`, `favorite`, `unfavorite`, `cover` |
| `flow_files` | Work on local files, free: `preview` (a small contact sheet), `clean_logo`, `stitch` (join clips, cut or crossfade), `export` (reels, tiktok, shorts, youtube, square, small), `trim`, `speed`, `mix_audio`, `captions` (burn in an .srt) |

### Video details

- Models: **Omni 1.2 Flash** (the default), Omni 1.1 Flash and Veo 3.1 Fast/Quality (these three leave Flow on Dec 5), Veo 3.1 Lite. If a model is no longer in Flow's menu, the job stops before any spend and lists the models Flow offers.
- Omni 1.2 takes any whole 3 to 15 seconds, Omni 1.1 takes 4/6/8/10; Omni resolutions are 360p or 720p; ratios are 16:9 or 9:16; Veo is fixed at 8 seconds.
- **Best size**: the worker downloads the highest size Flow offers, never below 720p and never above 1080p (it uses Flow's upscale).
- **Image to video**: `start_image` / `end_image` (Flow's Frames) or up to 3 `reference_images` (Ingredients), as absolute file paths.
- **Bulk upload** (`flow_upload`, or `node dist/cli.js upload <files or folder> [--recursive]`): puts a batch of images, for example the ones Codex generated under `~/.codex/generated_images/`, into the open project in one go, without a prompt and without credits. `png`, `jpg`, `jpeg` and `webp` only, at most 50 per call and 25 MB each. Two different files with the same name in one call are refused (Flow names an asset by its file name). Not available while jobs run.
- **Longer films**: set `chain: true` on later scenes so each one starts from the previous scene's last frame, then `flow_files` with `stitch`.

### Command line (no assistant needed)

`node dist/cli.js` mirrors it: `upload <files|folder> [--recursive]`, `gen <project> scenes.json`, `wait`, `status`, `cancel`, `quote '<json>'`, `credits`, `spend`, `budget [n]`, `projects`, `open-project <id|new>`, `lib <op> '<json>'`, `edit '<json>'`, `stitch <project> [--fade]`, `preview <file>`, `clean-logo <file...>`, `export <file> <preset> [--pad] [--focus 0..1]`, `trim <file> <start> [end]`, `speed <file> <factor>`, `mix <file> <audio> [--volume 0.4] [--replace]`, `captions <file> <subs.srt>`, `cleanup`, `doctor [--fix|--offline|--capture]`.

## Pacing and Flow's "unusual activity" check

At most 15 submissions an hour (`FLOW_AGENT_MAX_PER_HOUR`), prompts typed in short bursts with brief pauses, and a **cooldown** (30 minutes, doubling on repeats, 4 hours at most) after Flow rejects a generation; the state survives restarts. If Flow shows its "unusual activity" message, the worker stops at once and does not retry or try to get around it. Make the next one by hand in the Flow window; the tools can still download and clean it. The queue history is saved, and jobs unfinished at a restart are marked failed and **never resubmitted**.

## When Flow changes

Flow's page changes often. The tool finds buttons through ordered candidates in `selectors.json`.

- `npm run doctor` shows which control broke; `node dist/cli.js doctor --fix` finds the closest match on the live page, checks it is unique, and saves it (no AI model involved).
- `node dist/cli.js doctor --offline` (also part of `npm test`) checks `selectors.json` against saved, sanitized snapshots of Flow's pages in `fixtures/aria/`, with no Chrome. After Flow's look changes and the live doctor is green, refresh them with `doctor --capture`.
- About once a day, when idle, the worker runs the live check itself (it never spends credits) and `flow_status` shows a `doctor canary:` line. `FLOW_AGENT_CANARY=off` disables it.
- A failure saves a screenshot and page snapshot under `~/.flow-agent/diag/`.

## Troubleshooting

- *"Chrome not reachable" or "not signed in"*: run `npm run login`, sign in by hand in the window that opens, and open a Flow project.
- *A tool says jobs are running*: library, edit, quote and credits wait until the queue is empty (they use the same page).
- *The worker runs old code after you rebuild*: stop the `node` process running `dist/daemon.js`; it restarts on the next request.
- *Console windows flashing on Windows*: the ffmpeg helpers run hidden; if you still see some, open an issue with what you were doing.

## Security notes

- The dedicated Chrome profile (`~/.flow-agent/chrome-profile`) holds your Google sign-in. Treat it like a password: keep it private, never copy or sync it.
- Chrome's debugging port (9444 by default) is open to programs running on this computer; anything that can reach it can drive that signed-in browser. The worker itself only listens on 127.0.0.1 and checks a header and the Host.
- Nothing is sent anywhere except to Google Flow through that browser. Output files stay on your machine.

## Local cleanup

`node dist/cli.js cleanup` lists the folders in `~/flow-agent-out` with sizes. `cleanup --older 14` (or folder names) previews what it would move and prints a code; `--confirm <code>` then moves those folders into `~/flow-agent-out/.trash/<date>/`. Nothing is erased; move a folder back by hand, or delete `.trash` yourself when you are sure. It never touches Flow.

## What is tested, honestly

Proven by real runs on Windows: images end to end; image-to-video; Omni 1.2 Flash and Veo 3.1 Lite generation; 720p to 1080p download; star removal on 16:9 and 9:16 videos and images; a two-scene chain with stitching; credit quotes and balance; the library (trash with confirm, restore, rename, favorite, cover); image editing; one video edit; a real Codex session asking for a video.

Less proven: the Veo text removal (built from one clip), video editing (one run), Veo Fast/Quality, Veo in portrait, and everything on macOS and Linux.

## Development

```bash
npm run build
npm test          # 53 tests; CI runs them on Ubuntu and Windows with Node 20 and 24
```

`src/` holds the worker (`daemon.ts`, `queue.ts`, `flow.ts`), the tools (`mcp.ts`, `cli.ts`) and the modules (`library.ts`, `edit.ts`, `logo.ts`, `veomark.ts`, `media.ts`, `post.ts`, `guard.ts`, `ledger.ts`, `account.ts`, `projects.ts`, `offline.ts`, `canary.ts`, `cleanup.ts`). `skill/` and `codex/` hold the instructions the installer copies (the skill uses placeholders for paths, filled in by `npm run setup`).

## Uninstall

```bash
npm run uninstall-agent
```

Then delete this folder, `~/.flow-agent` (Chrome profile, queue, logs) and `~/flow-agent-out`.

## License

MIT: free to use, copy and change by anyone (see [LICENSE](LICENSE)). Flow's own terms still apply to what you make with Flow.
