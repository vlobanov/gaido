import type { RunPhase } from './types.js';

export type EventKind =
  | 'phase_start'
  | 'phase_end'
  | 'agent_token'
  | 'tool_call'
  | 'render_progress'
  | 'log'
  | 'error';

export type EventPayload =
  | { kind: 'phase_start'; phase: RunPhase }
  | { kind: 'phase_end'; phase: RunPhase; ok: boolean }
  | { kind: 'agent_token'; phase: RunPhase; text: string }
  | { kind: 'tool_call'; phase: RunPhase; tool: string; argsPreview?: string }
  | { kind: 'render_progress'; frame: number; totalFrames: number }
  | { kind: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string }
  | { kind: 'error'; phase?: RunPhase; message: string };

export interface PersistedEvent {
  id: string;
  runId: string;
  ts: number;
  payload: EventPayload;
}
