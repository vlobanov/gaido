import pc from 'picocolors';
import { runInit } from './commands/init.js';
import { runServe } from './commands/serve.js';
import { runPublish, runUnpublish } from './commands/publish.js';
import {
  runCanvases,
  runCritiques,
  runLogs,
  runNode,
  runNodes,
  runTree,
} from './commands/graph.js';
import { runFork, runSubmit } from './commands/external.js';
import { runNote } from './commands/note.js';
import { runLessons } from './commands/lessons.js';
import { runSkeleton } from './commands/skeleton.js';
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

${pc.bold('Graph (needs the server running; add --json for machine output):')}
  ${pc.cyan('canvases')}                    List canvases
  ${pc.cyan('nodes')} [--canvas <slug>]     List nodes (id, kind, status, coder)
  ${pc.cyan('node')} <id>                   One node in detail (run, critique, worktree, logs)
  ${pc.cyan('tree')} [--canvas <slug>]      The graph as an ASCII tree
  ${pc.cyan('logs')} <runId|nodeId> [--dir] Print a run's events.ndjson (or the log dir path)
  ${pc.cyan('critiques')} [--canvas <slug>] Every stored critique, for feedback passes

${pc.bold('External edits (code authored outside gaido):')}
  ${pc.cyan('fork')} <nodeId> -m "<desc>"   New external node + worktree to edit by hand
  ${pc.cyan('submit')} <nodeId> [--critique] [--wait]
                              Commit the worktree diff and render it as a run

${pc.bold('Project knowledge:')}
  ${pc.cyan('note')} <nodeId> ["<text>" | --clear]
                              Set/print/clear a node's margin note (shown on the card)
  ${pc.cyan('lessons')} [add "<rule>"]      Print LESSONS.md, or promote a rule (deduped)
  ${pc.cyan('skeleton')} list|reseed <name> List presets / commit skeleton edits to seed/<name>

${pc.bold('Init scaffolds these built-in skeletons under ./skeletons/:')}
${skeletonList}
${pc.dim('Add your own at ./skeletons/<name>/ (project) or ~/.gaido/skeletons/<name>/ (global).')}

${pc.dim('Run with no arguments to start the server.')}
`);
}

// Piping CLI output into `head`/`jq -e` closes stdout early; without this
// Node crashes with an unhandled EPIPE instead of exiting quietly like any
// well-behaved unix tool. Agents pipe constantly, so exit clean.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'serve';
  const cwd = process.cwd();
  const rest = args.slice(1);

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
      await runPublish(cwd, rest);
      return;
    case 'unpublish':
      await runUnpublish(cwd, rest);
      return;
    case 'canvases':
      await runCanvases(cwd, rest);
      return;
    case 'nodes':
      await runNodes(cwd, rest);
      return;
    case 'node':
      await runNode(cwd, rest);
      return;
    case 'tree':
      await runTree(cwd, rest);
      return;
    case 'logs':
      await runLogs(cwd, rest);
      return;
    case 'critiques':
      await runCritiques(cwd, rest);
      return;
    case 'fork':
      await runFork(cwd, rest);
      return;
    case 'submit':
      await runSubmit(cwd, rest);
      return;
    case 'note':
      await runNote(cwd, rest);
      return;
    case 'lessons':
      await runLessons(cwd, rest);
      return;
    case 'skeleton':
    case 'skeletons':
      await runSkeleton(cwd, rest);
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
  console.error(pc.red('\nGaido failed:\n'));
  console.error(err);
  process.exit(1);
});
