# Graph model

Gaido's graph **is** the workflow. Coder and critique nodes alternate (with optional config nodes spliced in); a node is a slot, runs are attempts to fill it. No external workflow runtime — see `docs/conventions.md` for why.

## Node kinds: instruction, coder, critique & config

`nodes.kind` discriminates. Every tree is rooted at an `instruction` node holding the shared prompt; each branch below it begins `config → coder`, then alternates `coder → critique → coder → critique`, with further `config` nodes spliced between a critique and the coder it spawns (`instruction → config → coder → critique → config → coder → …`).

- A coder finishing successfully auto-spawns one critique child in `status='idle'`; the user clicks to run the critic (or calls `retry` / `runCritique` from the test bridge).
- Forking a coder lands the new coder **under its critique child** — multiple forks from the same coder produce sibling coders under one shared critique.
- Direct coder-to-coder children are rejected by `createChild`.
- A partial unique index `(parent_id) WHERE kind='critique'` makes the auto-spawn idempotent across retries.
- **Legacy graphs** created before the instruction-root refactor have a bare `coder` root (`parent_id=null`). These still render (the coder card shows its instruction only for such a root); no migration is performed.

### Instruction root (single seed & batch)

An `instruction` node is a **settled marker** (`status='done'`, no run/worktree/branch/session) that holds the prompt shared by every branch beneath it — so the instruction lives in one visible place instead of being re-echoed on each coder card. Both entry points build the same shape, `instruction → config → coder`:

- **`createRoot`** (the seed modal, unchanged UX) inserts the instruction root and **one** `config → coder` branch for the picked coder+skeleton.
- **`createBatch`** (the "Batch" button / `BatchModal`) inserts one instruction root and **N** `config → coder` branches — one per (coder × skeleton) combination — so several models/skeletons run the same prompt side by side. References are shared onto every branch coder; no auto-run (it would multiply cycles across branches).

Each branch's `coder` carries its own `skeleton_name` (so the orchestrator seeds its worktree from `seed/<skeleton>` — the branch is its own anchor) and leaves `coder_name` null, inheriting the `config` marker's choice by lineage walk. The `config` marker under an instruction root reads as **"Coder"** (initial choice, `session_policy='reset'`), vs. **"Switch coder"** under a critique.

### Config nodes (mid-graph coder switch)

A `config` node records a coder/model switch made mid-graph (the `switchCoder` mutation, "Switch coder" in the critique sidebar). It's a **settled marker**: `status='done'`, no run, no worktree, no branch, no session, no artifacts — lighter than a critique node. It carries `coder_name` (the chosen registry coder) and `session_policy`:

- `retain` → the coder it spawns shares the branch anchor (`branch_anchor_id`), resuming the existing session under the new coder — like Continue. Only valid when the new coder is **session-compatible** (same adapter `kind`) and a session exists.
- `reset` → the spawned coder owns a fresh branch off the parent coder's tip — like Fork. Same code, brand-new session. The only option for an incompatible switch.

`switchCoder` inserts the config node under the critique and one coder under it (wired per policy), then runs the coder. Branch/session resolution treats config nodes as transparent, same as critiques: `resolveAncestorCoder` walks past them. The spawned coder leaves `coder_name` null and inherits the config node's choice by lineage walk (see "Coder selection" below).

### Auto-run (unattended iteration)

"Run automatically N times" drives the `coder → critique → continue` cycle itself N times with no clicks. Two columns on `nodes` carry the budget: `auto_run_total` (the requested count, constant across the chain, for the "iteration k of N" display) and `auto_run_remaining` (cycles still to complete, including the in-flight one). The orchestrator advances it:

- A coder that lands `done` while carrying a budget hands it to the critique child it just auto-spawned and runs the critic (`advanceAutoRunAfterCoder`).
- A critique that lands `done` decrements and, if cycles remain, **continues** to a new coder via the same `createContinuationCoder` helper the manual Continue uses — so auto and manual iteration are identical (resumed session, references inherited, critique feedback as the instruction). When the budget is spent the campaign ends (`advanceAutoRunAfterCritique`).

**Invariant: at most one node per chain holds a live budget — the running frontier.** The budget moves off each node as the frontier advances, and is cleared whenever a run ends anything but `done` (failure / cancel / interrupt, in `setRunStatus`), on a no-render message-only turn, and on startup recovery. So an auto-run is *not resumable* across a crash or interrupt — the artist just starts a new one, which is the intended contract.

Entry points: the seed modal (`createRoot({ autoRun })`) and `autoRun({ nodeId, iterations })` from any leaf (a critique, or a coder — a done coder forwards to its critique child without re-coding; a non-`done` leaf coder re-runs as cycle 1). Interrupt via `interruptAuto({ nodeId, mode })`: `'after'` clears the budget so the in-flight step finishes then stops; `'now'` also aborts it. Both find the frontier from any node in the chain (`findAutoRunFrontier`). Auto-run needs a **model critic** — a `human` critic can't drive the loop, so the control is hidden and the mutations reject it.

## Coder selection

The config holds a **named coder registry** (`coders: Record<string, Coder>`, or a single `coder` registered as `"default"` — `resolveCoderRegistry` in `packages/core`). A node's effective coder is the first non-null `coder_name` walking up its parent chain, else the registry default — the same inherit-down-lineage shape as `skeleton_name`. `coder_name` is set only where a coder is *chosen*:

- **Root config nodes** — the coder+skeleton picked in the seed modal (`createRoot`) or per-branch in `createBatch`, recorded on the `config` marker under the instruction root. The branch coder beneath leaves `coder_name` null and inherits it.
- **Config nodes** — the mid-graph switch above.
- **Coder nodes whose model was swapped on Retry** — `retry({ coderName })` pins the new coder on the node. Gated to **session-compatible** coders when the branch has a live session (you can't resume one adapter's session under another); use a config switch for an incompatible swap.

The orchestrator resolves the coder per run (`resolveCoder`) against the effective config (project config + skeleton overlay), and records the resolved name in `runs.config_snapshot.coder.args.name`. Invariant: a node never holds a session of a different `kind` than its resolved coder — which is why the orchestrator's "resume iff `session_id` set" rule stays correct without tracking the session's kind.

## Node ≠ Run

- A node is a slot in the graph; runs are attempts to fill it.
- `node.currentRunId` points at the latest run.
- `node.sessionId` persists the coder's session across retries (Claude Code's `--resume`).
- Each successful coder run that produces a diff stacks a commit on `node/<nodeId>`; `runs.commitSha` points back. No-diff runs intentionally produce no commit.
- A coder run is two phases against one commit: **coding** (the coder writes + the orchestrator commits) then **rendering** (the renderer turns that commit into a video). A transient renderer failure fails the whole run — so the UI offers **Re-render** on a coder whose `runs.error.phase === 'rendering'` (the `rerunRender` mutation → `Orchestrator.rerunRender`). It reuses the same run and commit, clears the failure, and repeats *only* the render phase against the worktree — no new coder turn, no tokens. Gated to the branch leaf (same rule as Retry, since rendering reads the branch tip). Retry, by contrast, re-runs the coder from scratch.
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
