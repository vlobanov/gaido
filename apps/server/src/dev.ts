import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './index.js';

// `pnpm dev` runs this script with cwd = apps/server, where no gaido.config.ts
// lives. Default the dev cwd to the workspace's `test-project/` fixture so
// `pnpm dev` JustWorks; override via GAIDO_DEV_CWD when working on a different
// project.
const here = path.dirname(fileURLToPath(import.meta.url));
const defaultCwd = path.resolve(here, '..', '..', '..', 'test-project');
const cwd = process.env['GAIDO_DEV_CWD'] ?? defaultCwd;

// eslint-disable-next-line no-console
console.log(`[gaido] dev cwd: ${cwd}`);
const result = await startServer({ cwd });
// eslint-disable-next-line no-console
console.log(`[gaido] server listening at ${result.url}`);

const shutdown = async (signal: string) => {
  // eslint-disable-next-line no-console
  console.log(`[gaido] received ${signal}, shutting down`);
  await result.close();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
