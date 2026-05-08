import { schema, runId as newRunId } from '@gaido/core';
import type { Run } from '@gaido/core/schema';
import type {
  AdapterConfigSnapshot,
  Critique,
  RunPhase,
  RunStatus,
  RunError,
  EventPayload,
} from '@gaido/core';
import { eq } from 'drizzle-orm';
import type { Db } from './db.js';
import type { EventBus } from './event-bus.js';
import type { ResolvedConfig } from './config-loader.js';

interface OrchestratorDeps {
  db: Db;
  eventBus: EventBus;
  config: ResolvedConfig;
}

/**
 * Stub orchestrator. Walks each run through fake coding → rendering →
 * critiquing phases, emitting realistic-looking events. ~10% chance of failure.
 *
 * Real adapters will replace the inner step bodies; the lifecycle/abort/db
 * mirroring scaffolding stays.
 */
export class Orchestrator {
  private readonly db: Db;
  private readonly eventBus: EventBus;
  private readonly config: ResolvedConfig;
  private readonly active = new Map<string, AbortController>();

  constructor(deps: OrchestratorDeps) {
    this.db = deps.db;
    this.eventBus = deps.eventBus;
    this.config = deps.config;
  }

  /** Insert a queued run for `nodeId`, kick off async execution. */
  startRun(nodeId: string): Run {
    const id = newRunId();
    const now = Date.now();
    const snapshot: AdapterConfigSnapshot = {
      coder: { kind: this.config.coder.kind },
      critic: { kind: this.config.critic.kind },
      renderer: { kind: this.config.renderer.kind },
    };

    this.db
      .insert(schema.runs)
      .values({
        id,
        nodeId,
        status: 'queued',
        configSnapshot: snapshot,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    this.db
      .update(schema.nodes)
      .set({ status: 'queued', currentRunId: id, updatedAt: now })
      .where(eq(schema.nodes.id, nodeId))
      .run();

    const run = this.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, id))
      .get()!;

    const ctrl = new AbortController();
    this.active.set(id, ctrl);

    // Fire-and-forget. The async function handles its own errors.
    void this.execute(id, nodeId, ctrl.signal).finally(() => {
      this.active.delete(id);
    });

    return run;
  }

  /** Cancel an in-flight run. Idempotent. */
  cancel(nodeId: string): void {
    const node = this.db
      .select()
      .from(schema.nodes)
      .where(eq(schema.nodes.id, nodeId))
      .get();
    if (!node || !node.currentRunId) return;
    const ctrl = this.active.get(node.currentRunId);
    if (ctrl) ctrl.abort();
  }

  /** Cancel everything on shutdown. */
  shutdown(): void {
    for (const ctrl of this.active.values()) ctrl.abort();
    this.active.clear();
  }

  // ---------- internal ----------

  private async execute(
    runId: string,
    nodeId: string,
    signal: AbortSignal
  ): Promise<void> {
    try {
      // Coding phase.
      await this.runPhase(runId, nodeId, 'coding', signal, async () => {
        // Five fake agent_token events spaced ~250ms apart, total ~1.25s; the
        // setStatus + spacing brings the phase to ~1.5s.
        const tokens = ['Sketching ', 'shapes', '...', ' wiring', ' loop'];
        for (const text of tokens) {
          await sleep(250, signal);
          this.maybeFail('coding');
          this.eventBus.publish(runId, {
            kind: 'agent_token',
            phase: 'coding',
            text,
          });
        }
        await sleep(250, signal);
      });

      // Rendering phase.
      await this.runPhase(runId, nodeId, 'rendering', signal, async () => {
        const totalFrames = 150;
        // 6 progress events spaced 250ms = 1.5s.
        const ticks = 6;
        for (let i = 1; i <= ticks; i++) {
          await sleep(250, signal);
          this.maybeFail('rendering');
          const frame = Math.round((i / ticks) * totalFrames);
          this.eventBus.publish(runId, {
            kind: 'render_progress',
            frame,
            totalFrames,
          });
        }
      });

      // Critiquing phase.
      await this.runPhase(runId, nodeId, 'critiquing', signal, async () => {
        await sleep(1000, signal);
      });

      // Done. Persist a fake critique and finish.
      const critique: Critique = {
        overall: 'Looks balanced and lively.',
        rating: 4,
        strengths: ['Composition is clear', 'Smooth motion'],
        weaknesses: ['Color palette is a bit muted'],
        suggestions: ['Try a brighter accent color', 'Vary the timing'],
      };
      this.setRunStatus(runId, nodeId, 'done', { critique });
    } catch (err) {
      if (signal.aborted) {
        this.setRunStatus(runId, nodeId, 'cancelled', {});
        return;
      }
      const e = toRunError(err);
      this.eventBus.publish(runId, {
        kind: 'error',
        phase: e.phase === 'startup' ? undefined : e.phase,
        message: e.message,
      });
      this.setRunStatus(runId, nodeId, 'failed', { error: e });
    }
  }

  private async runPhase(
    runId: string,
    nodeId: string,
    phase: RunPhase,
    signal: AbortSignal,
    body: () => Promise<void>
  ): Promise<void> {
    if (signal.aborted) throw makeAbortError(phase);
    const startedAt = Date.now();
    this.db
      .update(schema.runs)
      .set({
        status: phase,
        ...phaseStartColumn(phase, startedAt),
        updatedAt: startedAt,
      })
      .where(eq(schema.runs.id, runId))
      .run();
    this.db
      .update(schema.nodes)
      .set({ status: phase, updatedAt: startedAt })
      .where(eq(schema.nodes.id, nodeId))
      .run();

    this.eventBus.publish(runId, { kind: 'phase_start', phase });

    try {
      await body();
      const finishedAt = Date.now();
      this.db
        .update(schema.runs)
        .set({
          ...phaseFinishColumn(phase, finishedAt),
          updatedAt: finishedAt,
        })
        .where(eq(schema.runs.id, runId))
        .run();
      this.eventBus.publish(runId, { kind: 'phase_end', phase, ok: true });
    } catch (err) {
      const finishedAt = Date.now();
      this.db
        .update(schema.runs)
        .set({
          ...phaseFinishColumn(phase, finishedAt),
          updatedAt: finishedAt,
        })
        .where(eq(schema.runs.id, runId))
        .run();
      this.eventBus.publish(runId, { kind: 'phase_end', phase, ok: false });
      // Re-throw so execute() can branch on aborted vs error.
      throw err instanceof Error ? attachPhase(err, phase) : err;
    }
  }

  private setRunStatus(
    runId: string,
    nodeId: string,
    status: RunStatus,
    extra: { critique?: Critique; error?: RunError }
  ): void {
    const now = Date.now();
    const update: Partial<typeof schema.runs.$inferInsert> = {
      status,
      updatedAt: now,
    };
    if (extra.critique) update.critique = extra.critique;
    if (extra.error) update.error = extra.error;

    this.db
      .update(schema.runs)
      .set(update)
      .where(eq(schema.runs.id, runId))
      .run();

    // Mirror node. Keep currentRunId pointing at the last run regardless of
    // outcome — the UI uses it to look up the latest result.
    this.db
      .update(schema.nodes)
      .set({ status, updatedAt: now })
      .where(eq(schema.nodes.id, nodeId))
      .run();
  }

  /**
   * 10% chance per phase to inject a synthetic failure. Throws an error tagged
   * with the current phase; the surrounding `runPhase` will translate it.
   */
  private maybeFail(phase: RunPhase): void {
    if (Math.random() < 0.1 / 5) {
      // 0.1/5 per token-tick keeps overall failure ~10% per phase.
      const message = `Synthetic ${phase} failure (stub orchestrator)`;
      const err = new Error(message);
      attachPhase(err, phase);
      throw err;
    }
  }
}

function phaseStartColumn(phase: RunPhase, ts: number) {
  switch (phase) {
    case 'coding':
      return { codingStartedAt: ts };
    case 'rendering':
      return { renderingStartedAt: ts };
    case 'critiquing':
      return { critiquingStartedAt: ts };
  }
}

function phaseFinishColumn(phase: RunPhase, ts: number) {
  switch (phase) {
    case 'coding':
      return { codingFinishedAt: ts };
    case 'rendering':
      return { renderingFinishedAt: ts };
    case 'critiquing':
      return { critiquingFinishedAt: ts };
  }
}

interface PhaseTagged {
  __gaidoPhase?: RunPhase;
}

function attachPhase<E extends Error>(err: E, phase: RunPhase): E {
  (err as E & PhaseTagged).__gaidoPhase = phase;
  return err;
}

function makeAbortError(phase: RunPhase): Error {
  const err = new Error('aborted');
  err.name = 'AbortError';
  attachPhase(err, phase);
  return err;
}

function toRunError(err: unknown): RunError {
  if (err instanceof Error) {
    const tagged = err as Error & PhaseTagged;
    return {
      phase: tagged.__gaidoPhase ?? 'startup',
      message: err.message,
      ...(err.stack ? { stack: err.stack } : {}),
    };
  }
  return { phase: 'startup', message: String(err) };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(makeAbortFromSignal());
      return;
    }
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(makeAbortFromSignal());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function makeAbortFromSignal(): Error {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

// Suppress unused-warning for events type that participates only via inference.
export type _UnusedEventPayload = EventPayload;
