import pc from 'picocolors';
import { runInit } from './commands/init.js';
import { runServe } from './commands/serve.js';
import { runPublish, runUnpublish } from './commands/publish.js';
import {
  runCanvases,
  runCritiques,
  runLogs,
  runNode,
  runRun,
  runNodes,
  runTree,
} from './commands/graph.js';
import { runFork, runSubmit } from './commands/external.js';
import { runCanvas } from './commands/canvas.js';
import {
  runAuto,
  runCancel,
  runCoders,
  runContinue,
  runCritiqueNode,
  runDelete,
  runFavorite,
  runFeedback,
  runRerender,
  runRetry,
  runReply,
  runRoot,
  runSwitch,
} from './commands/actions.js';
import { runRef } from './commands/refs.js';
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
  ${pc.cyan('canvas')} create|rename …      New canvas / rename one
  ${pc.cyan('coders')}                      The project's coder registry
  ${pc.cyan('nodes')} [--canvas <slug>]     List nodes (id, kind, status, coder)
  ${pc.cyan('node')} <id>                   One node in detail (run, critique, worktree, logs)
  ${pc.cyan('run')} <runId>                One run resolved to its node, canvas, commit, worktree
  ${pc.cyan('tree')} [--canvas <slug>]      The graph as an ASCII tree
  ${pc.cyan('logs')} <runId|nodeId> [--dir] Print a run's events.ndjson (or the log dir path)
  ${pc.cyan('critiques')} [--canvas <slug>] Every stored critique, for feedback passes

${pc.bold("Run the loop (everything the UI's cards do):")}
  ${pc.cyan('root')} "<prompt>" [--canvas <slug>] [--coder <name>] [--skeleton <name>] [--auto N]
                              Seed a new root and run its coder
                              (--batch coder[:skeleton],… fans out branches)
  ${pc.cyan('critique')} <id> [--wait]      Run the model critic on a node's critique
  ${pc.cyan('feedback')} <id> "<notes>" [--rating 1-5]
                              Write a human critique yourself
  ${pc.cyan('continue')} <id> [--wait]      Iterate on the same branch from its critique
  ${pc.cyan('retry')} <id> [-m "<steer>"] [--coder <name>]
                              Re-run a leaf coder (or a critique)
  ${pc.cyan('reply')} <id> "<text>"         Next turn in the leaf coder's live session
  ${pc.cyan('auto')} <id> -n <N> | --stop [--now]
                              Start / interrupt an unattended auto-run loop
  ${pc.cyan('switch')} <id> --coder <name> -m "<instruction>" [--retain]
                              Switch coder mid-graph (config node) and run it
  ${pc.cyan('rerender')} <id>               Repeat only a failed render (no coder turn)
  ${pc.cyan('cancel')} <id>                 Abort a node's in-flight run
  ${pc.cyan('favorite')} <id> [--off]       Star / unstar a node
  ${pc.cyan('delete')} <id> --yes           Delete a node and its whole subtree
  ${pc.cyan('ref')} list|add|rm …           Manage a coder's references (images, other runs)

${pc.bold('External edits (code authored outside gaido):')}
  ${pc.cyan('fork')} <nodeId> -m "<desc>"   New external node + worktree to edit by hand
                              (--agent instead runs a coder agent on the text)
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
    case 'canvas':
      await runCanvas(cwd, rest);
      return;
    case 'coders':
      await runCoders(cwd, rest);
      return;
    case 'root':
      await runRoot(cwd, rest);
      return;
    case 'critique':
      await runCritiqueNode(cwd, rest);
      return;
    case 'feedback':
      await runFeedback(cwd, rest);
      return;
    case 'continue':
      await runContinue(cwd, rest);
      return;
    case 'retry':
      await runRetry(cwd, rest);
      return;
    case 'reply':
      await runReply(cwd, rest);
      return;
    case 'auto':
      await runAuto(cwd, rest);
      return;
    case 'switch':
      await runSwitch(cwd, rest);
      return;
    case 'rerender':
      await runRerender(cwd, rest);
      return;
    case 'cancel':
      await runCancel(cwd, rest);
      return;
    case 'favorite':
      await runFavorite(cwd, rest);
      return;
    case 'delete':
      await runDelete(cwd, rest);
      return;
    case 'ref':
    case 'refs':
      await runRef(cwd, rest);
      return;
    case 'nodes':
      await runNodes(cwd, rest);
      return;
    case 'node':
      await runNode(cwd, rest);
      return;
    case 'run':
      await runRun(cwd, rest);
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
