# Gaido — project notes for Claude

Local-first framework for visual creative agent workflows on a node graph. A coder agent generates visual code (Pixi/canvas/HTML), a renderer captures it as video, a critic agent gives feedback, and the whole exploration is shown as a forkable xyflow graph. Eventual two use cases: open-ended creative-exploration and videoeffects.com production templates with senior-artist review.

This file is the orientation. Architecture rationale lives below; code is the source of truth for *how*.

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
- `pnpm exec gaido init` (in an empty dir) — scaffolds `gaido.config.ts`, `skeleton/`, `.gitignore`, `.env.example`
- `lsof -ti :4288 | xargs -r kill` — stop a stuck server

## Frontend test interface (how to drive the UI)

Two complementary primitives, both already wired up:

**1. `window.__gaido`** — installed by `apps/web/src/lib/debug.tsx` (`<DebugBridge />` mounted in `App.tsx`). API surface:

```ts
window.__gaido = {
  nodes(): NodeRow[]                      // current cached nodes.list result
  selectedNodeId(): string | null         // zustand store

  events: PersistedEvent[]                // 500-item ring buffer from a global ws subscription

  trigger: {
    createRoot(instruction): Promise
    fork(coderNodeId, instruction): Promise   // waits for coder→done, lands new coder under its critique child
    runCritique(critiqueNodeId): Promise      // start an idle critique's first run (thin wrapper over retry)
    select(nodeId | null): void
    retry(nodeId): Promise
    cancel(nodeId): Promise
    delete(nodeId): Promise
  }

  critiqueChildOf(coderNodeId): NodeRow | null

  waitFor(predicate, { timeoutMs?, pollMs? }): Promise<void>
  waitForNodeStatus(nodeId, status | status[], timeoutMs?): Promise<void>
  refetch(): Promise<void>
}
```

**2. Stable `data-testid` attributes** on every clickable thing. Names by component:

| Component | Testid(s) |
|---|---|
| `EmptyState` | `empty-create-root`, `create-root-form`, `create-root-input`, `create-root-submit`, `create-root-cancel` |
| `CoderCard` / `CritiqueCard` | `node-card` (with `data-node-id`, `data-node-kind` = `coder`\|`critique`, `data-status`, `data-favorite`), `node-favorite-toggle`, `critique-run` (idle critique's "Run critic" button) |
| `StatusBadge` | `status-badge` (with `data-status`) |
| `Sidebar` | `sidebar`, `sidebar-fork` (coder only), `sidebar-retry`, `sidebar-delete`, `fork-form`, `fork-input`, `fork-submit`, `critique-panel` (critique sidebar only), `error-panel` |
| `Toolbar` | `toolbar` |
| `EventStream` | `event-stream`, `event-row` (with `data-event-kind`) |

**Pattern that works well with Playwright MCP:**

- **Drive via UI clicks** — `getByTestId('empty-create-root').click()`, then type into `create-root-input`, click `create-root-submit`. Exercises the full stack.
- **Assert state via `__gaido`** — `await page.evaluate(() => window.__gaido.nodes())`. Less brittle than DOM scraping, types via `inferRouterOutputs<AppRouter>`.
- **Set up state quickly via `__gaido.trigger.*`** — bypass the UI when you just need a node to exist before testing something else.
- **`__gaido.events`** captures every server event so you can assert subscriptions are firing without inspecting the EventStream DOM.

Console should stay clean — verify with `mcp__playwright__browser_console_messages` at `level: "warning"`.

## Conventions worth knowing

- **CWD-as-project.** The directory where `gaido` is invoked IS the project. Project state lives in `gaido.config.ts`, `gaido.db`, `skeleton/`, `runs/` — all in cwd. The only thing in `~/.gaido/` is `.env` for shared API keys (project `.env` overrides). No project-list UI; multiple projects = multiple directories.
- **`gaido.config.ts` is a real TS module.** Loaded via `jiti` at startup. Users `import { defineConfig, stubCoder, ... } from 'gaido'`. The init template uses stubs so a fresh project runs end-to-end immediately against the stub orchestrator.
- **Skeleton mechanism.** Each project has a `skeleton/` directory. The bare git store at `runs/.git` is seeded from skeleton on first run. Root nodes' worktrees branch off `main`; child nodes' worktrees branch off `node/<parentId>`'s tip. The user authors `skeleton/CLAUDE.md` etc. to give the coder agent its starting context — same lever they'd use for a human collaborator.
- **Pluggable surface = adapters only.** Coder + critic + renderer are pluggable (`packages/core/src/adapters.ts`). Storage and node schema are hardcoded — deliberately. Don't add pluggability without a real second consumer.
- **Two node kinds: coder & critique.** `nodes.kind` discriminates. The graph alternates `coder → critique → coder → critique`. A coder finishing successfully auto-spawns one critique child in `status='idle'`; the user clicks to run the critic (or calls `retry`/`runCritique` from the test bridge). Forking a coder lands the new coder *under its critique child* — multiple forks from the same coder produce sibling coders under one shared critique. Direct coder-to-coder children are rejected by `createChild`. A partial unique index `(parent_id) WHERE kind='critique'` makes the auto-spawn idempotent across retries.
- **Node ≠ Run.** A node is a slot in the graph; runs are attempts to fill it. `node.currentRunId` points at the latest. `node.sessionId` persists the coder's session across retries (Claude Code's `--resume`). Each successful coder run that produces a diff stacks a commit on `node/<nodeId>`; `runs.commitSha` points back. No-diff runs intentionally produce no commit. Critique nodes don't have worktrees, branches, or commits — they read the parent coder's video artifact and persist `runs.critique` JSON.
- **Status enum is kind-agnostic.** `NodeStatus = idle | running | done | failed | cancelled | interrupted`. The phase label (`Coding`/`Rendering`/`Critiquing`) is derived in the frontend from `kind` + `runs.{phase}_started_at` / `_finished_at`. Status enum has no phase strings.
- **Versioning = git.** Per-coder git worktrees at `runs/<nodeId>/`, branch `node/<nodeId>`, all backed by a bare repo at `runs/.git`. Fork = `git worktree add` off the nearest coder ancestor's tip (the orchestrator's `resolveBranchParentId` walks past critique nodes since they have no branch). Retry = stack a commit (no amend). Free diffs / reverts / branching semantics; no homegrown snapshot store.
- **Durability model: graph survives, runs restart from parent.** On startup, `recovery.ts` flips any non-terminal run (status `running`) to `interrupted`. Pending critique nodes (status `idle`, no run) are untouched. No mid-run resume in v0; the `Renderer.render` interface accepts a `resumeHint` for adding it later without breaking the contract.
- **No Temporal / Inngest.** Node graph IS the workflow. SQLite + state machine + events table is enough for local-first single-user. Adding a workflow runtime before the domain semantics settle would lock in wrong abstractions.

## Stack pinning, in short

- TypeScript backend (not Python). Node 20+, ESM, NodeNext.
- Drizzle (not Prisma) for SQLite — pure-TS, no Rust binary postinstall, raw-SQL escape hatch for graph CTEs, lighter for a public framework.
- tRPC v11 with WS subscriptions. End-to-end types from server to web.
- xyflow v12 for the graph. Tailwind + lucide-react for UI.
- No Next.js. Ever.

## Known leftover issues

- **`tsconfig.json` overrides `declaration: false`** in `apps/cli` and `apps/web` to work around tRPC v11's non-portable inferred types. Fine for app packages; would matter only when publishing as libraries.
- **`pnpm dev` parallel mode** requires `apps/web/.env.local` with `VITE_GAIDO_URL=http://localhost:4288` — not auto-created on first install.

## What's still ahead

Auto-spawn-N variations (v0.5); multi-critic comparisons (one coder, several critique siblings each from a different critic adapter).

Shipped:

- **Critique as separate node kind.** See "Conventions worth knowing." Replaced the run-time critique JSON-only model.
- **Coder.** `@gaido/adapter-claude-code` exports `claudeCodeCoder`. Default model `claude-sonnet-4-6`, default `permissionMode: 'bypassPermissions'`. Sessions persist on `nodes.session_id` and resume via `--resume <sessionId>` on retry. Coder writes into the worktree; orchestrator stages + commits the diff and records `runs.commit_sha`.
- **Renderer.** `@gaido/adapter-playwright-renderer` exports `playwrightRenderer`. Headless Chromium loads `index.html` from the worktree via a temporary localhost http server, fake clock (`page.clock.install` + `fastForward`) drives deterministic frame capture, ffmpeg encodes to mp4 (`-c:v libx264 -pix_fmt yuv420p -movflags +faststart`). Artifacts land at `<projectDir>/runs/.artifacts/<runId>/{video.mp4,thumbnail.png}`; the orchestrator inserts artifact rows and points `runs.video_artifact_id` / `runs.thumbnail_artifact_id` at them. Fastify serves them at `/artifacts/:id`. UI's `OutputPanel` (in `Sidebar.tsx`) renders `<video>` when present, else `<img>` thumbnail, else placeholder.
- **Skeleton convention.** The skeleton's animation `<script>` MUST be `type="module"` — pixi `app.init()` is async and we use top-level await. Default `init` template enforces this; `skeleton/CLAUDE.md` should remind the agent not to drop the attribute.

System deps (only if using these adapters): `claude` CLI on PATH (coder), `ffmpeg` on PATH (renderer), Chromium auto-downloaded by `playwright` postinstall.

## Design Context

Strategic + visual direction lives in two root files:

- **PRODUCT.md** — register, users, brand personality, anti-references, design principles.
- **DESIGN.md** — visual system (seed-stage; re-run `/impeccable document` once a real surface is crafted).

Five principles to defend choices against:

1. **Lab notebook, not dashboard.**
2. **Generative-art lineage over SaaS conventions.**
3. **Generosity over density.**
4. **Honesty over polish.**
5. **The artist stays in the loop, not behind it.**

The current `apps/web` styling (zinc-950 + Inter + lucide-react) is the "yet-another-zinc dashboard" lane PRODUCT.md rejects by name. Replace, don't extend. By-name bans: Inter, `box-shadow`, gradient text, glassmorphism, colored side-stripe borders, bounce/elastic easings.
