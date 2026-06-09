import { router, publicProcedure } from '../trpc.js';

/**
 * The project's coder registry, surfaced to the UI for the root-seed picker,
 * the mid-graph "Switch coder" modal, and the Retry coder swap. `kind` lets
 * the UI gate session-retaining switches to compatible adapters (you can't
 * resume a claude-code session under a different tool). Skeleton overlays can
 * swap the registry per node, but the seed picker lists the project coders —
 * the common case — so this reads straight off the resolved project config.
 */
export const codersRouter = router({
  list: publicProcedure.query(({ ctx }) => {
    const out: { name: string; kind: string; isDefault: boolean }[] = [];
    for (const [name, coder] of ctx.config.coders) {
      out.push({
        name,
        kind: coder.kind,
        isDefault: name === ctx.config.defaultCoderName,
      });
    }
    return out;
  }),
});
