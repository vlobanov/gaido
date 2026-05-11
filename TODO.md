# TODO

Known leftover issues and ahead-of-me work. Not strict priority order.

## Known leftover issues

- **`tsconfig.json` overrides `declaration: false`** in `apps/cli` and `apps/web` to work around tRPC v11's non-portable inferred types. Fine for app packages; would matter only when publishing as libraries.
- **`pnpm dev` parallel mode** requires `apps/web/.env.local` with `VITE_GAIDO_URL=http://localhost:4288` — not auto-created on first install.

## Still ahead

- **Auto-spawn-N variations** (v0.5). Create several coder siblings under one critique from a single user instruction.
- **Multi-critic comparisons.** One coder, several critique siblings each from a different critic adapter.
- **Dockerize coder adapters** for sandboxing. Wrap the `spawn('claude', …)` / Codex calls in `docker run` with the worktree bind-mounted at `/work` and a writable credentials volume. Gotchas: Claude Code on macOS stores OAuth in Keychain by default (need a one-time export to file, or `claude /login` inside a long-lived container to seed the volume); session resume requires a stable container cwd so `~/.claude/projects/<encoded-cwd>/` lines up across runs; per-run cold start adds ~1–3s on macOS (switch to long-lived container + `docker exec` if it becomes painful). Doesn't defend against the agent itself exfiltrating the mounted credential — a token-broker sidecar would, if that ever matters. Adapter shape: add an optional `docker: { image, mounts }` to `claudeCodeCoder` config; stdout/stderr stream through unchanged.
