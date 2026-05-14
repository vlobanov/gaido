# Gaido

A local-first framework for visual creative agent workflows on a node graph.

## Concept

Give a creative prompt. A coder agent writes visual code (Pixi/canvas/HTML). A renderer captures it as video. A critic agent gives feedback. Branch, fork, explore.

## Quick start

```sh
mkdir my-experiment && cd my-experiment
npx gaido init
npx gaido
```

`npx gaido` opens a node-graph UI in your browser pointing at the current directory.

## Project layout (in your cwd)

```
gaido.config.ts    # adapter config (coder, critic, renderer)
gaido.db           # SQLite, runtime state
skeletons/         # named starter presets (skeletons/<name>/{CLAUDE.md, index.html, ...})
runs/              # per-run agent workspaces and artifacts
.env               # API keys (Gemini, etc.)
```

Each root coder picks a skeleton at creation time. Project presets in
`./skeletons/<name>/` shadow global presets in `~/.gaido/skeletons/<name>/`.

## Repo layout (this monorepo)

```
apps/server  # Fastify + tRPC backend
apps/web     # Vite + React + xyflow frontend
apps/cli     # `gaido` binary
packages/core # Shared types, schema, adapter interfaces
```

## Development

```sh
pnpm install
pnpm dev           # runs server + web in parallel
pnpm typecheck
pnpm build
```
