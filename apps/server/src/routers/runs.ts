import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { schema } from '@gaido/core';
import { desc, eq } from 'drizzle-orm';
import { router, publicProcedure } from '../trpc.js';

export const runsRouter = router({
  get: publicProcedure
    .input(z.object({ runId: z.string() }))
    .query(({ ctx, input }) => {
      const run = ctx.db
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.id, input.runId))
        .get();
      if (!run) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `run ${input.runId}`,
        });
      }
      const artifacts = ctx.db
        .select()
        .from(schema.artifacts)
        .where(eq(schema.artifacts.runId, input.runId))
        .all();
      return { run, artifacts };
    }),

  listByNode: publicProcedure
    .input(z.object({ nodeId: z.string() }))
    .query(({ ctx, input }) => {
      return ctx.db
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.nodeId, input.nodeId))
        .orderBy(desc(schema.runs.createdAt))
        .all();
    }),

  setHumanCritique: publicProcedure
    .input(z.object({ nodeId: z.string(), notes: z.string() }))
    .mutation(({ ctx, input }) => {
      return ctx.orchestrator.saveHumanCritique(input.nodeId, input.notes);
    }),
});
