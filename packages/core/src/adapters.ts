import type { Critique } from './types.js';
import type { EventPayload } from './events.js';

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface RunContext {
  nodeId: string;
  runId: string;
  workdir: string;
  outputDir: string;
  abortSignal: AbortSignal;
  logger: Logger;
  emit(event: EventPayload): void;
}

export interface CoderInput {
  instruction: string;
  /**
   * Session id from a prior run on the same node. Adapters that support
   * resume (e.g., Claude Code) should continue the session; others ignore.
   */
  priorSessionId?: string | null;
}

export interface CoderResult {
  /**
   * Session id this run executed under. The orchestrator persists it on
   * the node so the next run can resume. Null/undefined if the adapter
   * has no session concept.
   */
  sessionId?: string | null;
}

export interface Coder {
  readonly kind: string;
  /**
   * Mutate `ctx.workdir` to satisfy `instruction`. The orchestrator commits
   * whatever changes are present afterwards.
   */
  run(input: CoderInput, ctx: RunContext): Promise<CoderResult>;
}

export interface RenderInput {
  codePath: string;
  duration: number;
  fps: number;
  width: number;
  height: number;
  resumeHint?: unknown;
}

export interface RenderResult {
  videoPath: string;
  thumbnailPath: string;
  durationMs: number;
}

export interface Renderer {
  readonly kind: string;
  render(input: RenderInput, ctx: RunContext): Promise<RenderResult>;
}

export interface CriticInput {
  videoPath: string;
  codePath: string;
  prompt: string;
}

export interface CriticResult {
  critique: Critique;
  costUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
}

export interface Critic {
  readonly kind: string;
  critique(input: CriticInput, ctx: RunContext): Promise<CriticResult>;
}
