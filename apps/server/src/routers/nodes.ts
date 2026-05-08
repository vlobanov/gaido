import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { schema, nodeId as newNodeId } from '@gaido/core';
import { eq, inArray } from 'drizzle-orm';
import { router, publicProcedure } from '../trpc.js';

const positionSchema = z.object({ x: z.number(), y: z.number() }).optional();

export const nodesRouter = router({
  list: publicProcedure.query(({ ctx }) => {
    return ctx.db.select().from(schema.nodes).all();
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
      return { node, currentRun };
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
          positionX: input.position?.x ?? 0,
          positionY: input.position?.y ?? 0,
          instruction: input.instruction,
          status: 'pending',
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
      const id = newNodeId();
      const now = Date.now();
      // Default child position offsets below the parent if none supplied.
      const x = input.position?.x ?? parent.positionX;
      const y = input.position?.y ?? parent.positionY + 220;

      ctx.db
        .insert(schema.nodes)
        .values({
          id,
          parentId: parent.id,
          positionX: x,
          positionY: y,
          instruction: input.instruction,
          status: 'pending',
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
      // If a run is in flight, abort it before queuing the next one.
      ctx.orchestrator.cancel(node.id);
      return ctx.orchestrator.startRun(node.id);
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
    .mutation(({ ctx, input }) => {
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
      const runIds = runs.map((r) => r.id);

      // Cancel any in-flight runs we're about to delete.
      for (const id of toDelete) ctx.orchestrator.cancel(id);

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
