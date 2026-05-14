import { router, publicProcedure } from '../trpc.js';
import { listSkeletons } from '../skeletons.js';

export const skeletonsRouter = router({
  list: publicProcedure.query(({ ctx }) => {
    return listSkeletons({ projectDir: ctx.paths.projectDir });
  }),
});
