import { startServer } from './index.js';

const result = await startServer({});
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
