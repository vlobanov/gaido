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
  parentCodePath?: string;
}

export interface CoderResult {
  codeArtifactPath: string;
}

export interface Coder {
  readonly kind: string;
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
