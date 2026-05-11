# TODO

Known leftover issues and ahead-of-me work. Not strict priority order.

## Known leftover issues

- **`tsconfig.json` overrides `declaration: false`** in `apps/cli` and `apps/web` to work around tRPC v11's non-portable inferred types. Fine for app packages; would matter only when publishing as libraries.
- **`pnpm dev` parallel mode** requires `apps/web/.env.local` with `VITE_GAIDO_URL=http://localhost:4288` — not auto-created on first install.

## Still ahead

- **Auto-spawn-N variations** (v0.5). Create several coder siblings under one critique from a single user instruction.
- **Multi-critic comparisons.** One coder, several critique siblings each from a different critic adapter.
