import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { schema } from '@vadimlobanov/gaido-core';
import { eq } from 'drizzle-orm';
import { router, publicProcedure } from '../trpc.js';
import {
  bindReferences,
  resolveRunForReference,
  type ReferenceDeps,
} from '../references.js';

const deps = (ctx: { db: ReferenceDeps['db']; paths: ReferenceDeps['paths']; workspace: ReferenceDeps['workspace'] }): ReferenceDeps => ({
  db: ctx.db,
  paths: ctx.paths,
  workspace: ctx.workspace,
});

export const referencesRouter = router({
  /** References attached to a node (for the sidebar list + chips). */
  list: publicProcedure
    .input(z.object({ nodeId: z.string() }))
    .query(({ ctx, input }) =>
      ctx.db
        .select()
        .from(schema.nodeReferences)
        .where(eq(schema.nodeReferences.nodeId, input.nodeId))
        .all()
    ),

  /** Preview a run id before attaching it — also the validation gate. */
  resolveRun: publicProcedure
    .input(z.object({ runId: z.string() }))
    .query(({ ctx, input }) => {
      const r = resolveRunForReference(ctx.db, input.runId);
      if (!r) return null;
      // Don't leak the absolute video path to the client.
      return {
        runId: r.runId,
        label: r.label,
        instruction: r.instruction,
        canvasSlug: r.canvasSlug,
        canvasName: r.canvasName,
        thumbnailArtifactId: r.thumbnailArtifactId,
        hasCode: r.hasCode,
        hasVideo: r.hasVideo,
      };
    }),

  /** Attach an uploaded image to an existing node. */
  attachImage: publicProcedure
    .input(
      z.object({
        nodeId: z.string(),
        filename: z.string().min(1),
        mime: z.string().min(1),
        // ~24MB of bytes — pasted screenshots are far smaller.
        dataBase64: z.string().min(1).max(32_000_000),
      })
    )
    .mutation(async ({ ctx, input }) => {
      requireNode(ctx.db, input.nodeId);
      const [row] = await bindReferences(deps(ctx), input.nodeId, [
        {
          kind: 'image',
          filename: input.filename,
          mime: input.mime,
          dataBase64: input.dataBase64,
        },
      ]);
      return row;
    }),

  /** Attach another run (by id) to an existing node. */
  attachRun: publicProcedure
    .input(z.object({ nodeId: z.string(), runId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      requireNode(ctx.db, input.nodeId);
      const rows = await bindReferences(deps(ctx), input.nodeId, [
        { kind: 'run', runId: input.runId },
      ]);
      if (rows.length === 0) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'That run was not found, or has no code or video to reference yet.',
        });
      }
      return rows[0];
    }),

  /** Detach a reference. Cached bytes are left on disk. */
  remove: publicProcedure
    .input(z.object({ referenceId: z.string() }))
    .mutation(({ ctx, input }) => {
      ctx.db
        .delete(schema.nodeReferences)
        .where(eq(schema.nodeReferences.id, input.referenceId))
        .run();
      return { ok: true as const };
    }),
});

function requireNode(db: ReferenceDeps['db'], nodeId: string): void {
  const node = db
    .select({ id: schema.nodes.id, kind: schema.nodes.kind })
    .from(schema.nodes)
    .where(eq(schema.nodes.id, nodeId))
    .get();
  if (!node) {
    throw new TRPCError({ code: 'NOT_FOUND', message: `node ${nodeId}` });
  }
  if (node.kind !== 'coder') {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'references attach to coder nodes',
    });
  }
}
