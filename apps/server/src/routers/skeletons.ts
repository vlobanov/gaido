import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, publicProcedure } from '../trpc.js';
import { listSkeletons } from '../skeletons.js';

export const skeletonsRouter = router({
  list: publicProcedure.query(({ ctx }) => {
    return listSkeletons({ projectDir: ctx.paths.projectDir });
  }),

  /**
   * Commit the skeleton's current directory contents as a new tip on its
   * `seed/<name>` branch. Seed branches are lazy-created once and never
   * re-read, so skeleton edits do nothing until reseeded — and even then only
   * roots created *after* the reseed pick them up; existing lineages keep
   * their history. (To propagate a skeleton change into existing branches,
   * apply it per-leaf via the external-edit flow instead.)
   */
  reseed: publicProcedure
    .input(z.object({ name: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const known = listSkeletons({ projectDir: ctx.paths.projectDir });
      if (!known.some((s) => s.name === input.name)) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `skeleton '${input.name}' not found (looked in ./skeletons and ~/.gaido/skeletons)`,
        });
      }
      const result = await ctx.workspace.reseedSeedBranch(input.name);
      return { name: input.name, ...result, changed: result.sha != null };
    }),
});
