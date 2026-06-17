# Architecture

## Repo layout

pnpm workspace, ESM throughout, TypeScript strict.

```
apps/server     Fastify + tRPC v11 + Drizzle/SQLite. Owns graph state and the orchestrator.
apps/web        Vite + React 18 + xyflow + tRPC client. Talks to the server over HTTP+WS.
apps/cli        Public package name "gaido". `gaido init`, `gaido` (= serve).
packages/core   Schema, types, adapter interfaces, event payload union, defineConfig, ID utils, stub adapters.
test-project/   Dev fixture (workspace member) — not part of the framework. cwd Vadim uses to test the CLI.
```

Bin entry is `apps/cli/bin/gaido.mjs` — a Node ESM wrapper that programmatically registers `tsx/esm/api` then dynamic-imports `src/bin.ts`. Avoids needing `tsx` on PATH for end users; Node runs the .mjs directly.

## Run it

```sh
pnpm install
pnpm --filter @gaido/web build      # one-time UI bundle (server serves it from apps/web/dist)
cd test-project
pnpm exec gaido                     # starts server, opens browser at http://127.0.0.1:4288
```

For UI iteration: `pnpm --filter @gaido/web dev` in another terminal with `VITE_GAIDO_URL=http://127.0.0.1:4288` set in `apps/web/.env.local`.

Other useful commands:

- `pnpm -r typecheck` — runs `tsc --noEmit` across all packages
- `pnpm exec gaido init` (in an empty dir) — scaffolds `gaido.config.ts`, `skeletons/<name>/` (one folder per built-in preset), `.gitignore`, `.env.example`
- `lsof -ti :4288 | xargs -r kill` — stop a stuck server

## Stack pinning

- TypeScript backend (not Python). Node 20+, ESM, NodeNext.
- Drizzle (not Prisma) for SQLite — pure-TS, no Rust binary postinstall, raw-SQL escape hatch for graph CTEs, lighter for a public framework.
- tRPC v11 with WS subscriptions. End-to-end types from server to web.
- xyflow v12 for the graph. Tailwind + lucide-react for UI.
- No Next.js. Ever.

## Adapters in use

System deps (only if using the bundled adapters): `claude` CLI on PATH (coder), `codex` CLI on PATH (only for `codexCoder`), `opencode` CLI on PATH (only for `opencodeCoder`), `ffmpeg` on PATH (renderer), Chromium installed once via `npx playwright install chromium` (the `playwright` package no longer downloads browsers on install).

- **Coder.** `@vadimlobanov/gaido-adapter-claude-code` exports `claudeCodeCoder({ model?, effort?, permissionMode?, bin?, extraArgs? })`. Default model `claude-sonnet-4-6`, default `permissionMode: 'bypassPermissions'`; `effort` maps to `--effort <level>`. Sessions persist on `nodes.session_id` and resume via `--resume <sessionId>` on retry. Coder writes into the worktree; orchestrator stages + commits the diff and records `runs.commit_sha`. Configs can register **multiple named coders** (`coders: { 'cc-sonnet': claudeCodeCoder({ model: 'sonnet' }), 'cc-opus': … }`); the seed picker chooses a root's coder and a config node switches it mid-graph — see "Coder selection" in `docs/graph-model.md`.
- **Coder (Codex).** `@vadimlobanov/gaido-adapter-codex` exports `codexCoder({ model?, effort?, sandboxMode?, bin?, extraArgs? })` (kind `'codex'`, needs `codex` on PATH). Spawns `codex exec --json` and parses the JSONL stream (`thread.started` → session id, `item.*` → `tool_call`/`agent_token`, `turn.completed` → `token_usage`; no `costUsd` — subscription auth doesn't report cost). Model defaults to the user's `~/.codex/config.toml`; `effort` maps to `-c model_reasoning_effort=…`; `sandboxMode` defaults to `'workspace-write'` (use `'danger-full-access'` for the bypassPermissions analog — workspace-write denies network). Resume = `codex exec resume <threadId>`, which lacks `-s`, so sandbox always rides `-c sandbox_mode=…`. Different `kind` than claude-code, so switching between them is the session-incompatible path (config-node reset).
- **Coder (OpenCode).** `@vadimlobanov/gaido-adapter-opencode` exports `opencodeCoder({ model?, effort?, agent?, skipPermissions?, bin?, extraArgs? })` (kind `'opencode'`, needs `opencode` on PATH). Unlike the other two it drives opencode's **default** output mode, not `--format json` — that stream hangs when opencode is spawned as a subprocess (opencode#11891/#17516). So it harvests structure from side-channels: session id from the `--print-logs` `message=created id=ses_…` stderr line, and `opencode export <sessionId>` after a clean exit replays the session's `tool_call`s + a closing `token_usage` (no `costUsd` — local/subscription/free-tier auth doesn't bill). Assistant text streams live from stdout as `agent_token`. `model` is opencode's `provider/model` (`opencode/*` free hosted models need no auth; `ollama/<model>` for local; or any provider configured in opencode's own config — Gaido holds no keys); `effort` maps to `--variant <level>`; `skipPermissions` (default true) adds `--dangerously-skip-permissions` (required for headless edits). **`--dir <worktree>` is passed explicitly** because opencode derives its project dir from `$PWD`, not the spawn `cwd`, and the orchestrator's `$PWD` is the project root. Resume = `--session <id>`. Different `kind` than the others, so switching to/from it is the session-incompatible path (config-node reset).
- **Renderer.** `@vadimlobanov/gaido-adapter-playwright-renderer` exports `playwrightRenderer`. Headless Chromium loads `index.html` from the worktree via a temporary localhost http server, fake clock (`page.clock.install` + `fastForward`) drives deterministic frame capture, ffmpeg encodes to mp4 (`-c:v libx264 -pix_fmt yuv420p -movflags +faststart`). Artifacts land at `<projectDir>/runs/.artifacts/<runId>/{video.mp4,thumbnail.png}`; the orchestrator inserts artifact rows and points `runs.video_artifact_id` / `runs.thumbnail_artifact_id` at them. Fastify serves them at `/artifacts/:id`. UI's `OutputPanel` (in `Sidebar.tsx`) renders `<video>` when present, else `<img>` thumbnail, else placeholder.
- **Critic.** Critique nodes run through the configured critic adapter and persist `runs.critique` JSON. See `docs/graph-model.md` for how critique nodes fit into the graph.

## Concurrency throttling

`concurrency: { agents, renderers }` in `gaido.config.ts` (defaults 8/2) caps how many phases run at once, process-wide. `agents` gates the LLM phases — coding and critiquing both spawn an agent subprocess; `renderers` gates render phases (headless Chromium + ffmpeg). Enforced by two FIFO semaphores in the orchestrator (`semaphore.ts`): `runPhase` acquires the phase's slot *before* stamping `*_started_at` and emitting `phase_start`, so queue wait never counts toward phase durations and the UI derives a "Queued" badge from `status='running'` with no phase in flight. Cancelling a queued run just removes its waiter — it never held a slot. Process-global like `server`: bound once at startup, not overridable per skeleton (the overlay loader rejects it).

## Live preview of a run

Two different servers can put a *human-openable* live page behind a run's "Open live preview" link (`runs.preview_url`, surfaced in `CoderCard`/`Sidebar`). Both are distinct from the renderer's own ephemeral static server — the random-port `http` server `playwrightRenderer` spins up per render to feed headless Chromium, then tears down.

- **`previewServer` (project-provided, optional).** A long-lived dev server the *project* supplies (`previewServer.command`), spawned at startup. For the record renderer (drives Playwright against the project's harness) and for `publicUrl(...)`, which maps a run to a URL behind the project's own server/tunnel. See `PreviewServerConfig`.
- **`staticPreview` (built-in, on by default).** `static-preview-server.ts` — a gaido-owned long-lived static server on its own port (`server.port + 1` by default). Routes by `Host`: `http://<runId-without-r_>.<canvasSlug>.localhost:<port>/`. Per-run subdomain origins so a static site's root-absolute asset URLs (`/assets/app.js`) resolve without rewriting — that's *why* it's subdomain- not path-routed. On first request it `git archive`s the run's commit (or the node's branch tip for a no-diff run) into `runs/.previews/<commit>/` — cached, deduped by commit, the same archive-a-commit pattern as references. `*.localhost` → loopback works in Chrome/Firefox out of the box; Safari / the macOS resolver may need an `/etc/hosts` entry. Process-global (omitted from skeleton overlays, rejected by the loader). The orchestrator auto-fills `preview_url` with this when the project supplies neither a `publicUrl` nor a renderer `previewUrl` — so a plain static site is explorable per-run with zero config.
