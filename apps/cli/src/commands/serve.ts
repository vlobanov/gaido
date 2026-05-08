import { startServer } from '@gaido/server';
import open from 'open';
import pc from 'picocolors';

export async function runServe(cwd: string): Promise<void> {
  const result = await startServer({ cwd });
  const { url } = result;
  const openBrowser = result.context.config.server.openBrowser;

  console.log(`\n${pc.bold('Gaido')} ${pc.dim('— ' + cwd)}`);
  console.log(`${pc.green('▸')} Server: ${pc.cyan(url)}`);
  console.log(`${pc.dim('Press Ctrl+C to stop.')}\n`);

  if (openBrowser) {
    try {
      await open(url);
    } catch (err) {
      console.warn(pc.yellow(`Could not open browser automatically: ${(err as Error).message}`));
    }
  }

  const shutdown = async (signal: string) => {
    console.log(`\n${pc.dim(`Received ${signal}, shutting down...`)}`);
    await result.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
