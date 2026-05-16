import { router, publicProcedure } from '../trpc.js';

/**
 * Surface-level project info that the web UI needs once at boot.
 */
export const systemRouter = router({
  info: publicProcedure.query(({ ctx }) => {
    return {
      projectName: ctx.config.name ?? null,
      criticKind: ctx.config.critic.kind,
    };
  }),
});
