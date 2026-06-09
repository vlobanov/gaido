export type NodeStatus =
  | 'idle'
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type RunStatus = NodeStatus;

export type NodeKind = 'coder' | 'critique' | 'config';

/**
 * Session handling for the coder spawned beneath a config node (and for the
 * config node's own record of what it did):
 * - `retain` — resume the branch's existing coder session under the new coder.
 *   Only valid when the new coder is session-compatible (same adapter `kind`)
 *   with the session being resumed. Wired like Continue (shared branch anchor).
 * - `reset`  — start a fresh session from the current code. Wired like Fork
 *   (own branch off the ancestor coder's tip). The only option for an
 *   incompatible switch (e.g. claude-code → a different tool).
 */
export type SessionPolicy = 'retain' | 'reset';

export type ArtifactKind = 'code' | 'video' | 'thumbnail' | 'frame' | 'log';

export type RunPhase = 'coding' | 'rendering' | 'critiquing';

export interface Critique {
  overall: string;
  rating?: number;
  strengths: string[];
  weaknesses: string[];
  suggestions: string[];
  /**
   * Generic rules the critic believes should apply to every future render in
   * this project. Surfaced in the UI with one-click promotion to LESSONS.md.
   * Optional so older runs (and human-only critics) round-trip cleanly.
   */
  proposedRules?: string[];
}

export interface RunError {
  phase: RunPhase | 'startup';
  message: string;
  stack?: string;
  /**
   * Set when the run failed because post-coder validation checks exhausted
   * their retry budget. Lets the UI render which check failed and the last
   * captured output, distinct from a generic exception.
   */
  validation?: {
    check: string;
    attempts: number;
    output: string;
  };
}

export interface AdapterConfigSnapshot {
  /** `args.name` records which named coder from the registry actually ran. */
  coder: { kind: string; args?: { name?: string } };
  critic: { kind: string; args?: unknown };
  renderer: { kind: string; args?: unknown };
}
