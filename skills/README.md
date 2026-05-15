# Skills

Skills that ship with gaido. Symlinked into downstream projects so AI coding
agents (Claude Code, Codex, etc.) have the right context when working in a
project that uses gaido.

These are **public artifacts** — they're meant to be discovered and consumed
by downstream agents. The repo's own internal skills (used when developing
gaido itself) live under `.claude/skills/` instead.

## Catalog

| Skill | For |
|---|---|
| `gaido/` | Orientation primer for an agent working in a project that uses gaido. Covers what gaido is, the three pluggable adapters (coder/renderer/critic), skeletons, preview-server renders, `LESSONS.md`, and how to run. |

## Installing into a downstream project

`gaido init` prompts for symlink paths. Pick whichever locations your agent
reads — common ones are `.claude/skills/gaido` (Claude Code) and
`.skills/gaido` (Codex / generic).

Or symlink manually:

```sh
ln -s /path/to/gaido/skills/gaido <your-project>/.claude/skills/gaido
```

Symlinks (not copies) so the skill stays in sync as gaido evolves.
