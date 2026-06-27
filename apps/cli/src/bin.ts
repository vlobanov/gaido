import pc from 'picocolors';
import { runInit } from './commands/init.js';
import { runServe } from './commands/serve.js';
import { runPublish, runUnpublish } from './commands/publish.js';
import { skeletonCatalog } from './templates.js';

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
  gaido [command]

${pc.bold('Commands:')}
  ${pc.cyan('init')}      Scaffold a new Gaido project in the current directory
  ${pc.cyan('serve')}     Start the server and open the UI (default)
  ${pc.cyan('publish')}   Publish a canvas as a static site to Cloudflare R2
  ${pc.cyan('unpublish')} Remove a published canvas from Cloudflare R2
  ${pc.cyan('help')}      Show this help

${pc.bold('Init scaffolds these built-in skeletons under ./skeletons/:')}
${skeletonList}
${pc.dim('Add your own at ./skeletons/<name>/ (project) or ~/.gaido/skeletons/<name>/ (global).')}

${pc.dim('Run with no arguments to start the server.')}
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'serve';
  const cwd = process.cwd();

  switch (command) {
    case 'init': {
      await runInit(cwd);
      return;
    }
    case 'serve':
    case undefined:
      await runServe(cwd);
      return;
    case 'publish':
      await runPublish(cwd, args.slice(1));
      return;
    case 'unpublish':
      await runUnpublish(cwd, args.slice(1));
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
