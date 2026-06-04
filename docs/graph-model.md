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

## References

Artist-provided inputs attached to a **coder** node so its agent can use them: pasted/dropped **images** and snapshots of **other runs** (by run id, cross-canvas). Modeled in `node_references` (`apps/server/src/references.ts` owns the lifecycle).

- **Two attach points, both feeding a coder.** Create-root modal (root seed) and the fork modal (the new coder born under a critique — "attach at the critique" resolves to *next coder*). A sidebar panel adds/removes on an already-created coder node.
- **Copy, never symlink.** A run reference is `git archive`'d from the source commit and its video keyframes are ffmpeg-extracted — both cached once under `runs/.references/` (decoupled from the source's lifecycle; the agent can't write back into another run). Images land in `runs/.references/uploads/`.
- **Materialize per run.** Before each coder run the orchestrator clears + repopulates `<worktree>/references/` from the node's current list and, on **fresh sessions only**, appends a `REFERENCES:` block naming the paths (same fresh-session rule as `LESSONS.md` — fork to surface references added to a node mid-session).
- **Git-excluded.** `commitRun` stages with `:(exclude)references`, so references stay out of the node's branch and out of forks — the diff is the art, not the inputs.
- **Inheritance = row copy.** Fork/continue copies the ancestor coder's reference *rows* (new ids) onto the child, so iteration keeps context and removal on a child is local. See `docs/lessons.md` for the parallel (project-level) rules mechanism.
