import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { asc, eq } from 'drizzle-orm';
import { schema, canvasId as newCanvasId } from '@gaido/core';
import { router, publicProcedure } from '../trpc.js';
import {
  nextUntitledName,
  resolveSlugCollision,
  slugify,
} from '../canvases.js';

export const canvasesRouter = router({
  list: publicProcedure.query(({ ctx }) => {
    return ctx.db
      .select()
      .from(schema.canvases)
      .orderBy(asc(schema.canvases.createdAt))
      .all();
  }),

  get: publicProcedure
    .input(
      z
        .object({
          id: z.string().optional(),
          slug: z.string().optional(),
        })
        .refine((v) => (v.id != null) !== (v.slug != null), {
          message: 'provide exactly one of id or slug',
        })
    )
    .query(({ ctx, input }) => {
      const row = input.id
        ? ctx.db
            .select()
            .from(schema.canvases)
            .where(eq(schema.canvases.id, input.id))
            .get()
        : ctx.db
            .select()
            .from(schema.canvases)
            .where(eq(schema.canvases.slug, input.slug!))
            .get();
      return row ?? null;
    }),

  create: publicProcedure
    .input(z.object({ name: z.string().optional() }))
    .mutation(({ ctx, input }) => {
      const trimmed = input.name?.trim();
      const hasName = trimmed != null && trimmed.length > 0;
      const baseSlug = hasName
        ? slugify(trimmed)
        : nextUntitledName(ctx.db);
      const slug = resolveSlugCollision(ctx.db, baseSlug);
      const id = newCanvasId();
      const now = Date.now();
      ctx.db
        .insert(schema.canvases)
        .values({
          id,
          name: hasName ? trimmed : null,
          slug,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      const row = ctx.db
        .select()
        .from(schema.canvases)
        .where(eq(schema.canvases.id, id))
        .get();
      if (!row) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'canvas insert succeeded but row missing',
        });
      }
      return row;
    }),

  rename: publicProcedure
    .input(z.object({ id: z.string(), name: z.string() }))
    .mutation(({ ctx, input }) => {
      const now = Date.now();
      ctx.db
        .update(schema.canvases)
        .set({ name: input.name, updatedAt: now })
        .where(eq(schema.canvases.id, input.id))
        .run();
      const row = ctx.db
        .select()
        .from(schema.canvases)
        .where(eq(schema.canvases.id, input.id))
        .get();
      if (!row) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `canvas ${input.id}`,
        });
      }
      return row;
    }),
});
