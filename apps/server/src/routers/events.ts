import { z } from 'zod';
import { observable } from '@trpc/server/observable';
import type { PersistedEvent } from '@gaido/core';
import { router, publicProcedure } from '../trpc.js';

export const eventsRouter = router({
  /**
   * Subscribe to live events. With no filter, all events are streamed.
   * `runId` narrows to a single run; otherwise `canvasId` narrows to a
   * single canvas. v0 streams new events only.
   */
  subscribe: publicProcedure
    .input(
      z.object({
        runId: z.string().optional(),
        canvasId: z.string().optional(),
      })
    )
    .subscription(({ ctx, input }) => {
      return observable<PersistedEvent>((emit) => {
        const unsubscribe = ctx.eventBus.subscribe(input, (event) => {
          emit.next(event);
        });
        return () => {
          unsubscribe();
        };
      });
    }),
});
