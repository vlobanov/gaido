import { resolvePaths } from './paths.js';
import { loadEnv } from './env-loader.js';
import { loadConfig } from './config-loader.js';
import { openDb } from './db.js';
import { EventBus } from './event-bus.js';
import { Orchestrator } from './orchestrator.js';
import { recoverInterrupted } from './recovery.js';
import { createServer } from './server.js';
import { createWorkspaceManager } from './workspace.js';
import type { Context } from './context.js';

export interface StartServerOptions {
  cwd?: string;
  port?: number;
  host?: string;
}

export interface StartServerResult {
  context: Context;
  url: string;
  close: () => Promise<void>;
}

export async function startServer(
  options: StartServerOptions = {}
): Promise<StartServerResult> {
  const paths = resolvePaths(options.cwd);
  const env = loadEnv(paths.projectDir);
  if (env.loaded.length > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[gaido] loaded env from ${env.loaded.join(', ')} (${env.applied} var${env.applied === 1 ? '' : 's'})`
    );
  }
  const config = await loadConfig(paths.configFile);

  const { db, sqlite } = openDb(paths.dbFile, paths.migrationsDir);

  const recovered = recoverInterrupted(db);
  if (recovered.runs > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[gaido] recovery: marked ${recovered.runs} run(s) and ${recovered.nodes} node(s) as interrupted`
    );
  }

  const eventBus = new EventBus(db);
  const workspace = createWorkspaceManager({
    runsDir: paths.runsDir,
    skeletonDir: paths.skeletonDir,
  });
  const orchestrator = new Orchestrator({
    db,
    eventBus,
    config,
    workspace,
    paths,
  });

  const context: Context = {
    db,
    eventBus,
    orchestrator,
    paths,
    config,
    workspace,
  };

  const port = options.port ?? config.server.port;
  const host = options.host ?? '127.0.0.1';

  const fastify = await createServer({ port, host, context });

  await fastify.listen({ port, host });
  const url = `http://${host}:${port}`;

  const close = async () => {
    orchestrator.shutdown();
    await fastify.close();
    sqlite.close();
  };

  return { context, url, close };
}

export type { AppRouter } from './routers/index.js';
export type { Context } from './context.js';
