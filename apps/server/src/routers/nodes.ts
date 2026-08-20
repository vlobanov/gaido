import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import {
  schema,
  nodeId as newNodeId,
  EXTERNAL_CODER_KIND,
} from '@vadimlobanov/gaido-core';
import type { ArtifactKind, Critique } from '@vadimlobanov/gaido-core';
import type { Node } from '@vadimlobanov/gaido-core/schema';
import { and, eq, gt, inArray } from 'drizzle-orm';
import { router, publicProcedure } from '../trpc.js';
import type { Db } from '../db.js';
import {
  critiqueCardHeight,
  layoutCanvasNodes,
  nextChildY,
  CONFIG_CARD_HEIGHT,
  INSTRUCTION_CARD_HEIGHT,
  SIBLING_X_STEP,
} from '../layout.js';
import {
  bindReferences,
  inheritReferences,
  deleteReferencesForNodes,
  referenceInputSchema,
  type ReferenceDeps,
} from '../references.js';
import { createContinuationCoder } from '../continuation.js';

const positionSchema = z.object({ x: z.number(), y: z.number() }).optional();

// Auto-run can spawn at most this many coder cycles from one start — a
// runaway guard, not a product limit; the UI offers a smaller range.
const AUTO_RUN_MAX = 50;

/**
 * The live auto-run frontier reachable from `rootId` (itself or a descendant):
 * the single node carrying a non-null `autoRunRemaining`. The orchestrator's
 * invariant keeps at most one per chain, so the first hit is authoritative.
 * Lets the artist interrupt from any node in the chain, not just the exact
 * node the loop has currently advanced to.
 */
function findAutoRunFrontier(db: Db, rootId: string): Node | null {
  const queue: string[] = [rootId];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = db
      .select()
      .from(schema.nodes)
      .where(eq(schema.nodes.id, id))
      .get();
    if (!node) continue;
    if (node.autoRunRemaining != null) return node;
    const kids = db
      .select({ id: schema.nodes.id })
      .from(schema.nodes)
      .where(eq(schema.nodes.parentId, id))
      .all();
    for (const k of kids) queue.push(k.id);
  }
  return null;
}

/**
 * Best-effort attach of references provided inline with a node-creating
 * mutation. The node + run go ahead even if a reference fails to bind (a
 * bad image, a since-deleted run) — the explicit attach mutations surface
 * those errors instead.
 */
async function bindInlineReferences(
  deps: ReferenceDeps,
  nodeId: string,
  refs: z.infer<typeof referenceInputSchema>[] | undefined
): Promise<void> {
  if (!refs?.length) return;
  try {
    await bindReferences(deps, nodeId, refs);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[references] inline bind failed for ${nodeId}:`, err);
  }
}

/** The provided canvas id, or the default canvas's id. Throws if neither exists. */
function resolveCanvasId(db: Db, canvasId: string | undefined): string {
  if (canvasId) return canvasId;
  const defaultCanvas = db
    .select({ id: schema.canvases.id })
    .from(schema.canvases)
    .where(eq(schema.canvases.slug, 'default'))
    .get();
  if (!defaultCanvas) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'default canvas missing',
    });
  }
  return defaultCanvas.id;
}

/**
 * Insert one comparison branch under an `instruction` root: a settled `config`
 * marker recording the coder+skeleton choice, then the `coder` beneath it.
 * Mirrors switchCoder's config→coder pair, but for a fresh root branch:
 * `sessionPolicy` is always `reset` (no prior session to retain), the config
 * carries `skeletonName` for display, and the coder carries `skeletonName` so
 * the orchestrator seeds its worktree from `seed/<skeleton>` (a fresh branch
 * whose anchor is itself). The coder's `instruction` is a copy of the prompt —
 * the orchestrator reads `node.instruction`, the same denormalization
 * `createContinuationCoder` does with critique feedback. `coderName` is left
 * null on the coder so it inherits the config marker's choice by lineage walk.
 * Returns the new node ids; the caller owns references + `startRun`.
 */
function insertRootBranch(
  db: Db,
  args: {
    prompt: Pick<Node, 'id' | 'canvasId'>;
    instruction: string;
    /** Explicit coder pick, or null to inherit the registry default dynamically. */
    coderName: string | null;
    skeletonName: string | null;
    x: number;
    y: number;
    autoRun?: number | undefined;
    now: number;
  }
): { configId: string; coderId: string } {
  const { prompt, instruction, coderName, skeletonName, x, y, autoRun, now } =
    args;
  const skeletonLabel = skeletonName ?? 'default';

  const configId = newNodeId();
  db.insert(schema.nodes)
    .values({
      id: configId,
      parentId: prompt.id,
      canvasId: prompt.canvasId,
      kind: 'config',
      positionX: x,
      positionY: y,
      instruction: `${coderName ?? 'default'} · ${skeletonLabel}`,
      coderName,
      skeletonName,
      sessionPolicy: 'reset',
      status: 'done',
      isFavorite: false,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  const coderId = newNodeId();
  db.insert(schema.nodes)
    .values({
      id: coderId,
      parentId: configId,
      canvasId: prompt.canvasId,
      kind: 'coder',
      positionX: x,
      positionY: nextChildY(y, CONFIG_CARD_HEIGHT),
      instruction,
      // Own branch off seed/<skeleton>; leaves coderName null to inherit the
      // config marker's choice by lineage walk, exactly like switchCoder.
      skeletonName,
      ...(autoRun && autoRun > 1
        ? { autoRunTotal: autoRun, autoRunRemaining: autoRun }
        : {}),
      status: 'idle',
      isFavorite: false,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  return { configId, coderId };
}

/**
 * First non-null `coderName` walking up from `node` (self included). Mirrors
 * the orchestrator's resolution: root pick / config-node switch / retry swap
 * set it; everything else inherits down lineage. Null → registry default.
 */
function resolveCoderName(
  db: Db,
  node: Pick<Node, 'id' | 'parentId' | 'coderName'>
): string | null {
  let cursor: Pick<Node, 'id' | 'parentId' | 'coderName'> | null = node;
  const seen = new Set<string>();
  while (cursor) {
    if (cursor.coderName) return cursor.coderName;
    if (!cursor.parentId || seen.has(cursor.id)) break;
    seen.add(cursor.id);
    cursor =
      db
        .select({
          id: schema.nodes.id,
          parentId: schema.nodes.parentId,
          coderName: schema.nodes.coderName,
        })
        .from(schema.nodes)
        .where(eq(schema.nodes.id, cursor.parentId))
        .get() ?? null;
  }
  return null;
}

/**
 * In-memory twin of `resolveCoderName` over an already-fetched row set — for
 * `list`, which holds the whole (per-canvas) graph and would otherwise do an
 * N×depth DB walk. A per-canvas slice is closed under the parent walk (roots
 * have no parent), so the map always resolves. Null pick → registry default.
 */
function resolveCoderNameInRows<
  T extends { id: string; parentId: string | null; coderName: string | null },
>(start: T, byId: Map<string, T>, defaultName: string): string {
  const seen = new Set<string>();
  let cur: T | undefined = start;
  while (cur && !seen.has(cur.id)) {
    if (cur.coderName) return cur.coderName;
    seen.add(cur.id);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return defaultName;
}

/** Nearest coder at or above `startParentId`, skipping critiques. */
function resolveAncestorCoderId(db: Db, startParentId: string | null): string | null {
  let cursor = startParentId;
  while (cursor) {
    const p = db
      .select({
        id: schema.nodes.id,
        kind: schema.nodes.kind,
        parentId: schema.nodes.parentId,
      })
      .from(schema.nodes)
      .where(eq(schema.nodes.id, cursor))
      .get();
    if (!p) return null;
    if (p.kind === 'coder') return p.id;
    cursor = p.parentId;
  }
  return null;
}

/**
 * A coder node is the "leaf" of its branch when no later-created node
 * shares its anchor. Used to gate retry: an earlier node on a shared
 * branch shouldn't be re-runnable, since the worktree has been advanced
 * past it. Critique nodes don't disqualify; forks (different anchor) don't
 * disqualify either.
 */
function isLeafOfBranch(db: Db, node: Node): boolean {
  const anchorId = node.branchAnchorId ?? node.id;
  // Continuations on the same branch always have branch_anchor_id pointing
  // at the anchor row (never at intermediate links — see the Continue
  // mutation). So one equality check covers anchor-and-non-anchor cases.
  const later = db
    .select({ id: schema.nodes.id })
    .from(schema.nodes)
    .where(
      and(
        gt(schema.nodes.createdAt, node.createdAt),
        eq(schema.nodes.kind, 'coder'),
        eq(schema.nodes.branchAnchorId, anchorId)
      )
    )
    .limit(1)
    .all();
  return later.length === 0;
}

export const nodesRouter = router({
  list: publicProcedure
    .input(z.object({ canvasId: z.string().optional() }).optional())
    .query(({ ctx, input }) => {
      const base = ctx.db
        .select({
          id: schema.nodes.id,
          parentId: schema.nodes.parentId,
          canvasId: schema.nodes.canvasId,
          kind: schema.nodes.kind,
          positionX: schema.nodes.positionX,
          positionY: schema.nodes.positionY,
          instruction: schema.nodes.instruction,
          status: schema.nodes.status,
          currentRunId: schema.nodes.currentRunId,
          sessionId: schema.nodes.sessionId,
          coderName: schema.nodes.coderName,
          skeletonName: schema.nodes.skeletonName,
          sessionPolicy: schema.nodes.sessionPolicy,
          autoRunTotal: schema.nodes.autoRunTotal,
          autoRunRemaining: schema.nodes.autoRunRemaining,
          note: schema.nodes.note,
          isFavorite: schema.nodes.isFavorite,
          createdAt: schema.nodes.createdAt,
          updatedAt: schema.nodes.updatedAt,
          thumbnailArtifactId: schema.runs.thumbnailArtifactId,
          videoArtifactId: schema.runs.videoArtifactId,
          outputArtifactId: schema.runs.outputArtifactId,
          configSnapshot: schema.runs.configSnapshot,
          previewUrl: schema.runs.previewUrl,
          message: schema.runs.message,
          codingStartedAt: schema.runs.codingStartedAt,
          codingFinishedAt: schema.runs.codingFinishedAt,
          renderingStartedAt: schema.runs.renderingStartedAt,
          renderingFinishedAt: schema.runs.renderingFinishedAt,
          critiquingStartedAt: schema.runs.critiquingStartedAt,
          critiquingFinishedAt: schema.runs.critiquingFinishedAt,
        })
        .from(schema.nodes)
        .leftJoin(schema.runs, eq(schema.nodes.currentRunId, schema.runs.id));
      const rows = input?.canvasId
        ? base.where(eq(schema.nodes.canvasId, input.canvasId)).all()
        : base.all();
      // Bake each node's effective coder (lineage walk → registry default) so
      // the graph can label it — parity with `nodes.get` / the snapshot, which
      // already carry `resolvedCoderName`.
      const byId = new Map(rows.map((r) => [r.id, r] as const));
      const defaultName = ctx.config.defaultCoderName;
      // Resolve each output artifact's kind so the graph can pick a renderer
      // per node (video vs. still image vs. model vs. page). One query over the
      // distinct output ids, then a Map lookup — not a per-row round-trip.
      const outputIds = [
        ...new Set(
          rows
            .map((r) => r.outputArtifactId)
            .filter((id): id is string => id != null)
        ),
      ];
      const outputKindById = new Map<string, ArtifactKind>();
      if (outputIds.length > 0) {
        const arts = ctx.db
          .select({ id: schema.artifacts.id, kind: schema.artifacts.kind })
          .from(schema.artifacts)
          .where(inArray(schema.artifacts.id, outputIds))
          .all();
        for (const a of arts) outputKindById.set(a.id, a.kind);
      }
      // The full snapshot stays server-side; the graph only needs the
      // external-provenance bit (current run coded outside any adapter).
      return rows.map(({ configSnapshot, ...r }) => ({
        ...r,
        resolvedCoderName: resolveCoderNameInRows(r, byId, defaultName),
        external: configSnapshot?.coder.kind === EXTERNAL_CODER_KIND,
        outputKind: r.outputArtifactId
          ? outputKindById.get(r.outputArtifactId) ?? null
          : null,
      }));
    }),

  get: publicProcedure
    .input(z.object({ nodeId: z.string() }))
    .query(({ ctx, input }) => {
      const node = ctx.db
        .select()
        .from(schema.nodes)
        .where(eq(schema.nodes.id, input.nodeId))
        .get();
      if (!node) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `node ${input.nodeId}` });
      }
      const currentRun = node.currentRunId
        ? ctx.db
            .select()
            .from(schema.runs)
            .where(eq(schema.runs.id, node.currentRunId))
            .get() ?? null
        : null;
      // `retryable` lets the UI grey out the Retry button on coder nodes
      // that have continued descendants — cheaper than another round-trip
      // and keeps the rule colocated with the rejection in `retry`.
      const retryable =
        node.kind === 'coder'
          ? isLeafOfBranch(ctx.db, node)
          : node.kind === 'critique';
      // `hasSession` reports whether this node's branch has a live coder
      // session. The session lives on the branch anchor, so we resolve the
      // relevant coder (the node itself, or — for critique/config nodes — the
      // nearest ancestor coder) and read its anchor's session_id. The Reply
      // textbox gates input on it, and the Switch-coder modal gates the
      // "retain session" option on it (mirrored server-side).
      let hasSession = false;
      {
        const branchCoderId =
          node.kind === 'coder'
            ? node.id
            : resolveAncestorCoderId(ctx.db, node.parentId);
        const branchCoder =
          branchCoderId == null
            ? null
            : branchCoderId === node.id
              ? node
              : ctx.db
                  .select()
                  .from(schema.nodes)
                  .where(eq(schema.nodes.id, branchCoderId))
                  .get() ?? null;
        if (branchCoder) {
          const anchorId = branchCoder.branchAnchorId ?? branchCoder.id;
          if (anchorId === branchCoder.id) {
            hasSession = !!branchCoder.sessionId;
          } else {
            const anchor = ctx.db
              .select({ sessionId: schema.nodes.sessionId })
              .from(schema.nodes)
              .where(eq(schema.nodes.id, anchorId))
              .get();
            hasSession = !!anchor?.sessionId;
          }
        }
      }
      // The coder this node resolves to (lineage walk → registry default) plus
      // its adapter kind. The Retry/Switch modals use the kind to gate
      // session-retaining swaps to compatible adapters.
      const resolvedCoderName =
        resolveCoderName(ctx.db, node) ?? ctx.config.defaultCoderName;
      const resolvedCoderKind =
        ctx.config.coders.get(resolvedCoderName)?.kind ?? null;
      // The run's primary output artifact resolved to { kind, mime } so the
      // sidebar can pick how to present it (video / image / model / page)
      // without a second round-trip. Reads `outputArtifactId` (any OutputKind),
      // distinct from the video-specific `videoArtifactId`.
      const currentRunOutput: {
        artifactId: string;
        kind: ArtifactKind;
        mime: string;
      } | null = (() => {
        if (!currentRun?.outputArtifactId) return null;
        const art = ctx.db
          .select({
            id: schema.artifacts.id,
            kind: schema.artifacts.kind,
            mime: schema.artifacts.mime,
          })
          .from(schema.artifacts)
          .where(eq(schema.artifacts.id, currentRun.outputArtifactId))
          .get();
        return art
          ? { artifactId: art.id, kind: art.kind, mime: art.mime }
          : null;
      })();
      // Filesystem pointers for external tooling (`gaido node --json`): the
      // branch worktree (owned by the anchor; null for run-less marker kinds)
      // and the current run's log directory. The web UI ignores these.
      const canvasSlugRow = ctx.db
        .select({ slug: schema.canvases.slug })
        .from(schema.canvases)
        .where(eq(schema.canvases.id, node.canvasId))
        .get();
      const worktreePath =
        node.kind === 'coder' && canvasSlugRow
          ? ctx.workspace.workspacePath({
              nodeId: node.branchAnchorId ?? node.id,
              canvasSlug: canvasSlugRow.slug,
            })
          : null;
      const logDir = currentRun
        ? path.join(ctx.paths.logsDir, currentRun.id)
        : null;
      return {
        node,
        currentRun,
        retryable,
        hasSession,
        resolvedCoderName,
        resolvedCoderKind,
        currentRunOutput,
        worktreePath,
        logDir,
      };
    }),

  createRoot: publicProcedure
    .input(
      z.object({
        instruction: z.string().min(1),
        position: positionSchema,
        canvasId: z.string().optional(),
        skeletonName: z.string().optional(),
        coderName: z.string().optional(),
        references: z.array(referenceInputSchema).optional(),
        // Seed an auto-run: the root then code→critique→continues itself this
        // many coder cycles (counting the root). Omitted/1 → a single run with
        // a manual critique, the default. Needs a model critic to drive it.
        autoRun: z.number().int().min(1).max(AUTO_RUN_MAX).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (input.coderName && !ctx.config.coders.has(input.coderName)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `unknown coder '${input.coderName}'`,
        });
      }
      if (
        input.autoRun != null &&
        input.autoRun > 1 &&
        ctx.config.critic.kind === 'human'
      ) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            'auto-run needs a model critic to drive the loop — this project uses a human critic',
        });
      }
      const canvasId = resolveCanvasId(ctx.db, input.canvasId);
      const now = Date.now();
      // Drop the new instruction root on its own lane to the right of everything
      // already on the canvas — the same left-to-right root stacking
      // layoutCanvasNodes() produces, but computed incrementally so seeding a
      // root never disturbs the canvas's existing nodes. `positionX` is each
      // card's left edge and every card is one column (SIBLING_X_STEP) wide, so
      // `maxX + 2·step` clears the rightmost card and leaves one empty gap column
      // between subtrees. Empty canvas → origin.
      const existing = ctx.db
        .select({ positionX: schema.nodes.positionX })
        .from(schema.nodes)
        .where(eq(schema.nodes.canvasId, canvasId))
        .all();
      const positionX =
        input.position?.x ??
        (existing.length
          ? Math.max(...existing.map((n) => n.positionX)) + 2 * SIBLING_X_STEP
          : 0);
      const positionY = input.position?.y ?? 0;

      // The root is a settled `instruction` marker holding the prompt; the coder
      // that actually runs hangs beneath a `config` marker recording the
      // coder+skeleton choice (see insertRootBranch).
      const promptId = newNodeId();
      ctx.db
        .insert(schema.nodes)
        .values({
          id: promptId,
          parentId: null,
          canvasId,
          kind: 'instruction',
          positionX,
          positionY,
          instruction: input.instruction,
          status: 'done',
          isFavorite: false,
          createdAt: now,
          updatedAt: now,
        })
        .run();

      const { coderId } = insertRootBranch(ctx.db, {
        prompt: { id: promptId, canvasId },
        instruction: input.instruction,
        coderName: input.coderName ?? null,
        skeletonName: input.skeletonName ?? null,
        x: positionX,
        y: nextChildY(positionY, INSTRUCTION_CARD_HEIGHT),
        autoRun: input.autoRun,
        now,
      });

      // References + any auto-run budget live on the coder (the runnable node),
      // not the run-less root. Return the coder as `node` so callers keep
      // selecting the node that runs.
      await bindInlineReferences(ctx, coderId, input.references);
      const run = ctx.orchestrator.startRun(coderId);
      const node = ctx.db
        .select()
        .from(schema.nodes)
        .where(eq(schema.nodes.id, coderId))
        .get()!;
      return { node, run };
    }),

  /**
   * Batch / compare: one shared `instruction` root fanned out into N branches,
   * one per (coder × skeleton) combination the artist picked. Each branch is a
   * `config` marker + `coder` (see insertRootBranch) seeding its own skeleton
   * and running the same prompt — so several models/skeletons can be compared
   * side by side. References are shared (bound onto every branch coder). No
   * auto-run here: it would multiply cycles across every branch; use a single
   * root's auto-run or Continue for iteration.
   */
  createBatch: publicProcedure
    .input(
      z.object({
        instruction: z.string().min(1),
        position: positionSchema,
        canvasId: z.string().optional(),
        combinations: z
          .array(
            z.object({
              coderName: z.string(),
              skeletonName: z.string().optional(),
            })
          )
          .min(1),
        references: z.array(referenceInputSchema).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      for (const combo of input.combinations) {
        if (!ctx.config.coders.has(combo.coderName)) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `unknown coder '${combo.coderName}'`,
          });
        }
      }
      const canvasId = resolveCanvasId(ctx.db, input.canvasId);
      const now = Date.now();
      const existing = ctx.db
        .select({ positionX: schema.nodes.positionX })
        .from(schema.nodes)
        .where(eq(schema.nodes.canvasId, canvasId))
        .all();
      const positionX =
        input.position?.x ??
        (existing.length
          ? Math.max(...existing.map((n) => n.positionX)) + 2 * SIBLING_X_STEP
          : 0);
      const positionY = input.position?.y ?? 0;

      const promptId = newNodeId();
      ctx.db
        .insert(schema.nodes)
        .values({
          id: promptId,
          parentId: null,
          canvasId,
          kind: 'instruction',
          positionX,
          positionY,
          instruction: input.instruction,
          status: 'done',
          isFavorite: false,
          createdAt: now,
          updatedAt: now,
        })
        .run();

      // Fan the branches out horizontally from the root's column; Re-layout
      // later re-centres the root above them via the tidy-tree.
      const branchY = nextChildY(positionY, INSTRUCTION_CARD_HEIGHT);
      const coderIds = input.combinations.map((combo, i) => {
        const { coderId } = insertRootBranch(ctx.db, {
          prompt: { id: promptId, canvasId },
          instruction: input.instruction,
          coderName: combo.coderName,
          skeletonName: combo.skeletonName ?? null,
          x: positionX + i * SIBLING_X_STEP,
          y: branchY,
          now,
        });
        return coderId;
      });

      // Shared references land on every branch coder (row copies, the same
      // inheritance shape fork/continue use). Best-effort, per coder.
      for (const coderId of coderIds) {
        await bindInlineReferences(ctx, coderId, input.references);
      }
      const runs = coderIds.map((coderId) => ctx.orchestrator.startRun(coderId));
      const node = ctx.db
        .select()
        .from(schema.nodes)
        .where(eq(schema.nodes.id, promptId))
        .get()!;
      return { node, coderIds, runs };
    }),

  /**
   * Create a coder child under a critique parent. Forking from a coder
   * directly is rejected — chain integrity (coder → critique → coder) is
   * enforced here. The UI fork action on a coder card resolves to the
   * coder's auto-spawned critique child before calling this.
   */
  createChild: publicProcedure
    .input(
      z.object({
        parentId: z.string(),
        instruction: z.string().min(1),
        position: positionSchema,
        references: z.array(referenceInputSchema).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const parent = ctx.db
        .select()
        .from(schema.nodes)
        .where(eq(schema.nodes.id, input.parentId))
        .get();
      if (!parent) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `parent node ${input.parentId}`,
        });
      }
      if (parent.kind !== 'critique') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'fork parent must be a critique node',
        });
      }
      const id = newNodeId();
      const now = Date.now();
      // Default child position offsets below the parent's actual rendered
      // height (estimated from critique content) if none supplied.
      const parentRun = parent.currentRunId
        ? ctx.db
            .select()
            .from(schema.runs)
            .where(eq(schema.runs.id, parent.currentRunId))
            .get() ?? null
        : null;
      // Spread sibling forks horizontally so the second fork from a critique
      // doesn't stack invisibly behind the first. New sibling lands one
      // card-width + gap to the right of the rightmost existing coder child.
      const existingChildren = ctx.db
        .select({ positionX: schema.nodes.positionX })
        .from(schema.nodes)
        .where(
          and(
            eq(schema.nodes.parentId, parent.id),
            eq(schema.nodes.kind, 'coder')
          )
        )
        .all();
      const rightmost = existingChildren.length
        ? Math.max(...existingChildren.map((c) => c.positionX))
        : parent.positionX - SIBLING_X_STEP;
      const x = input.position?.x ?? rightmost + SIBLING_X_STEP;
      const y =
        input.position?.y ??
        nextChildY(parent.positionY, critiqueCardHeight(parentRun?.critique));

      ctx.db
        .insert(schema.nodes)
        .values({
          id,
          parentId: parent.id,
          canvasId: parent.canvasId,
          kind: 'coder',
          positionX: x,
          positionY: y,
          instruction: input.instruction,
          status: 'idle',
          isFavorite: false,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      // Forks inherit the ancestor coder's references, then layer on any the
      // artist attached in the fork modal.
      const ancestorCoderId = resolveAncestorCoderId(ctx.db, parent.id);
      if (ancestorCoderId) inheritReferences(ctx, ancestorCoderId, id);
      await bindInlineReferences(ctx, id, input.references);
      const run = ctx.orchestrator.startRun(id);
      const node = ctx.db
        .select()
        .from(schema.nodes)
        .where(eq(schema.nodes.id, id))
        .get()!;
      return { node, run };
    }),

  /**
   * Create an *external* coder node: a slot for code authored outside gaido —
   * a human editing by hand, or an agent driven through `gaido fork` /
   * `gaido submit`. Same graph shape as a fork (coder under the critique;
   * pointing at a coder resolves to its critique child like the UI fork
   * action), same worktree mechanics (fresh branch off the parent iteration's
   * commit), but NO coder adapter runs: the worktree is created immediately
   * and handed back for direct editing, and the node stays `idle` until
   * `submitExternal` commits + renders it.
   */
  forkExternal: publicProcedure
    .input(
      z.object({
        parentId: z.string(),
        instruction: z.string().min(1),
        references: z.array(referenceInputSchema).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const parent = ctx.db
        .select()
        .from(schema.nodes)
        .where(eq(schema.nodes.id, input.parentId))
        .get();
      if (!parent) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `parent node ${input.parentId}`,
        });
      }
      // Accept a coder for convenience (resolve to its critique child, the
      // same normalization the UI fork does) or the critique itself.
      let critique: Node;
      if (parent.kind === 'critique') {
        critique = parent;
      } else if (parent.kind === 'coder') {
        const child = ctx.db
          .select()
          .from(schema.nodes)
          .where(
            and(
              eq(schema.nodes.parentId, parent.id),
              eq(schema.nodes.kind, 'critique')
            )
          )
          .get();
        if (!child) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message:
              'this coder has no critique child yet — it must finish a successful run before forking from it',
          });
        }
        critique = child;
      } else {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `cannot fork from a ${parent.kind} node`,
        });
      }

      const id = newNodeId();
      const now = Date.now();
      const critiqueRun = critique.currentRunId
        ? ctx.db
            .select()
            .from(schema.runs)
            .where(eq(schema.runs.id, critique.currentRunId))
            .get() ?? null
        : null;
      const existingChildren = ctx.db
        .select({ positionX: schema.nodes.positionX })
        .from(schema.nodes)
        .where(
          and(
            eq(schema.nodes.parentId, critique.id),
            eq(schema.nodes.kind, 'coder')
          )
        )
        .all();
      const rightmost = existingChildren.length
        ? Math.max(...existingChildren.map((c) => c.positionX))
        : critique.positionX - SIBLING_X_STEP;

      ctx.db
        .insert(schema.nodes)
        .values({
          id,
          parentId: critique.id,
          canvasId: critique.canvasId,
          kind: 'coder',
          positionX: rightmost + SIBLING_X_STEP,
          positionY: nextChildY(
            critique.positionY,
            critiqueCardHeight(critiqueRun?.critique)
          ),
          instruction: input.instruction,
          status: 'idle',
          isFavorite: false,
          createdAt: now,
          updatedAt: now,
        })
        .run();

      const ancestorCoderId = resolveAncestorCoderId(ctx.db, critique.id);
      if (ancestorCoderId) inheritReferences(ctx, ancestorCoderId, id);
      await bindInlineReferences(ctx, id, input.references);

      // Create the worktree NOW (a normal fork defers this to the coding
      // phase) so the caller gets a directory to edit. Branch off the parent
      // iteration's exact commit; a no-diff ancestor run falls back to its
      // branch tip, and a legacy/empty lineage to the default seed.
      const canvasSlug = ctx.db
        .select({ slug: schema.canvases.slug })
        .from(schema.canvases)
        .where(eq(schema.canvases.id, critique.canvasId))
        .get()?.slug;
      if (!canvasSlug) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `canvas ${critique.canvasId} missing`,
        });
      }
      const ancestor = ancestorCoderId
        ? ctx.db
            .select()
            .from(schema.nodes)
            .where(eq(schema.nodes.id, ancestorCoderId))
            .get() ?? null
        : null;
      let basisCommit: string | undefined;
      if (ancestor?.currentRunId) {
        basisCommit =
          ctx.db
            .select({ commitSha: schema.runs.commitSha })
            .from(schema.runs)
            .where(eq(schema.runs.id, ancestor.currentRunId))
            .get()?.commitSha ?? undefined;
      }
      if (!basisCommit && ancestor) {
        basisCommit =
          (await ctx.workspace.resolveBranchTip(
            ancestor.branchAnchorId ?? ancestor.id
          )) ?? undefined;
      }
      const worktreePath = await ctx.workspace.ensureNodeWorkspace({
        nodeId: id,
        canvasSlug,
        ...(basisCommit ? { basisCommit } : {}),
      });

      const node = ctx.db
        .select()
        .from(schema.nodes)
        .where(eq(schema.nodes.id, id))
        .get()!;
      return { node, worktreePath };
    }),

  /**
   * Submit a directly-edited worktree as a new run on `nodeId` — the second
   * half of the external-edit flow (`forkExternal` → edit files → submit).
   * Commits the diff and runs ONLY the render phase; the run's config
   * snapshot marks the coder as `'external'`. Also legal on any non-running
   * leaf coder, where it stacks a new commit on that node's branch (the
   * "I hand-tweaked the leaf in place" case). `runCritique` immediately runs
   * the critic on the auto-spawned critique child — needs a model critic.
   */
  submitExternal: publicProcedure
    .input(
      z.object({
        nodeId: z.string(),
        /** Optional replacement for the node's card text — what this edit is. */
        instruction: z.string().min(1).optional(),
        runCritique: z.boolean().optional(),
      })
    )
    .mutation(({ ctx, input }) => {
      const node = ctx.db
        .select()
        .from(schema.nodes)
        .where(eq(schema.nodes.id, input.nodeId))
        .get();
      if (!node) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `node ${input.nodeId}` });
      }
      if (node.kind !== 'coder') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'submit is only valid on coder nodes',
        });
      }
      if (node.status === 'running') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'a run is in flight on this node — cancel it before submitting',
        });
      }
      // Same leaf rule as Retry: the branch tip past a continued node is a
      // later iteration's code, so committing/rendering here is incoherent.
      if (!isLeafOfBranch(ctx.db, node)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            'this coder has continued descendants on its branch — fork externally instead of submitting in place',
        });
      }
      if (input.runCritique && ctx.config.critic.kind === 'human') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            'runCritique needs a model critic — this project uses a human critic (review in the UI instead)',
        });
      }
      if (input.instruction) {
        ctx.db
          .update(schema.nodes)
          .set({ instruction: input.instruction, updatedAt: Date.now() })
          .where(eq(schema.nodes.id, node.id))
          .run();
      }
      const run = ctx.orchestrator.submitExternal(node.id, {
        runCritique: input.runCritique ?? false,
      });
      const fresh = ctx.db
        .select()
        .from(schema.nodes)
        .where(eq(schema.nodes.id, node.id))
        .get()!;
      return { node: fresh, run };
    }),

  retry: publicProcedure
    .input(
      z.object({
        nodeId: z.string(),
        prompt: z.string().optional(),
        // Swap the coder/model for this re-run (e.g. sonnet → opus). The new
        // coder sticks on the node and is inherited by descendants. Gated to
        // session-compatible adapters when the branch already has a live
        // session — see the validation below. Use a config switch for an
        // incompatible swap (it starts a fresh session).
        coderName: z.string().optional(),
      })
    )
    .mutation(({ ctx, input }) => {
      const node = ctx.db
        .select()
        .from(schema.nodes)
        .where(eq(schema.nodes.id, input.nodeId))
        .get();
      if (!node) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `node ${input.nodeId}`,
        });
      }
      // Settled markers (instruction root, config switch) have no run to
      // re-run — reject before we'd otherwise startRun a non-coder. The UI
      // doesn't offer Retry on them, but the debug bridge could.
      if (node.kind !== 'coder' && node.kind !== 'critique') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `cannot retry a ${node.kind} node`,
        });
      }
      // Coder retries are only valid for the leaf of a branch: anything
      // else would re-run an earlier iteration's instruction against the
      // worktree's current (post-continuation) state, which is incoherent.
      // Critique children don't count; forked descendants (different
      // anchor) don't either. Critique nodes themselves stay retryable
      // since they have no branch.
      if (node.kind === 'coder' && !isLeafOfBranch(ctx.db, node)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            'this coder has continued descendants on its branch — continue or fork instead of retry',
        });
      }
      if (input.coderName) {
        if (node.kind !== 'coder') {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'coder swap is only valid on coder nodes',
          });
        }
        if (!ctx.config.coders.has(input.coderName)) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `unknown coder '${input.coderName}'`,
          });
        }
        // A live session can only be resumed under a same-kind adapter.
        const anchorId = node.branchAnchorId ?? node.id;
        const anchor =
          anchorId === node.id
            ? node
            : ctx.db
                .select()
                .from(schema.nodes)
                .where(eq(schema.nodes.id, anchorId))
                .get() ?? node;
        if (anchor.sessionId) {
          const currentName =
            resolveCoderName(ctx.db, node) ?? ctx.config.defaultCoderName;
          const currentKind = ctx.config.coders.get(currentName)?.kind;
          const nextKind = ctx.config.coders.get(input.coderName)?.kind;
          if (currentKind && nextKind && currentKind !== nextKind) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: `cannot resume a ${currentKind} session under '${input.coderName}' (${nextKind}) — switch coder with a config node to start a fresh session`,
            });
          }
        }
        ctx.db
          .update(schema.nodes)
          .set({ coderName: input.coderName, updatedAt: Date.now() })
          .where(eq(schema.nodes.id, node.id))
          .run();
      }
      // An optional `prompt` lets the artist steer the re-run — e.g. after a
      // failure. It's carried as the run's `artistFollowUp`: on a coder with
      // a live session it lands as the next turn; on a fresh session the
      // orchestrator folds it into the composed instruction. Critique nodes
      // have no path to feed it to the critic, so it's ignored there (the UI
      // only offers the prompt on coder retries). Empty/whitespace → a plain
      // retry, identical to the prior behavior.
      const prompt = input.prompt?.trim();
      // If a run is in flight, abort it before queuing the next one.
      ctx.orchestrator.cancel(node.id);
      return ctx.orchestrator.startRun(
        node.id,
        prompt ? { artistFollowUp: prompt } : undefined
      );
    }),

  /**
   * Re-run ONLY the rendering phase of a coder node's current run — for a
   * transient renderer failure where the coder already coded + committed but
   * the render flaked, so the whole run landed `failed`. Reuses the run + its
   * commit (no coder turn, no tokens, no risk of different code) and repeats
   * the render against the worktree. Gated to a renderable leaf coder whose
   * run finished coding, isn't in flight, and didn't intentionally skip the
   * render. Use Retry instead to re-run the coder from scratch.
   */
  rerunRender: publicProcedure
    .input(z.object({ nodeId: z.string() }))
    .mutation(({ ctx, input }) => {
      const node = ctx.db
        .select()
        .from(schema.nodes)
        .where(eq(schema.nodes.id, input.nodeId))
        .get();
      if (!node) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `node ${input.nodeId}` });
      }
      if (node.kind !== 'coder') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'only coder nodes render',
        });
      }
      // Same leaf rule as Retry: a continued coder's branch tip is a later
      // iteration's commit, so re-rendering the worktree would render that, not
      // this node's code. (A failed-render coder is always a leaf — you can't
      // continue past a failed node — but keep the guard explicit.)
      if (!isLeafOfBranch(ctx.db, node)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            'this coder has continued descendants — its code is no longer at the branch tip; fork instead',
        });
      }
      const run = node.currentRunId
        ? ctx.db
            .select()
            .from(schema.runs)
            .where(eq(schema.runs.id, node.currentRunId))
            .get() ?? null
        : null;
      if (!run) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'node has no run to render',
        });
      }
      if (run.status === 'running') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'run is still in progress',
        });
      }
      // Coding must have completed — there has to be committed code to
      // render. External runs never have a coding phase; their branch tip
      // IS the code, so they're always renderable.
      const isExternalRun =
        run.configSnapshot?.coder.kind === EXTERNAL_CODER_KIND;
      if (!run.codingFinishedAt && !isExternalRun) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            'this run never finished coding — retry instead of re-rendering',
        });
      }
      // A run whose coder opted out of producing an artifact (MESSAGE.md with
      // producedArtifact=false) has nothing to render.
      if (run.message && !run.message.producedArtifact) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'this run intentionally produced no render',
        });
      }
      return ctx.orchestrator.rerunRender(node.id);
    }),

  /**
   * Reply to a coder's MESSAGE.md in-thread: stack a new run on the same
   * node that resumes the coder's Claude Code session with `text` as the
   * next turn. The text is persisted on the new run's `artistFollowUp`
   * column so the UI thread can render it. Requires the node to already
   * have a session (i.e., at least one prior coder run completed) — a
   * follow-up on a fresh node would silently displace the framework
   * preamble + instruction the coder needs on turn 1.
   */
  reply: publicProcedure
    .input(z.object({ nodeId: z.string(), text: z.string().min(1) }))
    .mutation(({ ctx, input }) => {
      const node = ctx.db
        .select()
        .from(schema.nodes)
        .where(eq(schema.nodes.id, input.nodeId))
        .get();
      if (!node) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `node ${input.nodeId}`,
        });
      }
      if (node.kind !== 'coder') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'reply only valid on coder nodes',
        });
      }
      if (!isLeafOfBranch(ctx.db, node)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            'this coder has continued descendants on its branch — fork instead of replying in-place',
        });
      }
      // Need a live session for the reply to land as the next turn. Walk to
      // the anchor since that's where the session lives for continued nodes.
      const anchorId = node.branchAnchorId ?? node.id;
      const anchor =
        anchorId === node.id
          ? node
          : ctx.db
              .select()
              .from(schema.nodes)
              .where(eq(schema.nodes.id, anchorId))
              .get() ?? node;
      if (!anchor.sessionId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            'no live session yet — wait for the first run to finish before replying',
        });
      }
      // Cancel anything in flight so we don't race a new run on top of it.
      ctx.orchestrator.cancel(node.id);
      return ctx.orchestrator.startRun(node.id, { artistFollowUp: input.text });
    }),

  /**
   * Continue iterating: spawn a new coder child under the critique on the
   * SAME branch as the parent coder (resumed session + reused worktree) with
   * the critique feedback as its instruction, then run it. The node creation
   * lives in `createContinuationCoder`, shared with the orchestrator's auto-run
   * advance so manual and automatic continuation behave identically.
   */
  continue: publicProcedure
    .input(z.object({ critiqueNodeId: z.string() }))
    .mutation(({ ctx, input }) => {
      const result = createContinuationCoder(ctx, input.critiqueNodeId);
      if (!result.ok) {
        if (result.reason === 'missing') {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: `node ${input.critiqueNodeId}`,
          });
        }
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            result.reason === 'not-critique'
              ? 'continue requires a critique node'
              : result.reason === 'no-parent'
                ? 'critique node has no parent coder'
                : 'save notes before continuing',
        });
      }
      const run = ctx.orchestrator.startRun(result.coderId);
      const node = ctx.db
        .select()
        .from(schema.nodes)
        .where(eq(schema.nodes.id, result.coderId))
        .get()!;
      return { node, run };
    }),

  /**
   * Start an auto-run from an existing leaf node: the code → critique →
   * continue cycle then advances itself `iterations` times (counting the
   * current coder) with no further clicks. Resolves where to begin:
   *
   * - **critique** → run its critic; the parent coder is cycle 1.
   * - **done coder** → run its critique child (no re-code); this coder is cycle 1.
   * - **failed/idle/interrupted coder leaf** → re-run this coder as cycle 1.
   *
   * The budget is stamped on that start node; the orchestrator carries it
   * forward. Needs a model critic (the loop can't drive a human one). Returns
   * the node the loop actually started on so the UI can follow it.
   */
  autoRun: publicProcedure
    .input(
      z.object({
        nodeId: z.string(),
        iterations: z.number().int().min(1).max(AUTO_RUN_MAX),
      })
    )
    .mutation(({ ctx, input }) => {
      const node = ctx.db
        .select()
        .from(schema.nodes)
        .where(eq(schema.nodes.id, input.nodeId))
        .get();
      if (!node) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `node ${input.nodeId}` });
      }
      if (ctx.config.critic.kind === 'human') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            'auto-run needs a model critic to drive the loop — this project uses a human critic',
        });
      }
      if (node.kind === 'config') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'cannot auto-run a config node',
        });
      }
      if (node.status === 'running') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'this node is already running',
        });
      }

      const setBudget = (id: string) =>
        ctx.db
          .update(schema.nodes)
          .set({
            autoRunTotal: input.iterations,
            autoRunRemaining: input.iterations,
            updatedAt: Date.now(),
          })
          .where(eq(schema.nodes.id, id))
          .run();

      let startId: string;
      if (node.kind === 'critique') {
        // Run (or re-run) the critic; its parent coder is cycle 1.
        startId = node.id;
        setBudget(startId);
      } else if (node.status === 'done') {
        // Forward from the auto-spawned critique child — don't re-code work the
        // artist already accepted. The done coder is cycle 1.
        const critique = ctx.db
          .select()
          .from(schema.nodes)
          .where(
            and(
              eq(schema.nodes.parentId, node.id),
              eq(schema.nodes.kind, 'critique')
            )
          )
          .get();
        if (!critique) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message:
              'this run produced no critique to iterate from — retry the coder instead',
          });
        }
        if (critique.status === 'running') {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'the critique is already running',
          });
        }
        startId = critique.id;
        setBudget(startId);
      } else {
        // A leaf coder that hasn't landed a render (failed/cancelled/
        // interrupted/idle): re-run it as cycle 1. Same leaf rule as Retry.
        if (!isLeafOfBranch(ctx.db, node)) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message:
              'this coder has continued descendants — auto-run from a later critique instead',
          });
        }
        startId = node.id;
        setBudget(startId);
      }

      const run = ctx.orchestrator.startRun(startId);
      return { nodeId: startId, run };
    }),

  /**
   * Interrupt the auto-run reachable from `nodeId` (itself or a descendant).
   * Two flavours, both clearing the budget so the loop won't advance when the
   * current step lands:
   *
   * - `'after'` → soft: let the in-flight coder/critic finish its step, then
   *   stop. No wasted work; the node lands `done`.
   * - `'now'`   → hard: also abort the in-flight run immediately (lands
   *   `cancelled`).
   *
   * Either way there's no "resume the remaining N" — the artist starts a fresh
   * auto-run from wherever it stopped.
   */
  interruptAuto: publicProcedure
    .input(z.object({ nodeId: z.string(), mode: z.enum(['now', 'after']) }))
    .mutation(({ ctx, input }) => {
      const frontier = findAutoRunFrontier(ctx.db, input.nodeId);
      if (!frontier) return { ok: true as const, stopped: null };
      ctx.db
        .update(schema.nodes)
        .set({ autoRunTotal: null, autoRunRemaining: null, updatedAt: Date.now() })
        .where(eq(schema.nodes.id, frontier.id))
        .run();
      if (input.mode === 'now') ctx.orchestrator.cancel(frontier.id);
      return { ok: true as const, stopped: frontier.id };
    }),

  /**
   * Switch coder mid-graph. Inserts a `config` node under the critique that
   * records the chosen coder + session policy (a settled marker — no run),
   * then spawns one coder beneath it wired to that policy and starts it:
   *
   * - `retain` → the coder shares the branch anchor (Continue semantics): it
   *   resumes the existing session under the new coder. Only valid when the
   *   new coder is session-compatible (same adapter `kind`) and a session
   *   exists.
   * - `reset`  → the coder owns a fresh branch off the parent coder's tip
   *   (Fork semantics): same code, brand-new session. The only option for an
   *   incompatible switch.
   *
   * The spawned coder leaves `coderName` null and inherits the config node's
   * choice by lineage walk, so descendants keep the new coder until the next
   * config node.
   */
  switchCoder: publicProcedure
    .input(
      z.object({
        critiqueNodeId: z.string(),
        coderName: z.string(),
        sessionPolicy: z.enum(['retain', 'reset']),
        instruction: z.string().min(1),
        references: z.array(referenceInputSchema).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const critique = ctx.db
        .select()
        .from(schema.nodes)
        .where(eq(schema.nodes.id, input.critiqueNodeId))
        .get();
      if (!critique) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `node ${input.critiqueNodeId}`,
        });
      }
      if (critique.kind !== 'critique') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'switch coder requires a critique node',
        });
      }
      if (!critique.parentId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'critique node has no parent coder',
        });
      }
      if (!ctx.config.coders.has(input.coderName)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `unknown coder '${input.coderName}'`,
        });
      }
      const parentCoder = ctx.db
        .select()
        .from(schema.nodes)
        .where(eq(schema.nodes.id, critique.parentId))
        .get();
      if (!parentCoder) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `parent coder ${critique.parentId}`,
        });
      }
      const anchorId = parentCoder.branchAnchorId ?? parentCoder.id;
      const anchor =
        anchorId === parentCoder.id
          ? parentCoder
          : ctx.db
              .select()
              .from(schema.nodes)
              .where(eq(schema.nodes.id, anchorId))
              .get() ?? parentCoder;

      // Retain resumes the branch's session under the new coder — only valid
      // when a session exists and the new coder is session-compatible.
      if (input.sessionPolicy === 'retain') {
        if (!anchor.sessionId) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'no live session to retain — choose reset',
          });
        }
        const currentName =
          resolveCoderName(ctx.db, parentCoder) ?? ctx.config.defaultCoderName;
        const currentKind = ctx.config.coders.get(currentName)?.kind;
        const nextKind = ctx.config.coders.get(input.coderName)?.kind;
        if (currentKind && nextKind && currentKind !== nextKind) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `cannot retain a ${currentKind} session under '${input.coderName}' (${nextKind}) — choose reset to start a fresh session`,
          });
        }
      }

      const now = Date.now();
      // Spread among ALL the critique's existing children (forks, continues,
      // and prior config switches) so a second switch doesn't stack on top.
      const existingChildren = ctx.db
        .select({ positionX: schema.nodes.positionX })
        .from(schema.nodes)
        .where(eq(schema.nodes.parentId, critique.id))
        .all();
      const rightmost = existingChildren.length
        ? Math.max(...existingChildren.map((c) => c.positionX))
        : critique.positionX - SIBLING_X_STEP;
      const x = rightmost + SIBLING_X_STEP;
      const critiqueRun = critique.currentRunId
        ? ctx.db
            .select()
            .from(schema.runs)
            .where(eq(schema.runs.id, critique.currentRunId))
            .get() ?? null
        : null;
      const configY = nextChildY(
        critique.positionY,
        critiqueCardHeight(critiqueRun?.critique)
      );

      // 1. Config node — a settled marker with no run.
      const configId = newNodeId();
      const policyLabel =
        input.sessionPolicy === 'retain' ? 'retain session' : 'reset session';
      ctx.db
        .insert(schema.nodes)
        .values({
          id: configId,
          parentId: critique.id,
          canvasId: parentCoder.canvasId,
          kind: 'config',
          positionX: x,
          positionY: configY,
          instruction: `Switch to ${input.coderName} · ${policyLabel}`,
          coderName: input.coderName,
          sessionPolicy: input.sessionPolicy,
          status: 'done',
          isFavorite: false,
          createdAt: now,
          updatedAt: now,
        })
        .run();

      // 2. Coder under the config node, wired to the policy. Leaves coderName
      // null — it inherits the config node's choice by lineage walk.
      const coderId = newNodeId();
      ctx.db
        .insert(schema.nodes)
        .values({
          id: coderId,
          parentId: configId,
          canvasId: parentCoder.canvasId,
          kind: 'coder',
          positionX: x,
          positionY: nextChildY(configY, CONFIG_CARD_HEIGHT),
          instruction: input.instruction,
          // retain → share the anchor (resume session); reset → own branch.
          ...(input.sessionPolicy === 'retain'
            ? { branchAnchorId: anchorId }
            : {}),
          status: 'idle',
          isFavorite: false,
          createdAt: now,
          updatedAt: now,
        })
        .run();

      // Carry the parent coder's references onto the new coder, then layer on
      // any attached in the switch modal.
      inheritReferences(ctx, parentCoder.id, coderId);
      await bindInlineReferences(ctx, coderId, input.references);

      const run = ctx.orchestrator.startRun(coderId);
      const node = ctx.db
        .select()
        .from(schema.nodes)
        .where(eq(schema.nodes.id, coderId))
        .get()!;
      const configNode = ctx.db
        .select()
        .from(schema.nodes)
        .where(eq(schema.nodes.id, configId))
        .get()!;
      return { node, configNode, run };
    }),

  cancel: publicProcedure
    .input(z.object({ nodeId: z.string() }))
    .mutation(({ ctx, input }) => {
      ctx.orchestrator.cancel(input.nodeId);
      return { ok: true as const };
    }),

  setFavorite: publicProcedure
    .input(z.object({ nodeId: z.string(), isFavorite: z.boolean() }))
    .mutation(({ ctx, input }) => {
      const now = Date.now();
      ctx.db
        .update(schema.nodes)
        .set({ isFavorite: input.isFavorite, updatedAt: now })
        .where(eq(schema.nodes.id, input.nodeId))
        .run();
      const node = ctx.db
        .select()
        .from(schema.nodes)
        .where(eq(schema.nodes.id, input.nodeId))
        .get();
      if (!node) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `node ${input.nodeId}`,
        });
      }
      return node;
    }),

  /**
   * Set (or clear, with null/blank) a node's margin note — free text like
   * "published as hero-loop on videoeffects.com", authored by the artist or
   * an external agent (`gaido note`). Shown on the card; purely descriptive,
   * no orchestration meaning.
   */
  setNote: publicProcedure
    .input(z.object({ nodeId: z.string(), note: z.string().max(2000).nullable() }))
    .mutation(({ ctx, input }) => {
      const node = ctx.db
        .select()
        .from(schema.nodes)
        .where(eq(schema.nodes.id, input.nodeId))
        .get();
      if (!node) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `node ${input.nodeId}` });
      }
      const note = input.note?.trim() || null;
      ctx.db
        .update(schema.nodes)
        .set({ note, updatedAt: Date.now() })
        .where(eq(schema.nodes.id, input.nodeId))
        .run();
      return ctx.db
        .select()
        .from(schema.nodes)
        .where(eq(schema.nodes.id, input.nodeId))
        .get()!;
    }),

  setPosition: publicProcedure
    .input(
      z.object({ nodeId: z.string(), x: z.number(), y: z.number() })
    )
    .mutation(({ ctx, input }) => {
      const now = Date.now();
      ctx.db
        .update(schema.nodes)
        .set({ positionX: input.x, positionY: input.y, updatedAt: now })
        .where(eq(schema.nodes.id, input.nodeId))
        .run();
      return { ok: true as const };
    }),

  /**
   * Recompute positions for every node in a canvas using the tidy-tree
   * layout (see apps/server/src/layout.ts). Persists results so refresh
   * and subsequent manual drags survive. Critique heights come from each
   * node's current run, so a long critique pushes its descendants down.
   */
  relayout: publicProcedure
    .input(z.object({ canvasId: z.string() }))
    .mutation(({ ctx, input }) => {
      const rows = ctx.db
        .select({
          id: schema.nodes.id,
          parentId: schema.nodes.parentId,
          kind: schema.nodes.kind,
          createdAt: schema.nodes.createdAt,
          currentRunId: schema.nodes.currentRunId,
        })
        .from(schema.nodes)
        .where(eq(schema.nodes.canvasId, input.canvasId))
        .all();

      const runIds = rows
        .map((r) => r.currentRunId)
        .filter((id): id is string => id != null);
      const critiqueByNodeId = new Map<string, Critique | null>();
      if (runIds.length > 0) {
        const runs = ctx.db
          .select({
            id: schema.runs.id,
            nodeId: schema.runs.nodeId,
            critique: schema.runs.critique,
          })
          .from(schema.runs)
          .where(inArray(schema.runs.id, runIds))
          .all();
        for (const r of runs) {
          critiqueByNodeId.set(r.nodeId, r.critique ?? null);
        }
      }

      const positions = layoutCanvasNodes(rows, critiqueByNodeId);
      const now = Date.now();
      ctx.db.transaction((tx) => {
        for (const [id, pos] of positions) {
          tx.update(schema.nodes)
            .set({ positionX: pos.x, positionY: pos.y, updatedAt: now })
            .where(eq(schema.nodes.id, id))
            .run();
        }
      });
      return { ok: true as const, count: positions.size };
    }),

  delete: publicProcedure
    .input(z.object({ nodeId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // Walk the subtree, collect node ids, then delete events/artifacts/runs/nodes.
      const toDelete: string[] = [];
      const queue = [input.nodeId];
      while (queue.length > 0) {
        const id = queue.shift()!;
        toDelete.push(id);
        const children = ctx.db
          .select({ id: schema.nodes.id })
          .from(schema.nodes)
          .where(eq(schema.nodes.parentId, id))
          .all();
        for (const c of children) queue.push(c.id);
      }

      if (toDelete.length === 0) return { ok: true as const };

      const runs = ctx.db
        .select({ id: schema.runs.id })
        .from(schema.runs)
        .where(inArray(schema.runs.nodeId, toDelete))
        .all();
      const runIds = runs.map((r: { id: string }) => r.id);

      // Cancel any in-flight runs we're about to delete.
      for (const id of toDelete) ctx.orchestrator.cancel(id);

      // Cache canvas slug per id so each node's path lookups share one DB hit.
      const canvasSlugByNodeId = new Map<string, string>();
      const slugForNode = (nodeId: string): string | null => {
        const cached = canvasSlugByNodeId.get(nodeId);
        if (cached) return cached;
        const row = ctx.db
          .select({ slug: schema.canvases.slug })
          .from(schema.nodes)
          .innerJoin(schema.canvases, eq(schema.nodes.canvasId, schema.canvases.id))
          .where(eq(schema.nodes.id, nodeId))
          .get();
        if (!row) return null;
        canvasSlugByNodeId.set(nodeId, row.slug);
        return row.slug;
      };

      // Only anchors own a worktree+branch. Continued nodes share their
      // anchor's directory, so their delete doesn't touch the filesystem.
      const anchorIds = ctx.db
        .select({ id: schema.nodes.id })
        .from(schema.nodes)
        .where(inArray(schema.nodes.id, toDelete))
        .all()
        .filter((n) => {
          const row = ctx.db
            .select({ branchAnchorId: schema.nodes.branchAnchorId })
            .from(schema.nodes)
            .where(eq(schema.nodes.id, n.id))
            .get();
          return row?.branchAnchorId == null;
        })
        .map((n) => n.id);
      for (const id of [...anchorIds].reverse()) {
        const slug = slugForNode(id);
        if (slug) {
          await ctx.workspace.removeNodeWorkspace({ nodeId: id, canvasSlug: slug });
        }
      }

      // Remove rendered artifact directories from disk for these runs.
      const runNodeRows = ctx.db
        .select({ id: schema.runs.id, nodeId: schema.runs.nodeId })
        .from(schema.runs)
        .where(inArray(schema.runs.id, runIds))
        .all();
      for (const r of runNodeRows) {
        const slug = slugForNode(r.nodeId);
        if (!slug) continue;
        const dir = path.join(ctx.paths.artifactsDir, slug, r.id);
        if (fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }

      if (runIds.length > 0) {
        ctx.db
          .delete(schema.events)
          .where(inArray(schema.events.runId, runIds))
          .run();
        ctx.db
          .delete(schema.artifacts)
          .where(inArray(schema.artifacts.runId, runIds))
          .run();
        ctx.db
          .delete(schema.runs)
          .where(inArray(schema.runs.id, runIds))
          .run();
      }
      deleteReferencesForNodes(ctx.db, toDelete);
      ctx.db
        .delete(schema.nodes)
        .where(inArray(schema.nodes.id, toDelete))
        .run();

      return { ok: true as const };
    }),
});
