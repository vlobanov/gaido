---
name: gaido
description: "Use when working in a project that uses gaido — a local-first framework for visual creative agent workflows on a node graph (coder writes Pixi/canvas/HTML, renderer captures video, critic gives feedback, fork and explore). Triggers when a project has gaido.config.ts at its root, when the user mentions gaido by name, or when setting one up. Covers what gaido is and when it fits, the three pluggable adapters (coder/renderer/critic), skeletons, preview-server-driven renders, LESSONS.md, and how to run. NOT for developing the gaido framework itself — read the monorepo's root CLAUDE.md for that."
user-invocable: true
---

# Gaido

Local-first framework for visual creative agent workflows on a node graph. The user types a prompt, a coder agent writes a self-contained visual scene (`index.html`), a renderer captures it as video, a critic agent (or the user) reviews it. Forks branch the graph; retries stack commits. Everything is single-user, file-system-backed, runs on `http://127.0.0.1:4288`.

## When this fits

- Output is a self-contained visual scene that can load in a browser (Pixi, canvas/WebGL, pure DOM/CSS/SVG).
- The work shape is branching exploration — try N variations, compare, fork the winner.
- Local, single-user, on one machine.

## When it doesn't fit

- Non-visual workflows (chat agents, code review, data extraction). Wrong tool.
- Multi-user / hosted. Gaido is single-user, cwd-as-project.
- Anything needing an external workflow runtime (Temporal, Inngest). The node graph IS the workflow — adding a runtime locks in wrong abstractions.
- Long-form video. The renderer is tuned for short loops (default 5s, 30fps, 1024² ).

## The three adapters

A gaido project is a `gaido.config.ts` that wires three pluggable adapters. Everything else (storage, schema, the graph itself) is deliberately hardcoded.

| Slot | Stock options (import from `gaido`) | Notes |
|---|---|---|
| **coder** | `claudeCodeCoder()`, `stubCoder()` | Mutates files in a per-node git worktree. Claude Code adapter resumes session across retries via `--resume <sessionId>`. |
| **renderer** | `playwrightRenderer()` (default), `playwrightRecordRenderer()`, `stubRenderer()` | Loads the workdir in headless Chromium, captures video + thumbnail. |
| **critic** | `geminiCritic()` (via OpenRouter), `claudeCodeCritic()`, `humanCritic()`, `stubCritic()` | Reviews video. Returns `Critique` JSON with `overall`, `rating`, `strengths`, `weaknesses`, `suggestions`, `proposedRules`. `humanCritic` returns nothing — the artist evaluates manually. |

Minimal config:

```ts
import { defineConfig, claudeCodeCoder, playwrightRenderer, geminiCritic } from 'gaido';

export default defineConfig({
  name: 'My project',
  coder: claudeCodeCoder(),
  renderer: playwrightRenderer(),
  critic: geminiCritic(),

  render: { width: 1024, height: 1024, fps: 30, duration: 5 },
  concurrency: { agents: 8, renderers: 2 },
  server: { port: 4288, openBrowser: true },
});
```

System dependencies:
- `claude` CLI on PATH — for `claudeCodeCoder` / `claudeCodeCritic`.
- `ffmpeg` + `ffprobe` on PATH — both renderers.
- `OPENROUTER_API_KEY` in `<project>/.env` or `~/.gaido/.env` — for `geminiCritic` (project values win).
- Chromium auto-installs via the `playwright` postinstall.

## Skeletons

Each root coder picks a *named* skeleton — a folder of seed files that initializes the worktree. Required files: `index.html` (the scene) and `CLAUDE.md` (project conventions for the coder agent — output requirements, style, traps).

- Project-local: `./skeletons/<name>/`
- Global (shared): `~/.gaido/skeletons/<name>/`
- Project entries shadow global on name collision. `default` is the implicit fallback.
- `gaido init` scaffolds two: `default` (Pixi v8 via CDN) and `css` (pure DOM/CSS/SVG).

Under the hood: the first root using a given skeleton lazy-creates a `seed/<name>` branch in `runs/.git` with the skeleton's contents committed. Root worktrees branch off `seed/<name>`; forks branch off the parent coder's tip. Siblings on one canvas can use different skeletons to A/B different starting contexts.

To add a new skeleton: create `./skeletons/<name>/` with at minimum `index.html` and `CLAUDE.md`. No registration step — it appears in the root-creation picker immediately.

### Skeleton `CLAUDE.md` essentials

This file is the coder agent's brief. Keep it short and explicit. Always remind the agent:

- Animation `<script>` must be `type="module"` (Pixi's `app.init()` is async; the seed uses top-level await). Drop the attribute → SyntaxError → black render.
- All assets inline or from a stable CDN. No local file deps.
- The scene must loop or play out within the configured duration.

### Per-skeleton config overlay (optional)

Drop a `gaido.skeleton.ts` in a skeleton folder to layer config over the project's `gaido.config.ts` for every node that uses that skeleton (the root *and* its forks). Use it when a skeleton produces a specific artifact type that wants its own checks or render dimensions.

```ts
import { defineSkeleton } from 'gaido';

export default defineSkeleton({
  extend: {
    // appended AFTER the project's postCoderChecks
    postCoderChecks: [{ name: 'has-canvas', command: ['grep', '-q', 'app.canvas', 'index.html'] }],
    // shallow-merged — keeps the project's fps/duration
    render: { width: 512, height: 512 },
  },
  // a top-level field REPLACES the project value, e.g. a stricter critic here:
  // critic: myCritic(),
});
```

- **Tailwind-style merge:** a top-level field *replaces* the project value; under `extend` it *merges* — `postCoderChecks` appends, `render` shallow-merges. It's a full partial config, adapters included.
- **Read live, never committed:** excluded from the worktree and the art diff; re-read on every run, so edits land on the next run (no re-seed, no restart). Unlike `LESSONS.md` it isn't fresh-session-gated — it drives orchestration, not the prompt, so retries see it too.
- **`server` and `concurrency` are rejected** (process-global — set them in `gaido.config.ts`); the loader throws if a config sets them.
- `gaido init` seeds a commented example in the `default` skeleton.

## Preview-server-driven renders (advanced)

`playwrightRenderer()` is fine for self-contained `index.html` scenes — it spins up a tiny static server over the workdir and captures frames with a fake clock.

For projects whose own dev server hosts the scene runtime (e.g., a parameter-driven engine that reads `scene.json` from a shared output dir), use `playwrightRecordRenderer()` plus a `previewServer` config:

```ts
import { defineConfig, claudeCodeCoder, playwrightRecordRenderer, geminiCritic } from 'gaido';

export default defineConfig({
  coder: claudeCodeCoder(),
  critic: geminiCritic(),
  renderer: playwrightRecordRenderer({
    urlPath: ({ runId }) => `/?scene=/runs/${runId}/scene.json`,
  }),
  previewServer: {
    command: ['pnpm', 'exec', 'serve'],
    port: 3004,
    ready: '/',                       // probed for 2xx before adapters run
    outDirEnv: 'VE_ANIMATOR_OUT_DIR', // exports the artifacts dir to the subprocess
  },
});
```

Contract the page must satisfy when driven by `playwrightRecordRenderer`:

- `window.__ready === true` once the scene mounts (or `window.__error = "<msg>"` on failure).
- `window.__recordMp4({ fps, bitrate, fileName })` exists, encodes the scene, triggers a browser download of the mp4.

Gaido spawns the preview server at startup, waits for `ready`, exposes its base URL to the renderer via `ctx.previewServerBase`, and shuts it down on exit. The resulting `previewUrl` is persisted on the run so the UI can deep-link the artist back into the live preview.

## Post-coder checks (optional)

Shell commands that run after the coder phase. On failure, combined stdout+stderr is fed back to the coder as the next message in the resumed session, up to `checkMaxRetries` (default 3) attempts:

```ts
postCoderChecks: [
  { name: 'typecheck', command: ['pnpm', 'exec', 'tsc', '--noEmit'], cwd: 'workdir' },
],
```

`cwd: 'workdir'` (default) runs in the node's worktree; `'project'` runs in the project root.

## LESSONS.md (project-wide rules)

`<projectDir>/LESSONS.md` is plain markdown. The orchestrator prepends it to the coder's instruction on **fresh sessions only**: new roots, forks, and the first attempt in a fresh node's coding phase. Retries and post-coder-check follow-ups resume an existing Claude Code session, so re-sending the rules would waste tokens — the session already saw them at turn 1.

The honest tradeoff: a rule added between turn 1 and a retry won't reach that resumed session. **Fork** instead of retry to pick up the latest rules.

Critics propose generic rules in their `proposedRules` field; the critique sidebar surfaces them with one-click [Promote] buttons (dedup against existing lines, ignoring bullets/whitespace/case/trailing punctuation). There's also an "Add a rule…" input for manual entry. Don't put scene-specific feedback here — the file is for project-level conventions ("Avoid pure white backgrounds"), not "the blue square should be slower".

## Running

```sh
gaido init        # one-time: scaffolds gaido.config.ts, skeletons/{default,css}/, .gitignore, .env.example
cp .env.example .env
# fill in OPENROUTER_API_KEY if using geminiCritic
gaido             # starts server, opens http://127.0.0.1:4288
```

`gaido` with no args is the same as `gaido serve`. To stop a stuck server: `lsof -ti :4288 | xargs -r kill`.

If `gaido` is not on PATH, run via the project's package manager (`pnpm exec gaido`, `npx gaido`, etc.). The CLI requires `gaido` as a dependency in the project's `package.json`.

## File layout in a gaido project

```
gaido.config.ts        adapter wiring, render settings, server port
gaido.db               SQLite — graph state, runs, events (don't edit by hand)
gaido.db-{wal,shm}     SQLite WAL files (gitignored)
.env                   API keys (gitignored)
.env.example
.gitignore
LESSONS.md             optional; project-wide rules prepended to fresh coder sessions
skeletons/
  <name>/
    CLAUDE.md          conventions for the coder agent
    index.html         seed scene
    gaido.skeleton.ts  optional; per-skeleton config overlay (excluded from worktrees)
    (any other seed files)
runs/                  gitignored
  .git/                bare git store; per-skeleton seed/<name> branches, per-node node/<id> branches
  <nodeId>/            checked-out worktree for that node
  .artifacts/<runId>/  video.mp4, thumbnail.png
  .logs/<runId>/       events.ndjson + raw coder/renderer subprocess logs
```

`gaido.db` and `runs/` are runtime state. The git history under `runs/.git` is the source of truth for code diffs.

## Driving the UI from tests

If the project needs end-to-end testing via Playwright MCP, load the `playwright-testing` skill — it documents the `window.__gaido` debug bridge (`trigger.createRoot`, `trigger.fork`, `trigger.runCritique`, `waitForNodeStatus`, etc.) and the stable `data-testid` map.

## Quick gotchas

- **`<script type="module">` is non-negotiable** in skeletons that use top-level await (Pixi). Each skeleton's `CLAUDE.md` should remind the coder.
- **No "template" terminology** in framework vocab. Use project / canvas / graph / node / skeleton. "Template" is a different concept that belongs to a downstream product, not the framework.
- **Critique nodes have no worktree, branch, or commits.** They just read the parent coder's video artifact and persist `runs.critique` JSON. Don't try to fork off a critique directly — fork off the coder.
- **Fork, don't retry, to pick up new LESSONS.md rules.** Retries resume the existing session.
- **CWD is the project.** No project-list UI, no global registry. Multiple projects = multiple directories.

## When you're developing gaido itself, not using it

This skill is for working IN a project that *uses* gaido. If the working directory IS the gaido monorepo (apps/server, apps/web, apps/cli, packages/core + adapter packages), read the monorepo's root `CLAUDE.md` instead — it imports `docs/architecture.md`, `docs/graph-model.md`, `docs/conventions.md`, `docs/lessons.md` for the deep cut on internals.
