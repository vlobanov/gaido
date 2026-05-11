# Graph model

Gaido's graph **is** the workflow. Two node kinds alternate; a node is a slot, runs are attempts to fill it. No external workflow runtime — see `docs/conventions.md` for why.

## Two node kinds: coder & critique

`nodes.kind` discriminates. The graph alternates `coder → critique → coder → critique`.

- A coder finishing successfully auto-spawns one critique child in `status='idle'`; the user clicks to run the critic (or calls `retry` / `runCritique` from the test bridge).
- Forking a coder lands the new coder **under its critique child** — multiple forks from the same coder produce sibling coders under one shared critique.
- Direct coder-to-coder children are rejected by `createChild`.
- A partial unique index `(parent_id) WHERE kind='critique'` makes the auto-spawn idempotent across retries.

## Node ≠ Run

- A node is a slot in the graph; runs are attempts to fill it.
- `node.currentRunId` points at the latest run.
- `node.sessionId` persists the coder's session across retries (Claude Code's `--resume`).
- Each successful coder run that produces a diff stacks a commit on `node/<nodeId>`; `runs.commitSha` points back. No-diff runs intentionally produce no commit.
- Critique nodes don't have worktrees, branches, or commits — they read the parent coder's video artifact and persist `runs.critique` JSON.

## Status enum is kind-agnostic

`NodeStatus = idle | running | done | failed | cancelled | interrupted`.

The phase label (`Coding` / `Rendering` / `Critiquing`) is derived in the frontend from `kind` + `runs.{phase}_started_at` / `_finished_at`. The status enum has no phase strings.

## Versioning = git

- Per-coder git worktrees at `runs/<nodeId>/`, branch `node/<nodeId>`, all backed by a bare repo at `runs/.git`.
- Fork = `git worktree add` off the **nearest coder ancestor's tip** — the orchestrator's `resolveBranchParentId` walks past critique nodes since they have no branch.
- Retry = stack a commit (no amend).
- Free diffs / reverts / branching semantics; no homegrown snapshot store.

## Durability model

Graph survives; runs restart from parent.

On startup, `recovery.ts` flips any non-terminal run (status `running`) to `interrupted`. Pending critique nodes (status `idle`, no run) are untouched. No mid-run resume in v0; the `Renderer.render` interface accepts a `resumeHint` for adding it later without breaking the contract.
