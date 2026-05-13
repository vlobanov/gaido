import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { schema, nodeId as newNodeId } from '@gaido/core';
import type { Node } from '@gaido/core/schema';
import { and, eq, gt, inArray } from 'drizzle-orm';
import { router, publicProcedure } from '../trpc.js';
import type { Db } from '../db.js';
import { critiqueCardHeight, nextChildY, SIBLING_X_STEP } from '../layout.js';

const positionSchema = z.object({ x: z.number(), y: z.number() }).optional();

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
  list: publicProcedure.query(({ ctx }) => {
    return ctx.db
      .select({
        id: schema.nodes.id,
        parentId: schema.nodes.parentId,
        kind: schema.nodes.kind,
        positionX: schema.nodes.positionX,
        positionY: schema.nodes.positionY,
        instruction: schema.nodes.instruction,
        status: schema.nodes.status,
        currentRunId: schema.nodes.currentRunId,
        sessionId: schema.nodes.sessionId,
        isFavorite: schema.nodes.isFavorite,
        createdAt: schema.nodes.createdAt,
        updatedAt: schema.nodes.updatedAt,
        thumbnailArtifactId: schema.runs.thumbnailArtifactId,
        videoArtifactId: schema.runs.videoArtifactId,
        codingStartedAt: schema.runs.codingStartedAt,
        codingFinishedAt: schema.runs.codingFinishedAt,
        renderingStartedAt: schema.runs.renderingStartedAt,
        renderingFinishedAt: schema.runs.renderingFinishedAt,
        critiquingStartedAt: schema.runs.critiquingStartedAt,
        critiquingFinishedAt: schema.runs.critiquingFinishedAt,
      })
      .from(schema.nodes)
      .leftJoin(schema.runs, eq(schema.nodes.currentRunId, schema.runs.id))
      .all();
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
      return { node, currentRun, retryable };
    }),

  createRoot: publicProcedure
    .input(
      z.object({
        instruction: z.string().min(1),
        position: positionSchema,
      })
    )
    .mutation(({ ctx, input }) => {
      const id = newNodeId();
      const now = Date.now();
      ctx.db
        .insert(schema.nodes)
        .values({
          id,
          parentId: null,
          kind: 'coder',
          positionX: input.position?.x ?? 0,
          positionY: input.position?.y ?? 0,
          instruction: input.instruction,
          status: 'idle',
          isFavorite: false,
          createdAt: now,
          updatedAt: now,
        })
        .run();
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
      })
    )
    .mutation(({ ctx, input }) => {
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
      const run = ctx.orchestrator.startRun(id);
      const node = ctx.db
        .select()
        .from(schema.nodes)
        .where(eq(schema.nodes.id, id))
        .get()!;
      return { node, run };
    }),

  retry: publicProcedure
    .input(z.object({ nodeId: z.string() }))
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
      // If a run is in flight, abort it before queuing the next one.
      ctx.orchestrator.cancel(node.id);
      return ctx.orchestrator.startRun(node.id);
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

      const run = ctx.orchestrator.startRun(id);
      const node = ctx.db
        .select()
        .from(schema.nodes)
        .where(eq(schema.nodes.id, id))
        .get()!;
      return { node, run };
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
        await ctx.workspace.removeNodeWorkspace(id);
      }

      // Remove rendered artifact directories from disk for these runs.
      for (const id of runIds) {
        const dir = path.join(ctx.paths.artifactsDir, id);
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
      ctx.db
        .delete(schema.nodes)
        .where(inArray(schema.nodes.id, toDelete))
        .run();

      return { ok: true as const };
    }),
});
