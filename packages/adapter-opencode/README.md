# @vadimlobanov/gaido-adapter-opencode

[OpenCode](https://opencode.ai) CLI coder adapter for [Gaido](https://github.com/vlobanov/gaido): `opencodeCoder()`. Shells out to the `opencode` CLI on PATH — bring whatever provider you've configured in opencode (Anthropic, OpenAI, OpenRouter, or a local model via Ollama/LM Studio), no extra Gaido keys.

Re-exported by the [`gaido`](https://www.npmjs.com/package/gaido) package.

## Local models

opencode addresses models as `provider/model`. To drive a Gaido canvas with a local Ollama model, register the provider once in `~/.config/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ollama (local)",
      "options": { "baseURL": "http://localhost:11434/v1" },
      "models": { "qwen2.5-coder:1.5b": { "tools": true } }
    }
  }
}
```

then `opencodeCoder({ model: 'ollama/qwen2.5-coder:1.5b' })`. Tool-calling support in the model is required for it to edit files.

## Design notes

**It drives opencode's default output mode, not `--format json`.** opencode's
structured JSON stream hangs when opencode is spawned as a subprocess and
stdout is read line-by-line — exactly this adapter's situation
([opencode#11891](https://github.com/anomalyco/opencode/issues/11891),
[#17516](https://github.com/anomalyco/opencode/issues/17516)). So the adapter
runs the default mode (which exits cleanly and writes the worktree) and
recovers structure from two reliable side-channels instead:

- **Session id** (for `--resume`) is read live from the `--print-logs`
  `message=created id=ses_…` line on stderr.
- **Tool calls + token usage** are replayed from `opencode export <sessionId>`
  after a clean exit, and emitted as Gaido `tool_call` / `token_usage` events.
  (One consequence: those arrive at the *end* of the run, not streamed during
  it. Assistant text still streams live from stdout as `agent_token`.)
- No `costUsd` — opencode doesn't bill local / subscription / free-tier auth.

**`--dir <worktree>` is passed explicitly.** opencode resolves its project
directory from `$PWD`, not the spawned child's `cwd`, so the adapter pins the
directory to Gaido's worktree (and overwrites `PWD` in the child env to match).

**Permissions.** `skipPermissions` (default `true`) adds
`--dangerously-skip-permissions`, which is required for non-interactive `run`
to edit files — an unapproved tool is denied, never prompted, in headless mode.
Set it `false` to defer to opencode's own permission config.
