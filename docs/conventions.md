# Conventions

Rules to follow and choices to defend against. The graph model lives in `docs/graph-model.md`; this file is everything else.

## Working conventions

- **CWD-as-project.** The directory where `gaido` is invoked IS the project. Project state lives in `gaido.config.ts`, `gaido.db`, `skeleton/`, `runs/` — all in cwd. The only thing in `~/.gaido/` is `.env` for shared API keys (project `.env` overrides). No project-list UI; multiple projects = multiple directories.
- **`gaido.config.ts` is a real TS module.** Loaded via `jiti` at startup. Users `import { defineConfig, stubCoder, ... } from 'gaido'`. The init template uses stubs so a fresh project runs end-to-end immediately against the stub orchestrator.
- **Skeleton mechanism.** Each project has a `skeleton/` directory. The bare git store at `runs/.git` is seeded from skeleton on first run. Root nodes' worktrees branch off `main`; child nodes' worktrees branch off `node/<parentId>`'s tip. The user authors `skeleton/CLAUDE.md` etc. to give the coder agent its starting context — same lever they'd use for a human collaborator.
- **Skeleton animation `<script>` must be `type="module"`.** Pixi `app.init()` is async and we use top-level await. Default `init` template enforces this; `skeleton/CLAUDE.md` should remind the agent not to drop the attribute.
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
