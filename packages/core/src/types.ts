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
