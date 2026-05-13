import type { RunPhase } from './types.js';

export type EventKind =
  | 'phase_start'
  | 'phase_end'
  | 'agent_token'
  | 'tool_call'
  | 'token_usage'
  | 'render_progress'
  | 'check_attempt'
  | 'log'
  | 'error';

export type EventPayload =
  | { kind: 'phase_start'; phase: RunPhase }
  | { kind: 'phase_end'; phase: RunPhase; ok: boolean }
  | { kind: 'agent_token'; phase: RunPhase; text: string }
  | { kind: 'tool_call'; phase: RunPhase; tool: string; argsPreview?: string }
  | {
      /**
       * Cumulative token usage so far in the current run/phase. Adapters that
       * have visibility into LLM usage emit this periodically (e.g., after each
       * turn) so the UI can show progress while the coder is working. Numbers
       * are run-cumulative, not per-turn — so a consumer can render the latest
       * event and ignore prior ones.
       */
      kind: 'token_usage';
      phase: RunPhase;
      inputTokens: number;
      outputTokens: number;
      cacheCreationTokens?: number;
      cacheReadTokens?: number;
    }
  | { kind: 'render_progress'; frame: number; totalFrames: number }
  | {
      kind: 'check_attempt';
      attempt: number;
      check: string;
      ok: boolean;
      /** Tail of stdout+stderr, capped server-side. Only on ok=false. */
      output?: string;
    }
  | { kind: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string }
  | { kind: 'error'; phase?: RunPhase; message: string };

export interface PersistedEvent {
  id: string;
  runId: string;
  ts: number;
  payload: EventPayload;
}
