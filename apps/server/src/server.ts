import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import {
  fastifyTRPCPlugin,
  type FastifyTRPCPluginOptions,
} from '@trpc/server/adapters/fastify';
import { schema } from '@gaido/core';
import { eq } from 'drizzle-orm';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { appRouter, type AppRouter } from './routers/index.js';
import type { Context } from './context.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Two layouts: published (`web-dist/` vendored into this package at prepack)
// and monorepo (sibling `apps/web/dist` built by `pnpm --filter @gaido/web build`).
const WEB_DIST_CANDIDATES = [
  resolve(__dirname, '..', 'web-dist'),
  resolve(__dirname, '..', '..', 'web', 'dist'),
];
const WEB_DIST = WEB_DIST_CANDIDATES.find((p) => existsSync(p)) ?? WEB_DIST_CANDIDATES[1]!;

interface ServerOptions {
  port: number;
  host?: string;
  context: Context;
}

export async function createServer(opts: ServerOptions) {
  const fastify = Fastify({
    logger: {
      level: process.env['GAIDO_LOG_LEVEL'] ?? 'info',
    },
    maxParamLength: 5000,
  });

  await fastify.register(cors, {
    origin: (origin, cb) => {
      // Allow same-origin (no Origin header) and the Vite dev server.
      if (!origin) return cb(null, true);
      const allowed = ['http://localhost:5173', 'http://127.0.0.1:5173'];
      cb(null, allowed.includes(origin));
    },
    credentials: true,
  });

  await fastify.register(websocket);

  await fastify.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    useWSS: true,
    trpcOptions: {
      router: appRouter,
      createContext: () => opts.context,
    },
  } satisfies FastifyTRPCPluginOptions<AppRouter>);

  fastify.get('/health', async () => ({ ok: true }));

  // Serve artifact files by id. Looks up the artifact row, validates the
  // file is still on disk, streams it back with the recorded mime.
  fastify.get<{ Params: { id: string } }>(
    '/artifacts/:id',
    async (req, reply) => {
      const { id } = req.params;
      const artifact = opts.context.db
        .select()
        .from(schema.artifacts)
        .where(eq(schema.artifacts.id, id))
        .get();
      if (!artifact) {
        reply.code(404).send({ error: 'artifact not found' });
        return;
      }
      if (!existsSync(artifact.path)) {
        reply.code(410).send({ error: 'artifact file missing on disk' });
        return;
      }
      const stat = statSync(artifact.path);
      reply.header('content-type', artifact.mime);
      reply.header('content-length', String(stat.size));
      // Cache hard — artifact files are immutable per id (never rewritten).
      reply.header('cache-control', 'public, max-age=31536000, immutable');
      // Range support keeps <video> seekable; fastify-static does this for
      // static dirs but our route is bespoke. For v0, full-stream is fine.
      return reply.send(createReadStream(artifact.path));
    }
  );

  // Serve an uploaded reference image by reference id (for UI preview /
  // chips). Run references render off the source run's existing artifacts, so
  // only image references need a bespoke route.
  fastify.get<{ Params: { id: string } }>(
    '/references/:id',
    async (req, reply) => {
      const { id } = req.params;
      const ref = opts.context.db
        .select()
        .from(schema.nodeReferences)
        .where(eq(schema.nodeReferences.id, id))
        .get();
      if (!ref || ref.kind !== 'image' || !ref.filePath) {
        reply.code(404).send({ error: 'reference not found' });
        return;
      }
      if (!existsSync(ref.filePath)) {
        reply.code(410).send({ error: 'reference file missing on disk' });
        return;
      }
      const stat = statSync(ref.filePath);
      reply.header('content-type', ref.mime ?? 'application/octet-stream');
      reply.header('content-length', String(stat.size));
      reply.header('cache-control', 'public, max-age=31536000, immutable');
      return reply.send(createReadStream(ref.filePath));
    }
  );

  if (existsSync(WEB_DIST)) {
    await fastify.register(fastifyStatic, {
      root: WEB_DIST,
      prefix: '/',
      wildcard: false,
    });

    fastify.setNotFoundHandler((req, reply) => {
      if (
        req.url.startsWith('/trpc') ||
        req.url.startsWith('/health') ||
        req.url.startsWith('/artifacts') ||
        req.url.startsWith('/references')
      ) {
        reply.code(404).send({ error: 'Not found' });
        return;
      }
      reply.type('text/html').sendFile('index.html');
    });
  } else {
    fastify.log.warn(
      `Web UI not found (looked in ${WEB_DIST_CANDIDATES.join(', ')}). ` +
        `In the monorepo, run \`pnpm --filter @gaido/web build\` to enable the bundled UI, or use \`pnpm --filter @gaido/web dev\` for hot reload.`
    );
  }

  return fastify;
}

export type Server = Awaited<ReturnType<typeof createServer>>;
