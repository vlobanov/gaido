import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { schema, nodeId as newNodeId } from '@gaido/core';
import type { Critique } from '@gaido/core';
import type { Node } from '@gaido/core/schema';
import { and, eq, gt, inArray } from 'drizzle-orm';
import { router, publicProcedure } from '../trpc.js';
import type { Db } from '../db.js';
import {
  critiqueCardHeight,
  layoutCanvasNodes,
  nextChildY,
  CONFIG_CARD_HEIGHT,
  SIBLING_X_STEP,
} from '../layout.js';
import {
  bindReferences,
  inheritReferences,
  deleteReferencesForNodes,
  referenceInputSchema,
  type ReferenceDeps,
} from '../references.js';

const positionSchema = z.object({ x: z.number(), y: z.number() }).optional();

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
          sessionPolicy: schema.nodes.sessionPolicy,
          isFavorite: schema.nodes.isFavorite,
          createdAt: schema.nodes.createdAt,
          updatedAt: schema.nodes.updatedAt,
          thumbnailArtifactId: schema.runs.thumbnailArtifactId,
          videoArtifactId: schema.runs.videoArtifactId,
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
      return input?.canvasId
        ? base.where(eq(schema.nodes.canvasId, input.canvasId)).all()
        : base.all();
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
      const retryable = node.kind === 'coder' ? isLeafOfBranch(ctx.db, node) : true;
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
      return {
        node,
        currentRun,
        retryable,
        hasSession,
        resolvedCoderName,
        resolvedCoderKind,
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
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (input.coderName && !ctx.config.coders.has(input.coderName)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `unknown coder '${input.coderName}'`,
        });
      }
      let canvasId = input.canvasId;
      if (!canvasId) {
        const defaultCanvas = ctx.db
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
        canvasId = defaultCanvas.id;
      }
      const id = newNodeId();
      const now = Date.now();
      // Drop the new root on its own lane to the right of everything already
      // on the canvas — the same left-to-right root stacking layoutCanvasNodes()
      // produces, but computed incrementally so seeding a root never disturbs
      // the canvas's existing nodes. `positionX` is each card's left edge and
      // every card is one column (SIBLING_X_STEP) wide, so `maxX + 2·step`
      // clears the rightmost card and leaves one empty gap column between
      // subtrees. Empty canvas → origin. Without this the root defaulted to
      // x=0 and stacked behind the leftmost existing root.
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
      ctx.db
        .insert(schema.nodes)
        .values({
          id,
          parentId: null,
          canvasId,
          kind: 'coder',
          positionX,
          positionY: input.position?.y ?? 0,
          instruction: input.instruction,
          status: 'idle',
          skeletonName: input.skeletonName ?? null,
          coderName: input.coderName ?? null,
          isFavorite: false,
          createdAt: now,
          updatedAt: now,
        })
        .run();
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
      // Coding must have completed — there has to be committed code to render.
      if (!run.codingFinishedAt) {
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
   * SAME branch as the parent coder. The new node sets `branchAnchorId` to
   * the parent's anchor (or to the parent itself if the parent is the
   * branch root), so the orchestrator reuses the anchor's worktree and
   * Claude Code session. The instruction is just the artist's notes — the
   * session already has the prior conversation in scope, so no composed
   * prompt is needed.
   */
  continue: publicProcedure
    .input(z.object({ critiqueNodeId: z.string() }))
    .mutation(({ ctx, input }) => {
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
          message: 'continue requires a critique node',
        });
      }
      if (!critique.parentId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'critique node has no parent coder',
        });
      }
      if (!critique.currentRunId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'save notes before continuing',
        });
      }
      const critiqueRun = ctx.db
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.id, critique.currentRunId))
        .get();
      const notes = critiqueRun?.critique?.overall?.trim();
      if (!notes) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'save notes before continuing',
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

      const id = newNodeId();
      const now = Date.now();
      const y = nextChildY(
        critique.positionY,
        critiqueCardHeight(critiqueRun?.critique)
      );
      // Spread alongside any prior siblings (forks or other continues) so a
      // second iteration from one critique doesn't land on top of the first.
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
          canvasId: parentCoder.canvasId,
          kind: 'coder',
          positionX: rightmost + SIBLING_X_STEP,
          positionY: y,
          instruction: notes,
          branchAnchorId: anchorId,
          status: 'idle',
          isFavorite: false,
          createdAt: now,
          updatedAt: now,
        })
        .run();

      // Continuing inherits the parent coder's references so iteration keeps
      // the same context.
      inheritReferences(ctx, parentCoder.id, id);

      const run = ctx.orchestrator.startRun(id);
      const node = ctx.db
        .select()
        .from(schema.nodes)
        .where(eq(schema.nodes.id, id))
        .get()!;
      return { node, run };
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
