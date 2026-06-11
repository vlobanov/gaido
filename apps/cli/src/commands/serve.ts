import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '@gaido/server';
import open from 'open';
import pc from 'picocolors';

const here = dirname(fileURLToPath(import.meta.url));
const requireFromCli = createRequire(import.meta.url);

/**
 * Module aliases for the server's config/skeleton loaders (jiti). A project
 * scaffolded by `npx gaido init` has no node_modules, so `import ... from
 * 'gaido'` in gaido.config.ts can't resolve from the config file's location —
 * point it (and the subpackages, for configs that import them directly) at
 * the framework copy that is actually running. This also pins the config's
 * adapter factories to the running version when a project-local install
 * exists at a different one.
 */
function buildFrameworkAlias(): Record<string, string> {
  const alias: Record<string, string> = {
    gaido: resolve(here, '..', 'index.ts'),
  };
  for (const pkg of [
    '@gaido/core',
    '@gaido/adapter-claude-code',
    '@gaido/adapter-codex',
    '@gaido/adapter-openrouter',
    '@gaido/adapter-playwright-renderer',
  ]) {
    try {
      alias[pkg] = requireFromCli.resolve(pkg);
    } catch {
      // Unresolvable from the CLI in this layout — leave it to project-local
      // node_modules resolution.
    }
  }
  return alias;
}

export async function runServe(cwd: string): Promise<void> {
  const result = await startServer({ cwd, frameworkAlias: buildFrameworkAlias() });
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
