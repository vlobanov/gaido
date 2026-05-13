import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Snapshot the Claude Code session JSONL produced by a run so a future
 * fork can resume from that exact conversation state.
 *
 * Claude Code keys session storage by cwd: it writes
 * `~/.claude/projects/<dashes-of-cwd>/<sessionId>.jsonl`, where `dashes`
 * is the absolute path with `/` replaced by `-`. We copy the active
 * session file into `runs/.session-snapshots/<runId>.jsonl` so later code
 * can move it back into a *different* cwd's project dir (the fork's
 * worktree) and call `claude --resume <sessionId>` there.
 *
 * Write-only for now — fork inheritance comes later. Best-effort: if the
 * source file doesn't exist (e.g. user changed Claude Code's storage
 * layout), the helper logs and returns; the run itself is unaffected.
 */
export interface SnapshotArgs {
  /** Absolute path of the cwd that hosted the run (= anchor's workdir). */
  workdir: string;
  /** Session id captured from the run. Skip when null. */
  sessionId: string | null;
  /** Run id used to key the snapshot. */
  runId: string;
  /** `<projectDir>/runs/` — snapshots land in `.session-snapshots/`. */
  runsDir: string;
  /** Optional override for `~`. Tests use this; default reads `os.homedir()`. */
  homeDir?: string;
  /** Called for any non-fatal complaint. Defaults to console.warn. */
  warn?: (msg: string) => void;
}

export function snapshotClaudeSession(args: SnapshotArgs): string | null {
  if (!args.sessionId) return null;
  const home = args.homeDir ?? os.homedir();
  const warn = args.warn ?? ((m: string) => console.warn(`[session-snapshot] ${m}`));

  const encoded = encodeCwdAsProjectDir(args.workdir);
  const src = path.join(home, '.claude', 'projects', encoded, `${args.sessionId}.jsonl`);
  if (!fs.existsSync(src)) {
    warn(`source not found at ${src} — skipping`);
    return null;
  }

  const snapshotDir = path.join(args.runsDir, '.session-snapshots');
  fs.mkdirSync(snapshotDir, { recursive: true });
  const dest = path.join(snapshotDir, `${args.runId}.jsonl`);
  fs.copyFileSync(src, dest);
  return dest;
}

/**
 * Reproduce Claude Code's project-dir naming: absolute path with every
 * `/` swapped for `-`, including the leading slash. Exported for tests
 * and for the future fork-restore path that'll need the inverse mapping
 * (cwd-of-new-fork → its project-dir name).
 */
export function encodeCwdAsProjectDir(absPath: string): string {
  return absPath.split('/').join('-');
}
