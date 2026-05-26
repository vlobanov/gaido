import fs from 'node:fs';
import path from 'node:path';
import {
  schema,
  runId as newRunId,
  nodeId as newNodeId,
  artifactId as newArtifactId,
  GAIDO_PROTOCOL_PREAMBLE,
  MESSAGE_FILENAME,
} from '@gaido/core';
import type { Run, Node } from '@gaido/core/schema';
import type {
  AdapterConfigSnapshot,
  Critique,
  Logger,
  RunPhase,
  RunStatus,
  RunError,
  EventPayload,
} from '@gaido/core';
import { readCoderMessage } from './coder-message.js';
import { desc, eq } from 'drizzle-orm';
import type { Db } from './db.js';
import type { EventBus } from './event-bus.js';
import type { ResolvedConfig } from './config-loader.js';
import type { WorkspaceManager } from './workspace.js';
import type { Paths } from './paths.js';
import type { PreviewServerHandle } from './preview-server.js';
import { runChecks, formatFollowUp } from './checks.js';
import { snapshotClaudeSession } from './session-snapshot.js';
import { CODER_CARD_HEIGHT, nextChildY } from './layout.js';

interface OrchestratorDeps {
  db: Db;
  eventBus: EventBus;
  config: ResolvedConfig;
  workspace: WorkspaceManager;
  paths: Paths;
  previewServer: PreviewServerHandle | null;
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
  private readonly workspace: WorkspaceManager;
  private readonly paths: Paths;
  private readonly previewServer: PreviewServerHandle | null;
  private readonly active = new Map<string, AbortController>();

  constructor(deps: OrchestratorDeps) {
    this.db = deps.db;
    this.eventBus = deps.eventBus;
    this.config = deps.config;
    this.workspace = deps.workspace;
    this.paths = deps.paths;
    this.previewServer = deps.previewServer;
  }

  /**
   * Insert a queued run for `nodeId`, kick off async execution.
   *
   * `artistFollowUp` is an optional artist-typed message sent when the
   * coder previously dropped MESSAGE.md and the user wants to reply. It's
   * persisted on the run (for the UI thread) and handed to the coder
   * adapter as the next turn in the resumed session. Requires the node to
   * already have a session — the caller (tRPC layer) enforces that.
   */
  startRun(nodeId: string, opts?: { artistFollowUp?: string }): Run {
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
        status: 'running',
        configSnapshot: snapshot,
        ...(opts?.artistFollowUp ? { artistFollowUp: opts.artistFollowUp } : {}),
        createdAt: now,
        updatedAt: now,
      })
      .run();

    this.db
      .update(schema.nodes)
      .set({ status: 'running', currentRunId: id, updatedAt: now })
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

  /**
   * Persist a human-written critique on a critique node. Used by the
   * notes panel in the sidebar — bypasses the critic adapter entirely.
   *
   * - If the node has no run yet, inserts one synchronously in `done`
   *   state with the notes as the critique's `overall` text.
   * - If a run exists, updates its critique JSON in place (re-editable).
   *
   * Either way the node + run land in `status='done'`. Empty notes clear
   * the stored critique back to null and leave the node `idle` so the
   * panel goes back to its empty state.
   */
  saveHumanCritique(nodeId: string, notes: string): Run {
    const node = this.db
      .select()
      .from(schema.nodes)
      .where(eq(schema.nodes.id, nodeId))
      .get();
    if (!node) throw new Error(`node ${nodeId} not found`);
    if (node.kind !== 'critique') {
      throw new Error('human critique can only be saved on critique nodes');
    }
    const trimmed = notes.trim();
    const critique: Critique | null = trimmed
      ? {
          overall: trimmed,
          strengths: [],
          weaknesses: [],
          suggestions: [],
        }
      : null;
    const now = Date.now();
    const targetStatus: RunStatus = critique ? 'done' : 'idle';

    let runId = node.currentRunId;
    if (runId) {
      this.db
        .update(schema.runs)
        .set({
          status: targetStatus,
          critique,
          critiquingStartedAt: critique ? now : null,
          critiquingFinishedAt: critique ? now : null,
          updatedAt: now,
        })
        .where(eq(schema.runs.id, runId))
        .run();
    } else {
      runId = newRunId();
      const snapshot: AdapterConfigSnapshot = {
        coder: { kind: this.config.coder.kind },
        critic: { kind: this.config.critic.kind },
        renderer: { kind: this.config.renderer.kind },
      };
      this.db
        .insert(schema.runs)
        .values({
          id: runId,
          nodeId,
          status: targetStatus,
          configSnapshot: snapshot,
          critique,
          critiquingStartedAt: critique ? now : null,
          critiquingFinishedAt: critique ? now : null,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }
    this.db
      .update(schema.nodes)
      .set({ status: targetStatus, currentRunId: runId, updatedAt: now })
      .where(eq(schema.nodes.id, nodeId))
      .run();

    const run = this.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, runId))
      .get();
    if (!run) throw new Error(`run ${runId} not found after save`);
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
    const node = this.db
      .select()
      .from(schema.nodes)
      .where(eq(schema.nodes.id, nodeId))
      .get();
    if (!node) {
      this.setRunStatus(runId, nodeId, 'failed', {
        error: { phase: 'startup', message: `node ${nodeId} not found` },
      });
      return;
    }
    const canvasId = node.canvasId;
    try {
      if (node.kind === 'critique') {
        await this.executeCritique(runId, nodeId, node, signal);
      } else {
        await this.executeCoder(runId, nodeId, node, signal);
      }
    } catch (err) {
      if (signal.aborted) {
        this.setRunStatus(runId, nodeId, 'cancelled', {});
        return;
      }
      const e = toRunError(err);
      this.eventBus.publish(runId, canvasId, {
        kind: 'error',
        phase: e.phase === 'startup' ? undefined : e.phase,
        message: e.message,
      });
      this.setRunStatus(runId, nodeId, 'failed', { error: e });
    }
  }

  private async executeCoder(
    runId: string,
    nodeId: string,
    node: Node,
    signal: AbortSignal
  ): Promise<void> {
    // Anchor row owns the worktree + branch + session for a chain of
    // continued nodes. Forked/root nodes are their own anchor.
    const anchorId = node.branchAnchorId ?? node.id;
    const anchor =
      anchorId === node.id
        ? node
        : (this.db
            .select()
            .from(schema.nodes)
            .where(eq(schema.nodes.id, anchorId))
            .get() ?? node);

    const canvasSlug = this.resolveCanvasSlug(node.canvasId);

    let sessionId: string | null = anchor.sessionId ?? null;
    const checks = this.config.postCoderChecks;
    const maxAttempts = Math.max(1, this.config.checkMaxRetries);

    // Coding phase wraps the coder.run + post-coder check loop. Each
    // additional attempt resumes the same session with the failing check's
    // output as a follow-up message.
    await this.runPhase(runId, nodeId, node.canvasId, 'coding', signal, async () => {
      // basisCommit is only consulted on the anchor's first worktree
      // creation; for non-anchor nodes the worktree already exists, so the
      // value is ignored. Walk up to the nearest coder ancestor and use its
      // currentRun.commitSha so forks land at that specific iteration's
      // state rather than the (possibly advanced) branch tip.
      const ancestorCoder = this.resolveAncestorCoder(anchor.parentId);
      const basisCommit = ancestorCoder?.currentRunId
        ? this.db
            .select({ commitSha: schema.runs.commitSha })
            .from(schema.runs)
            .where(eq(schema.runs.id, ancestorCoder.currentRunId))
            .get()?.commitSha ?? undefined
        : undefined;
      const workdir = await this.workspace.ensureNodeWorkspace({
        nodeId: anchorId,
        canvasSlug,
        ...(basisCommit
          ? { basisCommit }
          : { seedSkeleton: anchor.skeletonName ?? 'default' }),
      });

      // Clear any MESSAGE.md left over from a prior run on this branch. The
      // coder writes it fresh this turn if they want to communicate; a
      // leftover would otherwise be misread as this run's message and
      // could short-circuit rendering. Deletion is committed by commitRun
      // if nothing else changed — intentional: it marks the resolution of
      // the prior turn's open question in git history.
      fs.rmSync(path.join(workdir, MESSAGE_FILENAME), { force: true });

      // Base instruction the coder will see this run. On a fresh session we
      // compose preamble + project rules + artist instruction; on a resumed
      // session we send the bare instruction (rules already in conversation
      // history from turn 1). The framework preamble is handled separately
      // below — it's prepended on the first turn of EVERY run, fresh or
      // resumed, so the coder always starts with the protocol in scope even
      // when continuing a pre-existing session.
      const baseInstruction = sessionId
        ? node.instruction
        : composeFreshSessionInstruction(node.instruction, this.paths.lessonsFile);
      // On resumed sessions, composeFreshSessionInstruction didn't run so the
      // preamble is missing from the prompt. We splice it in on the first
      // iteration only (subsequent iterations are driven by check failures
      // and the model already saw the preamble this turn).
      const resumePreamble = sessionId ? GAIDO_PROTOCOL_PREAMBLE : null;

      // Seed the loop's `followUp` from the artist's reply if any. Only
      // meaningful on resumed sessions — the adapter substitutes followUp
      // for the prompt, so a fresh run with a followUp would silently lose
      // the framework preamble + instruction. The tRPC `reply` mutation
      // rejects that case before getting here, but we belt-and-braces.
      const artistReply = sessionId ? this.readArtistFollowUp(runId) : null;
      let followUp: string | undefined = artistReply ?? undefined;
      let attempt = 0;

      while (true) {
        attempt += 1;
        if (signal.aborted) throw makeAbortError('coding');

        // Resumed sessions get the preamble prepended on the first turn of
        // this run. Whichever of instruction/followUp the adapter will use
        // as the prompt is the one we wrap.
        let turnInstruction = baseInstruction;
        let turnFollowUp = followUp;
        if (attempt === 1 && resumePreamble) {
          if (turnFollowUp) {
            turnFollowUp = `${resumePreamble}\n\n---\n\n${turnFollowUp}`;
          } else {
            turnInstruction = `${resumePreamble}\n\n---\n\n${turnInstruction}`;
          }
        }

        const result = await this.config.coder.run(
          {
            instruction: turnInstruction,
            priorSessionId: sessionId,
            ...(turnFollowUp ? { followUp: turnFollowUp } : {}),
          },
          {
            nodeId,
            runId,
            workdir,
            outputDir: workdir,
            logDir: this.ensureRunLogDir(runId),
            abortSignal: signal,
            logger: makeLogger('coder'),
            emit: (event) => this.eventBus.publish(runId, node.canvasId, event),
            ...(this.previewServer
              ? { previewServerBase: this.previewServer.baseUrl }
              : {}),
          }
        );

        if (result.sessionId) sessionId = result.sessionId;
        // Single-use: subsequent iterations in this loop are driven by
        // post-coder check failures, not by the artist's original reply.
        followUp = undefined;

        // If the coder dropped MESSAGE.md with producedArtifact=false it is
        // explicitly opting out of producing a render — there's nothing for
        // post-coder checks to validate. Break the loop so we go straight
        // to commit + persist + skip render.
        const earlyMessage = readCoderMessage(workdir);
        if (earlyMessage && !earlyMessage.producedArtifact) break;

        if (checks.length === 0) break;

        const checkResult = await runChecks({
          checks,
          workdir,
          projectDir: this.paths.projectDir,
          artifactsDir: path.join(this.paths.artifactsDir, canvasSlug),
          runId,
          nodeId,
          abortSignal: signal,
        });

        if (checkResult.ok) {
          for (const c of checks) {
            this.eventBus.publish(runId, node.canvasId, {
              kind: 'check_attempt',
              attempt,
              check: c.name,
              ok: true,
            });
          }
          break;
        }

        this.eventBus.publish(runId, node.canvasId, {
          kind: 'check_attempt',
          attempt,
          check: checkResult.failedCheck,
          ok: false,
          output: checkResult.output,
        });

        if (attempt >= maxAttempts) {
          throw attachValidation(
            new Error(
              `post-coder check '${checkResult.failedCheck}' failed after ${attempt} attempt(s)`
            ),
            {
              check: checkResult.failedCheck,
              attempts: attempt,
              output: checkResult.output,
            }
          );
        }

        followUp = formatFollowUp(checkResult);
      }

      // Persist sessionId on the anchor — the branch's conversation lives
      // there, and continued nodes read it via the anchor on their next run.
      if (sessionId && sessionId !== anchor.sessionId) {
        this.db
          .update(schema.nodes)
          .set({ sessionId, updatedAt: Date.now() })
          .where(eq(schema.nodes.id, anchorId))
          .run();
      }
    });

    // Commit on the anchor's branch (anchor owns the worktree). The
    // resulting sha is recorded on the current run row regardless.
    const sha = await this.workspace.commitRun({
      nodeId: anchorId,
      canvasSlug,
      runId,
      message: `run ${runId}`,
    });
    if (sha) {
      this.db
        .update(schema.runs)
        .set({ commitSha: sha, updatedAt: Date.now() })
        .where(eq(schema.runs.id, runId))
        .run();
    }

    // Snapshot the Claude session as it stood at the end of this run.
    // Write-only: no consumer yet, but having the data already on disk
    // means fork-with-session-history can land later as a read-only change.
    snapshotClaudeSession({
      workdir: this.workspace.workspacePath({ nodeId: anchorId, canvasSlug }),
      sessionId,
      runId,
      runsDir: path.join(this.paths.runsDir, canvasSlug),
    });

    // Coder may have dropped MESSAGE.md to talk back to the artist. Persist
    // it now so it surfaces regardless of whether we go on to render.
    const workdirForMessage = this.workspace.workspacePath({
      nodeId: anchorId,
      canvasSlug,
    });
    const message = readCoderMessage(workdirForMessage);
    if (message) {
      this.db
        .update(schema.runs)
        .set({ message, updatedAt: Date.now() })
        .where(eq(schema.runs.id, runId))
        .run();
    }

    // producedArtifact=false short-circuits the render + critic-spawn flow:
    // the message itself is the run's terminal output. Combo case
    // (producedArtifact=true) renders normally; the message is just a note
    // alongside the video.
    if (message && !message.producedArtifact) {
      this.setRunStatus(runId, nodeId, 'done', {});
      return;
    }

    // Rendering phase.
    await this.runPhase(runId, nodeId, node.canvasId, 'rendering', signal, async () => {
      const workdir = this.workspace.workspacePath({ nodeId: anchorId, canvasSlug });
      const outputDir = path.join(this.paths.artifactsDir, canvasSlug, runId);
      fs.mkdirSync(outputDir, { recursive: true });

      const result = await this.config.renderer.render(
        {
          duration: this.config.render.duration,
          fps: this.config.render.fps,
          width: this.config.render.width,
          height: this.config.render.height,
        },
        {
          nodeId,
          runId,
          workdir,
          outputDir,
          logDir: this.ensureRunLogDir(runId),
          abortSignal: signal,
          logger: makeLogger('renderer'),
          emit: (event) => this.eventBus.publish(runId, node.canvasId, event),
          ...(this.previewServer
            ? { previewServerBase: this.previewServer.baseUrl }
            : {}),
        }
      );

      if (result.videoPath) {
        this.recordArtifact(runId, 'video', result.videoPath, 'video/mp4');
      }
      if (result.thumbnailPath) {
        this.recordArtifact(
          runId,
          'thumbnail',
          result.thumbnailPath,
          mimeFromPath(result.thumbnailPath)
        );
      }
      const publicUrlFn = this.config.previewServer?.publicUrl;
      const persistedUrl = publicUrlFn
        ? publicUrlFn({ runId, nodeId })
        : result.previewUrl ?? null;
      if (persistedUrl) {
        this.db
          .update(schema.runs)
          .set({ previewUrl: persistedUrl, updatedAt: Date.now() })
          .where(eq(schema.runs.id, runId))
          .run();
      }
    });

    this.setRunStatus(runId, nodeId, 'done', {});
    this.autoSpawnCritiqueChild(node);
  }

  private async executeCritique(
    runId: string,
    nodeId: string,
    node: Node,
    signal: AbortSignal
  ): Promise<void> {
    if (!node.parentId) {
      throw new Error('critique node missing parent');
    }
    const parent = this.db
      .select()
      .from(schema.nodes)
      .where(eq(schema.nodes.id, node.parentId))
      .get();
    if (!parent || parent.kind !== 'coder') {
      throw new Error('critique parent must be a coder node');
    }
    if (!parent.currentRunId) {
      throw new Error('parent coder has no completed run yet');
    }
    const parentRun = this.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, parent.currentRunId))
      .get();
    if (!parentRun || !parentRun.videoArtifactId) {
      throw new Error('parent coder has no rendered video to evaluate');
    }
    const videoArtifact = this.db
      .select()
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, parentRun.videoArtifactId))
      .get();
    if (!videoArtifact) {
      throw new Error('parent video artifact row missing');
    }

    const canvasSlug = this.resolveCanvasSlug(node.canvasId);

    let critique: Critique | null = null;
    await this.runPhase(runId, nodeId, node.canvasId, 'critiquing', signal, async () => {
      const codePath = this.workspace.workspacePath({ nodeId: parent.id, canvasSlug });
      const result = await this.config.critic.critique(
        {
          videoPath: videoArtifact.path,
          codePath,
          prompt: parent.instruction,
        },
        {
          nodeId,
          runId,
          workdir: codePath,
          outputDir: path.join(this.paths.artifactsDir, canvasSlug, runId),
          logDir: this.ensureRunLogDir(runId),
          abortSignal: signal,
          logger: makeLogger('critic'),
          emit: (event) => this.eventBus.publish(runId, node.canvasId, event),
        }
      );
      critique = result.critique ?? null;
    });

    this.setRunStatus(runId, nodeId, 'done', critique ? { critique } : {});
  }

  private resolveCanvasSlug(canvasId: string): string {
    const row = this.db
      .select({ slug: schema.canvases.slug })
      .from(schema.canvases)
      .where(eq(schema.canvases.id, canvasId))
      .get();
    if (!row) throw new Error(`canvas ${canvasId} not found`);
    return row.slug;
  }

  /**
   * Walk up the parent chain until we find a coder-kind node. Used to
   * locate the iteration whose commit a new branch should root at. Returns
   * the full node so callers can read `currentRunId` / `branchAnchorId` /
   * `instruction` without a second lookup. Critique nodes are skipped.
   */
  private resolveAncestorCoder(startParentId: string | null): Node | null {
    let cursor: string | null = startParentId;
    while (cursor) {
      const p = this.db
        .select()
        .from(schema.nodes)
        .where(eq(schema.nodes.id, cursor))
        .get();
      if (!p) return null;
      if (p.kind === 'coder') return p;
      cursor = p.parentId;
    }
    return null;
  }

  /**
   * After a coder run lands `done`, ensure a critique child exists. The
   * partial unique index `(parent_id) WHERE kind='critique'` makes the
   * insert a no-op on retry of an already-done coder.
   *
   * Re-loads the coder row to pick up any drag that happened while the
   * run was in flight — the `Node` we received as a parameter was captured
   * at the start of the run, so it has stale position data if the user
   * moved the card. Without this, multiple coder siblings under one
   * critique would auto-spawn their critique children on top of each
   * other at the original (default) X, looking like they share a critique.
   */
  private autoSpawnCritiqueChild(coder: Node): void {
    const fresh =
      this.db
        .select()
        .from(schema.nodes)
        .where(eq(schema.nodes.id, coder.id))
        .get() ?? coder;
    const id = newNodeId();
    const now = Date.now();
    this.db
      .insert(schema.nodes)
      .values({
        id,
        parentId: fresh.id,
        canvasId: fresh.canvasId,
        kind: 'critique',
        positionX: fresh.positionX,
        positionY: nextChildY(fresh.positionY, CODER_CARD_HEIGHT),
        instruction: fresh.instruction,
        status: 'idle',
        isFavorite: false,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run();
  }

  private async runPhase(
    runId: string,
    nodeId: string,
    canvasId: string,
    phase: RunPhase,
    signal: AbortSignal,
    body: () => Promise<void>
  ): Promise<void> {
    if (signal.aborted) throw makeAbortError(phase);
    const startedAt = Date.now();
    this.db
      .update(schema.runs)
      .set({
        status: 'running',
        ...phaseStartColumn(phase, startedAt),
        updatedAt: startedAt,
      })
      .where(eq(schema.runs.id, runId))
      .run();
    this.db
      .update(schema.nodes)
      .set({ status: 'running', updatedAt: startedAt })
      .where(eq(schema.nodes.id, nodeId))
      .run();

    this.eventBus.publish(runId, canvasId, { kind: 'phase_start', phase });

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
      this.eventBus.publish(runId, canvasId, { kind: 'phase_end', phase, ok: true });
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
      this.eventBus.publish(runId, canvasId, { kind: 'phase_end', phase, ok: false });
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

    // Roll up the run's final token usage from the event stream. The last
    // `token_usage` event is authoritative (claude-code adapter overrides
    // intermediate sums with the result event's billed totals). Captured on
    // both success and failure — tokens billed for a partial run still need
    // to surface in the run row.
    const totals = this.latestTokenTotals(runId);
    if (totals) {
      update.tokensIn = totals.inputTokens;
      update.tokensOut = totals.outputTokens;
      if (typeof totals.costUsd === 'number') update.costUsd = totals.costUsd;
    }

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

    // Tell live subscribers we just landed at a terminal status. Without
    // this the UI can be stuck on the last phase_end it saw — particularly
    // for message-only coder runs that skip the rendering phase (no
    // phase_start rendering ever fires to nudge a refetch). Look the
    // canvas up here so callers don't have to thread it through.
    if (
      status === 'done' ||
      status === 'failed' ||
      status === 'cancelled' ||
      status === 'interrupted'
    ) {
      const canvasRow = this.db
        .select({ canvasId: schema.nodes.canvasId })
        .from(schema.nodes)
        .where(eq(schema.nodes.id, nodeId))
        .get();
      if (canvasRow) {
        this.eventBus.publish(runId, canvasRow.canvasId, {
          kind: 'run_finalized',
          status,
        });
      }
    }
  }

  /**
   * Per-run log directory. Created lazily on first use. Mirrors the
   * `.artifacts/<runId>` layout but at `.logs/<runId>` — adapters write raw
   * subprocess streams here, EventBus also drops `events.ndjson` alongside.
   */
  private ensureRunLogDir(runId: string): string {
    const dir = path.join(this.paths.logsDir, runId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Latest persisted `token_usage` event for this run, decoded. Returns
   * null if the run never emitted one (e.g., stub coder, critique-only
   * node). Used to roll up totals into the runs row at terminal status.
   */
  private latestTokenTotals(runId: string): {
    inputTokens: number;
    outputTokens: number;
    costUsd?: number;
  } | null {
    const rows = this.db
      .select()
      .from(schema.events)
      .where(eq(schema.events.runId, runId))
      .orderBy(desc(schema.events.ts))
      .all();
    for (const row of rows) {
      const p = row.payload;
      if (p.kind === 'token_usage') {
        return {
          inputTokens: p.inputTokens,
          outputTokens: p.outputTokens,
          ...(typeof p.costUsd === 'number' ? { costUsd: p.costUsd } : {}),
        };
      }
    }
    return null;
  }

  private readArtistFollowUp(runId: string): string | null {
    const row = this.db
      .select({ artistFollowUp: schema.runs.artistFollowUp })
      .from(schema.runs)
      .where(eq(schema.runs.id, runId))
      .get();
    return row?.artistFollowUp ?? null;
  }

  private recordArtifact(
    runId: string,
    kind: 'code' | 'video' | 'thumbnail' | 'frame' | 'log',
    filePath: string,
    mime: string
  ): void {
    const id = newArtifactId();
    const stat = fs.statSync(filePath);
    const now = Date.now();
    this.db
      .insert(schema.artifacts)
      .values({
        id,
        runId,
        kind,
        path: filePath,
        mime,
        sizeBytes: stat.size,
        createdAt: now,
      })
      .run();
    const update: Partial<typeof schema.runs.$inferInsert> = { updatedAt: now };
    if (kind === 'video') update.videoArtifactId = id;
    else if (kind === 'thumbnail') update.thumbnailArtifactId = id;
    else if (kind === 'code') update.codeArtifactId = id;
    this.db
      .update(schema.runs)
      .set(update)
      .where(eq(schema.runs.id, runId))
      .run();
  }
}

function mimeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    case '.svg':
      return 'image/svg+xml';
    case '.mp4':
      return 'video/mp4';
    case '.webm':
      return 'video/webm';
    default:
      return 'application/octet-stream';
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

interface ValidationTagged {
  __gaidoValidation?: NonNullable<RunError['validation']>;
}

function attachPhase<E extends Error>(err: E, phase: RunPhase): E {
  (err as E & PhaseTagged).__gaidoPhase = phase;
  return err;
}

function attachValidation<E extends Error>(
  err: E,
  v: NonNullable<RunError['validation']>
): E {
  (err as E & ValidationTagged).__gaidoValidation = v;
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
    const tagged = err as Error & PhaseTagged & ValidationTagged;
    return {
      phase: tagged.__gaidoPhase ?? 'startup',
      message: err.message,
      ...(err.stack ? { stack: err.stack } : {}),
      ...(tagged.__gaidoValidation
        ? { validation: tagged.__gaidoValidation }
        : {}),
    };
  }
  return { phase: 'startup', message: String(err) };
}

/**
 * Assemble the instruction for a fresh coder session:
 *
 *   GAIDO PROTOCOL: (framework-level)
 *   PROJECT RULES:  (LESSONS.md contents, if any)
 *   <artist instruction>
 *
 * Most-general → most-specific. Only called when starting a brand-new
 * session — project rules are skipped on resumed sessions because they
 * could be long and were already seen on turn 1. The framework preamble
 * is handled separately by the orchestrator's run loop so it can also
 * reach resumed sessions (cheap to re-send and self-heals legacy sessions
 * that predate the protocol).
 */
function composeFreshSessionInstruction(instruction: string, lessonsFile: string): string {
  const sections: string[] = [GAIDO_PROTOCOL_PREAMBLE];
  let lessons = '';
  try {
    lessons = fs.readFileSync(lessonsFile, 'utf8').trim();
  } catch {
    // file may not exist yet — that's fine, just skip the project-rules block
  }
  if (lessons) {
    sections.push(`PROJECT RULES (apply to every render in this project):\n\n${lessons}`);
  }
  sections.push(instruction);
  return sections.join('\n\n---\n\n');
}

function makeLogger(prefix: string): Logger {
  // eslint-disable-next-line no-console
  const c = console;
  return {
    debug: (m, meta) => c.debug(`[${prefix}] ${m}`, meta ?? ''),
    info: (m, meta) => c.log(`[${prefix}] ${m}`, meta ?? ''),
    warn: (m, meta) => c.warn(`[${prefix}] ${m}`, meta ?? ''),
    error: (m, meta) => c.error(`[${prefix}] ${m}`, meta ?? ''),
  };
}

// Suppress unused-warning for events type that participates only via inference.
export type _UnusedEventPayload = EventPayload;
