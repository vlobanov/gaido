import { z } from 'zod';
import { observable } from '@trpc/server/observable';
import { schema } from '@vadimlobanov/gaido-core';
import type { PersistedEvent } from '@vadimlobanov/gaido-core';
import { asc, eq } from 'drizzle-orm';
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

  /**
   * Fetch the full persisted event history for a run, ordered oldest →
   * newest. The UI uses this to backfill on mount so reloading a page
   * mid-run doesn't lose the activity timeline. Pair with `subscribe` to
   * pick up new events after the snapshot.
   */
  history: publicProcedure
    .input(z.object({ runId: z.string() }))
    .query(({ ctx, input }) => {
      const rows = ctx.db
        .select()
        .from(schema.events)
        .where(eq(schema.events.runId, input.runId))
        .orderBy(asc(schema.events.ts))
        .all();
      // Drizzle returns DbEvent rows where `payload` is already typed as
      // EventPayload thanks to the schema's $type<>(). Hand them back as
      // PersistedEvent so the client sees the same shape as live frames.
      return rows.map<PersistedEvent>((r) => ({
        id: r.id,
        runId: r.runId,
        ts: r.ts,
        payload: r.payload,
      }));
    }),
});
