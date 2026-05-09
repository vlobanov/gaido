import pc from 'picocolors';
import { runInit } from './commands/init.js';
import { runServe } from './commands/serve.js';
import { skeletonCatalog, DEFAULT_SKELETON } from './templates.js';

function printHelp(): void {
  const skeletonList = Object.entries(skeletonCatalog)
    .map(
      ([name, tpl]) =>
        `    ${pc.cyan(name.padEnd(8))} ${pc.dim(tpl.description)}`
    )
    .join('\n');
  console.log(`
${pc.bold('gaido')} — local-first framework for visual creative agent workflows

${pc.bold('Usage:')}
  gaido [command] [options]

${pc.bold('Commands:')}
  ${pc.cyan('init')}      Scaffold a new Gaido project in the current directory
  ${pc.cyan('serve')}     Start the server and open the UI (default)
  ${pc.cyan('help')}      Show this help

${pc.bold('Options for')} ${pc.cyan('init')}:
  ${pc.cyan('--skeleton=<name|path>')}
            Built-in skeleton, or path to a directory whose contents are
            copied into ./skeleton/. Defaults to ${pc.cyan(DEFAULT_SKELETON)}. Built-ins:
${skeletonList}

${pc.dim('Run with no arguments to start the server.')}
`);
}

interface ParsedFlags {
  skeleton?: string;
}

function parseFlags(args: string[]): ParsedFlags {
  const out: ParsedFlags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--skeleton=')) {
      out.skeleton = a.slice('--skeleton='.length);
    } else if (a === '--skeleton') {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error('--skeleton requires a value (name or path)');
      }
      out.skeleton = next;
      i++;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'serve';
  const rest = args.slice(1);
  const cwd = process.cwd();

  switch (command) {
    case 'init': {
      const flags = parseFlags(rest);
      await runInit(
        cwd,
        flags.skeleton !== undefined ? { skeleton: flags.skeleton } : {}
      );
      return;
    }
    case 'serve':
    case undefined:
      await runServe(cwd);
      return;
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      return;
    default:
      console.error(pc.red(`Unknown command: ${command}\n`));
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(pc.red('\nGaido failed to start:\n'));
  console.error(err);
  process.exit(1);
});
