export type NodeStatus =
  | 'idle'
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type RunStatus = NodeStatus;

export type NodeKind = 'coder' | 'critique';

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
  coder: { kind: string; args?: unknown };
  critic: { kind: string; args?: unknown };
  renderer: { kind: string; args?: unknown };
}
