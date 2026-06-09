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

System deps (only if using the bundled adapters): `claude` CLI on PATH (coder), `ffmpeg` on PATH (renderer), Chromium auto-downloaded by `playwright` postinstall.

- **Coder.** `@gaido/adapter-claude-code` exports `claudeCodeCoder({ model?, effort?, permissionMode?, bin?, extraArgs? })`. Default model `claude-sonnet-4-6`, default `permissionMode: 'bypassPermissions'`; `effort` maps to `--effort <level>`. Sessions persist on `nodes.session_id` and resume via `--resume <sessionId>` on retry. Coder writes into the worktree; orchestrator stages + commits the diff and records `runs.commit_sha`. Configs can register **multiple named coders** (`coders: { 'cc-sonnet': claudeCodeCoder({ model: 'sonnet' }), 'cc-opus': … }`); the seed picker chooses a root's coder and a config node switches it mid-graph — see "Coder selection" in `docs/graph-model.md`.
- **Renderer.** `@gaido/adapter-playwright-renderer` exports `playwrightRenderer`. Headless Chromium loads `index.html` from the worktree via a temporary localhost http server, fake clock (`page.clock.install` + `fastForward`) drives deterministic frame capture, ffmpeg encodes to mp4 (`-c:v libx264 -pix_fmt yuv420p -movflags +faststart`). Artifacts land at `<projectDir>/runs/.artifacts/<runId>/{video.mp4,thumbnail.png}`; the orchestrator inserts artifact rows and points `runs.video_artifact_id` / `runs.thumbnail_artifact_id` at them. Fastify serves them at `/artifacts/:id`. UI's `OutputPanel` (in `Sidebar.tsx`) renders `<video>` when present, else `<img>` thumbnail, else placeholder.
- **Critic.** Critique nodes run through the configured critic adapter and persist `runs.critique` JSON. See `docs/graph-model.md` for how critique nodes fit into the graph.
