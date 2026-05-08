import { z } from 'zod';
import { observable } from '@trpc/server/observable';
import type { PersistedEvent } from '@gaido/core';
import { router, publicProcedure } from '../trpc.js';

export const eventsRouter = router({
  /**
   * Subscribe to live events. If `runId` is omitted, all events from all runs
   * are streamed. v0 streams new events only — clients fetch historical events
   * separately if needed.
   */
  subscribe: publicProcedure
    .input(z.object({ runId: z.string().optional() }))
    .subscription(({ ctx, input }) => {
      return observable<PersistedEvent>((emit) => {
        const unsubscribe = ctx.eventBus.subscribe(input.runId, (event) => {
          emit.next(event);
        });
        return () => {
          unsubscribe();
        };
      });
    }),
});
