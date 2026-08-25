import type { RunPhase, RunStatus } from './types.js';

export type EventKind =
  | 'phase_start'
  | 'phase_end'
  | 'agent_token'
  | 'tool_call'
  | 'token_usage'
  | 'render_progress'
  | 'check_attempt'
  | 'log'
  | 'error'
  | 'run_finalized'
  | 'node_updated';

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
      /**
       * Cumulative billed cost in USD, if the adapter has visibility into it.
       * Claude Code emits this on the final `result` event. Optional — the UI
       * falls back to "tokens only" when absent.
       */
      costUsd?: number;
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
  | { kind: 'error'; phase?: RunPhase; message: string }
  /**
   * Emitted by the orchestrator immediately after persisting a terminal run
   * status (done/failed/cancelled/interrupted) and any associated node row
   * update. Pure UI signal — exists so subscribers can refetch one final
   * time after the DB writes that don't naturally produce another event
   * (e.g., message-only runs that skip the rendering phase).
   *
   * No payload data beyond the new status — the UI is expected to refetch
   * nodes/runs to read the canonical state.
   */
  | { kind: 'run_finalized'; status: RunStatus }
  /**
   * A node row changed outside the run lifecycle — its note or its branch's
   * metadata was set from the CLI / an external tool (`gaido note`,
   * `gaido meta`, a project's own server). Pure refresh signal, like
   * `run_finalized`: published on the node's (or its branch anchor's) latest
   * run so the open canvas refetches `nodes.list`. `nodeId` names the node
   * the write went through; branch metadata also reaches every sibling on
   * the same anchor, hence the list-wide refetch.
   */
  | { kind: 'node_updated'; nodeId: string; field: 'note' | 'meta' };

export interface PersistedEvent {
  id: string;
  runId: string;
  ts: number;
  payload: EventPayload;
}
