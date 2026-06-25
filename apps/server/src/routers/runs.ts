import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { schema } from '@vadimlobanov/gaido-core';
import { desc, eq } from 'drizzle-orm';
import { router, publicProcedure } from '../trpc.js';
import { openInFileManager } from '../previews.js';

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
    .input(
      z.object({
        nodeId: z.string(),
        notes: z.string(),
        rating: z.number().int().min(1).max(5).optional(),
      })
    )
    .mutation(({ ctx, input }) => {
      return ctx.orchestrator.saveHumanCritique(
        input.nodeId,
        input.notes,
        input.rating
      );
    }),

  /**
   * Overwrite an automated critique's text (the sidebar "Edit" action). Folds
   * the artist's prose into `overall`, clears `suggestions`, and preserves the
   * structured fields the rest of the UI reads (rating, proposed rules).
   */
  editCritique: publicProcedure
    .input(z.object({ nodeId: z.string(), overall: z.string() }))
    .mutation(({ ctx, input }) => {
      return ctx.orchestrator.editCritique(input.nodeId, input.overall);
    }),

  /**
   * Extract this run's committed code into `runs/.previews/<commit>/` and open
   * that folder in the OS file manager. Local-first single-user: the server
   * runs on the artist's machine, so the folder opens on their desktop.
   *
   * Only runs that produced their own commit have a distinct snapshot — a
   * no-diff run changed nothing versus its parent, so there is nothing of its
   * own to reveal (the UI disables the action for those). Returns the path so
   * the client can show it if a desktop session can't pop a window.
   */
  revealCode: publicProcedure
    .input(z.object({ runId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const run = ctx.db
        .select({ commitSha: schema.runs.commitSha })
        .from(schema.runs)
        .where(eq(schema.runs.id, input.runId))
        .get();
      if (!run) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `run ${input.runId}`,
        });
      }
      if (!run.commitSha) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'this iteration produced no code changes',
        });
      }
      const dir = await ctx.previewArchiver.ensureArchive(run.commitSha);
      await openInFileManager(dir);
      return { path: dir };
    }),
});
