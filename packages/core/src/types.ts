export type NodeStatus =
  | 'pending'
  | 'queued'
  | 'coding'
  | 'rendering'
  | 'critiquing'
  | 'done'
  | 'interrupted'
  | 'failed'
  | 'cancelled';

export type RunStatus = NodeStatus;

export type ArtifactKind = 'code' | 'video' | 'thumbnail' | 'frame' | 'log';

export type RunPhase = 'coding' | 'rendering' | 'critiquing';

export interface Critique {
  overall: string;
  rating?: number;
  strengths: string[];
  weaknesses: string[];
  suggestions: string[];
}

export interface RunError {
  phase: RunPhase | 'startup';
  message: string;
  stack?: string;
}

export interface AdapterConfigSnapshot {
  coder: { kind: string; args?: unknown };
  critic: { kind: string; args?: unknown };
  renderer: { kind: string; args?: unknown };
}
