# Conventions

Rules to follow and choices to defend against. The graph model lives in `docs/graph-model.md`; this file is everything else.

## Working conventions

- **CWD-as-project.** The directory where `gaido` is invoked IS the project. Project state lives in `gaido.config.ts`, `gaido.db`, `skeletons/`, `runs/` — all in cwd. `~/.gaido/` holds shared things across projects: `.env` (API keys; project `.env` overrides) and `skeletons/` (global presets; project entries shadow on name collision). No project-list UI; multiple projects = multiple directories.
- **`gaido.config.ts` is a real TS module.** Loaded via `jiti` at startup. Users `import { defineConfig, stubCoder, ... } from 'gaido'`. The init template uses stubs so a fresh project runs end-to-end immediately against the stub orchestrator.
- **Skeleton mechanism.** Each root coder picks a *named* skeleton from `./skeletons/<name>/` (project-local) or `~/.gaido/skeletons/<name>/` (global). The bare git store at `runs/.git` is empty on init; the first root using a given skeleton lazy-creates a `seed/<name>` branch with that skeleton's contents committed. Root worktrees branch off their chosen `seed/<name>`; forked children branch off the ancestor coder's tip. The selection is stored on the root node's `skeleton_name` column; siblings on the same canvas may use different skeletons to A/B different starting contexts. `default` is the implicit fallback when none is picked.
- **Skeleton config overlay (`skeletons/<name>/gaido.skeleton.ts`).** Optional per-skeleton `defineSkeleton({...})` that layers over the project `gaido.config.ts` for every node using that skeleton (the root *and* its whole fork lineage — resolved by walking to the root's `skeleton_name`). It's a partial config: checks, render params, even adapters. **Control-plane, not content** — `git archive`-excluded from the seed commit (`workspace.ts`) so it never reaches a worktree or the art diff, and read *live* on every run by the orchestrator (`skeleton-config.ts`, mtime-cached), so edits land next run with no re-seed. Unlike `LESSONS.md` it is **not** fresh-session-gated: it controls orchestration, not prompt text, so retries see it too. Merge is **Tailwind-style** (`applySkeletonOverlay` in `packages/core/src/config.ts`): a top-level field *replaces* the project value; a field under `extend` *merges* — `postCoderChecks` appends, `render` shallow-merges. `server` and `concurrency` are process-global (bound once at startup): the type omits them and the loader throws if a JS config smuggles them in. The `default` skeleton ships a commented example.
- **Skeleton animation `<script>` must be `type="module"`.** Pixi `app.init()` is async and we use top-level await. The built-in `default` skeleton enforces this; each preset's `CLAUDE.md` should remind the agent not to drop the attribute.
- **Pluggable surface = adapters only.** Coder + critic + renderer are pluggable (`packages/core/src/adapters.ts`). Storage and node schema are hardcoded — deliberately. Don't add pluggability without a real second consumer.
- **No Temporal / Inngest.** Node graph IS the workflow. SQLite + state machine + events table is enough for local-first single-user. Adding a workflow runtime before the domain semantics settle would lock in wrong abstractions.

## Design principles

Strategic + visual direction lives in two root files:

- **PRODUCT.md** — register, users, brand personality, anti-references, design principles.
- **DESIGN.md** — visual system (seed-stage; re-run `/impeccable document` once a real surface is crafted).

Five principles to defend choices against:

1. **Lab notebook, not dashboard.**
2. **Generative-art lineage over SaaS conventions.**
3. **Generosity over density.**
4. **Honesty over polish.**
5. **The artist stays in the loop, not behind it.**

The current `apps/web` styling (zinc-950 + Inter + lucide-react) is the "yet-another-zinc dashboard" lane PRODUCT.md rejects by name. Replace, don't extend.

By-name bans: Inter, `box-shadow`, gradient text, glassmorphism, colored side-stripe borders, bounce/elastic easings.
