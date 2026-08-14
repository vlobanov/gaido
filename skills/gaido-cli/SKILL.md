---
name: gaido-cli
description: "Use when driving a gaido project from the command line as an agent — reading the node graph, batch-updating existing runs, creating nodes for code you edited yourself, harvesting critique feedback, promoting project rules, or reseeding skeletons. Triggers when asked to update/migrate many gaido runs at once, to add your own edit to a gaido canvas as a proper node, or to generalize artist/critic feedback into rules. Requires the project's gaido server to be running. NOT for building visual scenes as gaido's coder agent (that role gets its instructions injected per run) and not for developing the gaido framework itself."
user-invocable: true
---

# Gaido CLI — the graph from the outside

You are an agent working *next to* gaido, not inside it: the graph on the canvas was produced by gaido's own coder/critic loop, and you want to read it, edit code in it, and feed nodes back into it so the artist's normal review flow continues. The `gaido` CLI is your interface. Everything here needs the project's server running (`gaido` in the project dir, port 4288 by default) and your cwd to be the project directory (where `gaido.config.ts` lives). Override the server address with `--url http://…` or `GAIDO_URL` if needed.

Every read command takes `--json` — always use it when you're the consumer; the human format truncates.

## Orienting: read the graph

```sh
gaido canvases --json                 # canvases: { id (c_…), slug, name }
gaido tree --canvas <slug>            # whole graph shape at a glance (human format)
gaido nodes --canvas <slug> --json    # all nodes: id, parentId, kind, status, coder, artifacts, timings
gaido node <n_id> --json              # one node: full current run, critique JSON, worktreePath, logDir
gaido logs <r_id | n_id>              # a run's events.ndjson (--dir for the folder path)
gaido critiques --canvas <slug> --json# every stored critique in one dump
```

What the fields mean:

- **Kinds** alternate `instruction → config → coder → critique → coder → …`. Coders hold code + renders; critiques hold review JSON; instruction/config are settled markers (prompt, coder choice).
- **Statuses** are `idle | running | done | failed | cancelled | interrupted`.
- **Id prefixes**: `n_` node, `r_` run, `c_` canvas.
- A **leaf coder** is one nothing has continued from. Batch passes target leaf coders whose status is `done`: from `nodes --json`, keep `kind === 'coder' && status === 'done'` nodes that have no descendant coder sharing their branch — in practice, coders whose critique child has no coder children.
- `external: true` on a coder means its current run's code came from outside gaido (this flow), not from a coder agent.

## Creating a node from your own edit (fork → edit → submit)

This is how a manual/agent edit becomes a first-class node — as if a coder agent had produced it, so rendering, critique, forking, and artist review all work on it.

```sh
gaido fork <coderOrCritiqueId> -m "resize captions to the new safe-area spec" --json
# → { "nodeId": "n_…", "worktreePath": "/abs/path/runs/<canvas>/n_…" }
```

`fork` creates the new coder node in the right graph position (pointing at a coder resolves to its critique child, same as the UI) and checks out a fresh git branch off that iteration's exact commit into the worktree. No agent runs. The `-m` text is the node's card description — write what the edit *is*, the artist reads it.

Then edit files in the worktree directly. Rules of the road:

- Don't run git yourself — `submit` stages and commits for you (a manual commit would make your diff invisible to it).
- Don't touch `references/` (artist inputs, excluded from commits) or `MESSAGE.md` (coder-agent back-channel).
- Need different timing/size for the render? Drop `gaido.render.json` in the worktree root, e.g. `{"duration": 12}` (keys: duration/fps/width/height).

```sh
gaido submit <nodeId> --wait --json
```

`submit` commits the diff, renders it (headless, through the project's render queue), lands the node `done`, and auto-spawns an idle critique child for the artist. Options:

- `--wait` — poll until the render lands; exits non-zero on failure. Without it the render continues server-side.
- `--critique` — immediately run the model critic on the result (rejected when the project uses a human critic).
- `-m "…"` — update the node's description at submit time.
- A submit with **no diff** is legal: it renders the branch tip as-is.

Re-submitting the same leaf after more edits stacks another commit + run on the node. `submit` also works on any non-running **leaf** coder's worktree you edited in place — but prefer fork-first so the original stays intact.

### Batch pattern

Fire all submits without `--wait`; the server's render semaphore does the throttling:

```sh
for id in $(gaido nodes --canvas captions --json | jq -r '<filter leaf done coders>'); do
  out=$(gaido fork "$id" -m "apply new caption sizing" --json)
  # edit $(echo "$out" | jq -r .worktreePath) …
  gaido submit "$(echo "$out" | jq -r .nodeId)"
done
```

Then check outcomes with `gaido nodes --canvas captions --json` (look for `failed`) and `gaido node <id> --json` → `currentRun.error`.

## Generalizing feedback into project knowledge

For a "read all the reviews, extract general updates" pass:

1. `gaido critiques --canvas <slug> --json` — model critiques and human notes, each with `rating`, `overall`, `weaknesses`, `suggestions`, `proposedRules`.
2. Route each generalization to where it actually takes effect:

| Insight | Destination | Takes effect |
|---|---|---|
| Taste/requirement rule ("animations read too slow — target ≥ X") | `gaido lessons add "<rule>"` | Fresh coder sessions (new roots, forks). Deduped server-side. |
| Orchestration change (render size, checks, adapters) | edit `skeletons/<name>/gaido.skeleton.ts` | Next run, immediately — read live. |
| Skeleton content (CLAUDE.md brief, seed code, shared library files) | edit `skeletons/<name>/…`, then `gaido skeleton reseed <name>` | **New roots only.** Without reseed the edit does nothing at all. |

3. To propagate a skeleton/library change into *existing* branches, reseed is not enough — apply it per-leaf with the fork → edit → submit flow above. The two mechanisms are complementary: reseed fixes the future, the external pass fixes the present.

Rules must be generic ("Avoid pure white backgrounds"), never render-specific ("the blue square should be slower") — they're prepended to every fresh coder session in the project.

## Gotchas

- **Server not running** → every command fails fast with the address it tried. Start `gaido` in the project dir (backgrounded is fine).
- **Never edit `gaido.db`** or the internals under `runs/` (`.git`, `.artifacts`, `.logs`, `.references`, `.previews`) directly. Worktrees at `runs/<canvas>/<nodeId>/` are the one place you write, and only for nodes you forked (or a leaf you're deliberately resubmitting).
- **The leaf rule**: you can't submit (or retry) a coder that has continued descendants — its branch tip is a later iteration's code. Fork from the node you actually want instead.
- **`fork` needs a finished parent**: forking off a coder requires its critique child, which exists once the coder has landed a successful run.
- External nodes have no coder session. If the artist later hits Continue under your node's critique, a fresh session starts from your code with the current LESSONS.md — exactly the normal fresh-session contract.
- `gaido node <id> --json` → `currentRun.previewUrl` is a live, human-openable page for the run; artifacts (video/thumbnail) are under `runs/.artifacts/`, log streams under `runs/.logs/<runId>/`.

## What this skill is not

Working *as* gaido's coder agent (writing the scene inside a worktree during a run) needs no skill — the orchestrator injects the GAIDO PROTOCOL preamble with everything that role must know. And if the working directory is the gaido monorepo itself, read its root `CLAUDE.md` instead. For what gaido is and how a project is configured, load the `gaido` skill.
