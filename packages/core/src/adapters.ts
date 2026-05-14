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
  /**
   * Per-run directory for technical logs (raw subprocess stdout/stderr,
   * adapter scratch dumps). Already exists when handed to the adapter.
   * Useful when something goes wrong and stderr is the only hint — write
   * verbose bytes here rather than spamming the event bus.
   */
  logDir: string;
  abortSignal: AbortSignal;
  logger: Logger;
  emit(event: EventPayload): void;
  /**
   * Base URL of the project's preview dev server (e.g. 'http://127.0.0.1:3004'),
   * if one is configured and running. Renderers can use this to drive Playwright
   * against the project's existing harness; previews link humans into it.
   */
  previewServerBase?: string;
}

export interface CoderInput {
  instruction: string;
  /**
   * Session id from a prior run on the same node. Adapters that support
   * resume (e.g., Claude Code) should continue the session; others ignore.
   */
  priorSessionId?: string | null;
  /**
   * Within-run validation feedback. When set, the orchestrator is asking the
   * coder to fix issues found by a post-coder check: send this string as the
   * next message in the resumed session instead of re-prompting with the
   * original `instruction`. Adapters that lack session-resume should treat
   * this as the new prompt.
   */
  followUp?: string;
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
  duration: number;
  fps: number;
  width: number;
  height: number;
  /** Reserved for future mid-render resume support; ignored in v0. */
  resumeHint?: unknown;
}

export interface RenderResult {
  /** Path to the encoded video file, or null if no video was produced. */
  videoPath: string | null;
  /** Path to a still-frame thumbnail image, or null if none. */
  thumbnailPath: string | null;
  /** Actual render wall-clock duration in milliseconds. */
  durationMs: number;
  /**
   * URL where a human can open the live, parameter-driven preview of this
   * run. Typically built off the preview dev server's base URL with a
   * per-run path/query. Persisted on the run for the web UI to surface.
   */
  previewUrl?: string | null;
}

export interface Renderer {
  readonly kind: string;
  /**
   * Read the page source from `ctx.workdir` (typically `index.html`) and
   * write video + thumbnail into `ctx.outputDir`. The orchestrator inserts
   * artifact rows from the returned paths.
   */
  render(input: RenderInput, ctx: RunContext): Promise<RenderResult>;
}

export interface CriticInput {
  videoPath: string;
  codePath: string;
  prompt: string;
}

export interface CriticResult {
  /**
   * Optional. Omit to mark the critique node `done` without storing a
   * Critique JSON — used by `humanCritic()` and other adapters that defer
   * evaluation to the artist. The rules panel and Fork flow stay usable
   * either way; only the auto-generated critique panel needs a value.
   */
  critique?: Critique;
  costUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
}

export interface Critic {
  readonly kind: string;
  critique(input: CriticInput, ctx: RunContext): Promise<CriticResult>;
}
