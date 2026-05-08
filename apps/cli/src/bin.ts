import pc from 'picocolors';
import { runInit } from './commands/init.js';
import { runServe } from './commands/serve.js';

function printHelp(): void {
  console.log(`
${pc.bold('gaido')} — local-first framework for visual creative agent workflows

${pc.bold('Usage:')}
  gaido [command]

${pc.bold('Commands:')}
  ${pc.cyan('init')}      Scaffold a new Gaido project in the current directory
  ${pc.cyan('serve')}     Start the server and open the UI (default)
  ${pc.cyan('help')}      Show this help

${pc.dim('Run with no arguments to start the server.')}
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'serve';
  const cwd = process.cwd();

  switch (command) {
    case 'init':
      await runInit(cwd);
      return;
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
