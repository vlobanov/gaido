# Project rules (LESSONS.md)

`<projectDir>/LESSONS.md` accumulates rules the artist wants applied to every render in the project — generic guidance like "Never let animations pause for more than 200ms" or "Avoid pure white backgrounds." Either promoted from the critic's proposals (one click) or typed in directly (human-critic mode, or when the artist notices something the critic missed).

The file is plain markdown, lives at project root next to `gaido.config.ts`, and is created lazily on the first promotion. Absent file = no rules.

## How rules reach the coder

`apps/server/src/orchestrator.ts` reads `LESSONS.md` before each coder run and prepends its contents to the `instruction` string with a `PROJECT RULES (apply to every render in this project):` preamble.

Injection runs **only on fresh sessions** — when `node.sessionId` is null at the start of the run. Retries (and the post-coder check loop's retries within a single run) resume an existing Claude Code session via `--resume`; that session already saw the rules at turn 1, so re-sending them on every iteration would waste tokens and add noise.

The honest tradeoff: a rule promoted between turn 1 and a retry of the same node won't reach that resumed session. **Fork** instead of retry to start over with the latest rules.

Concretely, rules apply to:

- New root nodes
- Forks (always a new node with no session)
- The first attempt within a fresh node's coding phase

But not:

- Retries on a node whose `sessionId` is already set
- Subsequent attempts within the check-retry loop (same session continues)

## How rules are produced

**Auto-critic proposal.** Both `claudeCodeCritic` and `geminiCritic` ask the critic to populate `proposedRules: string[]` alongside `overall` / `strengths` / etc. The prompt is explicit: rules must be *generic*, not specific to the render under review ("Avoid pure white backgrounds" — yes; "the blue square should be slower" — no). The list lives inside the existing `runs.critique` JSON column — no schema migration.

**Manual entry.** The critique sidebar always shows an "Add a rule…" text input. Same `lessons.promote` mutation as the [Promote] buttons, same dedup. Works without any critic adapter — covers human-critic mode end-to-end.

## Dedup

`lessons.promote({rule})` normalizes each new rule against every existing line, ignoring:

- Leading bullet (`- `, `• `, `* `)
- Whitespace collapse + trim
- Case
- Trailing terminal punctuation (`.,!?;:`)

UI mirrors the same normalize so the [Promote] button shows `✓ in rules` when the rule is already there. Promotion state is *derived* from the file's contents — no separate `promoted` flag on the critique JSON.

## Where rules don't live

- Not in `skeleton/`. The skeleton seeds the bare git store on first init and never again; LESSONS.md needs to evolve across sessions.
- Not in per-node git history. Rules are project-level, not branch-level. They're injected at runtime, not committed into any coder's worktree.
- Not in `gaido.db`. The file is the source of truth — the artist can `vim LESSONS.md`, `git diff` it, share it as a regular project artifact alongside `skeleton/CLAUDE.md`.
