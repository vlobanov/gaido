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
    fork(parentId, instruction): Promise
    select(nodeId | null): void
    retry(nodeId): Promise
    cancel(nodeId): Promise
    delete(nodeId): Promise
  }

  waitFor(predicate, { timeoutMs?, pollMs? }): Promise<void>
  waitForNodeStatus(nodeId, status | status[], timeoutMs?): Promise<void>
  refetch(): Promise<void>
}
```

**2. Stable `data-testid` attributes** on every clickable thing. Names by component:

| Component | Testid(s) |
|---|---|
| `EmptyState` | `empty-create-root`, `create-root-form`, `create-root-input`, `create-root-submit`, `create-root-cancel` |
| `NodeCard` | `node-card` (with `data-node-id`, `data-status`, `data-favorite`), `node-favorite-toggle` |
| `StatusBadge` | `status-badge` (with `data-status`) |
| `Sidebar` | `sidebar`, `sidebar-fork`, `sidebar-retry`, `sidebar-delete`, `fork-form`, `fork-input`, `fork-submit`, `critique-panel`, `error-panel` |
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
- **Skeleton mechanism.** Each project has a `skeleton/` directory. Root nodes' workspaces materialize from skeleton; child nodes' workspaces materialize from parent's workspace. The user authors `skeleton/CLAUDE.md` etc. to give the coder agent its starting context — same lever they'd use for a human collaborator.
- **Pluggable surface = adapters only.** Coder + critic + renderer are pluggable (`packages/core/src/adapters.ts`). Storage and node schema are hardcoded — deliberately. Don't add pluggability without a real second consumer.
- **Node ≠ Run.** A node is a slot in the graph; runs are attempts to fill it. `node.currentRunId` points at the latest. Retry replaces it; history stays in `runs` for debugging. Code inheritance is `parent → currentRun → codeArtifact → file` — never denormalize "inherited code" onto the child.
- **Durability model: graph survives, runs restart from parent.** On startup, `recovery.ts` flips any non-terminal run to `interrupted`. No mid-run resume in v0; the `Renderer.render` interface accepts a `resumeHint` for adding it later without breaking the contract.
- **No Temporal / Inngest.** Node graph IS the workflow. SQLite + state machine + events table is enough for local-first single-user. Adding a workflow runtime before the domain semantics settle would lock in wrong abstractions.

## Stack pinning, in short

- TypeScript backend (not Python). Node 20+, ESM, NodeNext.
- Drizzle (not Prisma) for SQLite — pure-TS, no Rust binary postinstall, raw-SQL escape hatch for graph CTEs, lighter for a public framework.
- tRPC v11 with WS subscriptions. End-to-end types from server to web.
- xyflow v12 for the graph. Tailwind + lucide-react for UI.
- No Next.js. Ever.

## Known leftover issues

- **`nodes.get` input naming inconsistency.** Uses `{ id }` while every other nodes procedure uses `{ nodeId }`. One-line fix server-side + one site web-side.
- **`tsconfig.json` overrides `declaration: false`** in `apps/cli` and `apps/web` to work around tRPC v11's non-portable inferred types. Fine for app packages; would matter only when publishing as libraries.
- **`pnpm dev` parallel mode** requires `apps/web/.env.local` with `VITE_GAIDO_URL=http://localhost:4288` — not auto-created on first install.

## What's still ahead

Real adapters (Claude Code coder via stdio, Gemini critic with Claude-frames fallback, Playwright + ffmpeg renderer); real orchestrator replacing the stub; per-run workspace materialization (deep copy or APFS reflink); artifact serving so the "Video will appear here" placeholder gets a real video; auto-spawn-N variations (v0.5).
