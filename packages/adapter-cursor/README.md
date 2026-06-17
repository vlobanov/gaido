# @vadimlobanov/gaido-adapter-cursor

[Cursor](https://cursor.com/cli) CLI coder adapter for [Gaido](https://github.com/vlobanov/gaido): `cursorCoder()`. Shells out to the `cursor-agent` CLI on PATH — bring your Cursor account (run `cursor-agent login` once); Gaido holds no keys.

Re-exported by the [`gaido`](https://www.npmjs.com/package/gaido) package.

## Usage

```ts
import { defineConfig, cursorCoder, playwrightRenderer, geminiCritic } from 'gaido';

export default defineConfig({
  coder: cursorCoder({ model: 'auto' }),
  renderer: playwrightRenderer(),
  critic: geminiCritic(),
});
```

`model` is optional — omit it to use your account default. Discover valid ids with `cursor-agent models` (or `cursor-agent --list-models`); short aliases like `sonnet-4` also work.

## Models & effort

Unlike the other coder adapters, **there is no `effort` option**: Cursor encodes the reasoning/thinking level directly in the model id. Pick the variant you want:

- `auto` — let Cursor choose
- `gpt-5.3-codex-low` / `gpt-5.3-codex-high` / `gpt-5.3-codex-xhigh`
- `claude-opus-4-8-thinking-high`
- `gpt-5.5-high`, …

## Design notes

**It drives `--output-format stream-json`.** `cursor-agent` prints one JSON
event per line (`system`/`init` → `user` → `tool_call` (started/completed) →
`assistant` → `result`), modeled closely on Claude Code's stream format. The
adapter parses it line-by-line and emits Gaido events:

- **Session id** is the `session_id` carried on every event — it doubles as the
  resumable `chatId`. Persisted by the orchestrator and replayed on retry as
  `--resume <chatId>`.
- **Assistant text** streams live as `agent_token`.
- **Tool calls** become `tool_call` events. Cursor wraps each as
  `{ "<name>ToolCall": { args } }`, so the tool name is the key (`editToolCall`
  → `edit`, `readToolCall` → `read`, …).
- **Token usage** rides the final `result` event
  (`inputTokens`/`outputTokens`/`cacheReadTokens`/`cacheWriteTokens`) and is
  emitted as a closing `token_usage`. No `costUsd` — login/subscription auth
  doesn't report billed dollars (same as the codex and opencode adapters).

**Permissions.** `force` (default `true`) adds `--force` **and** `--trust`,
which are both required for non-interactive edits in a fresh Gaido worktree —
without them `cursor-agent` blocks on approval/trust prompts that never arrive
in a non-tty subprocess. Set `force: false` to defer to cursor-agent's own
handling.

**`--workspace <worktree>` is passed explicitly**, and `-w/--worktree` is
never used: Gaido manages its own git worktrees, so cursor-agent must operate
in place rather than spinning up its own under `~/.cursor/worktrees/`.

**Different adapter `kind` (`'cursor'`)** from the claude-code, codex and
opencode adapters, so switching to/from it mid-graph is the session-incompatible
path (a config-node reset starts a fresh session). See the Gaido graph-model
docs.
