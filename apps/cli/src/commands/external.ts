import pc from 'picocolors';
import { connect, parseArgv, printJson } from '../client.js';

/**
 * `gaido fork <nodeId> -m "<description>"` — create an external coder node
 * under the target's critique (a coder id resolves to its critique child)
 * and print the worktree to edit. No agent runs; the node waits idle until
 * `gaido submit`.
 */
export async function runFork(cwd: string, argv: string[]): Promise<void> {
  const { positionals, flags, options } = parseArgv(argv, {
    flags: ['--json'],
    options: { '--message': ['-m'], '--url': [] },
  });
  const parentId = positionals[0];
  const instruction = options['--message'];
  if (!parentId || !instruction) {
    throw new Error('usage: gaido fork <coderOrCritiqueId> -m "<what this edit is>"');
  }
  const { client } = await connect(cwd, options['--url']);
  const { node, worktreePath } = await client.nodes.forkExternal.mutate({
    parentId,
    instruction,
  });
  if (flags.has('--json')) {
    return printJson({ nodeId: node.id, worktreePath });
  }
  console.log(`${pc.green('✓')} external node ${pc.bold(node.id)}`);
  console.log(`  ${pc.dim('worktree:')} ${pc.cyan(worktreePath)}`);
  console.log(pc.dim(`\nEdit files there, then: gaido submit ${node.id}`));
}

/**
 * `gaido submit <nodeId>` — commit the worktree's diff as an external run and
 * render it. `--critique` runs the configured critic on the result;
 * `--wait` polls until the run lands and reports the outcome.
 */
export async function runSubmit(cwd: string, argv: string[]): Promise<void> {
  const { positionals, flags, options } = parseArgv(argv, {
    flags: ['--json', '--critique', '--wait'],
    options: { '--message': ['-m'], '--url': [] },
  });
  const nodeId = positionals[0];
  if (!nodeId) {
    throw new Error(
      'usage: gaido submit <nodeId> [-m "<updated description>"] [--critique] [--wait]'
    );
  }
  const { client } = await connect(cwd, options['--url']);
  const { node, run } = await client.nodes.submitExternal.mutate({
    nodeId,
    ...(options['--message'] ? { instruction: options['--message'] } : {}),
    ...(flags.has('--critique') ? { runCritique: true } : {}),
  });

  if (!flags.has('--wait')) {
    if (flags.has('--json')) return printJson({ nodeId: node.id, runId: run.id, status: run.status });
    console.log(`${pc.green('✓')} submitted ${pc.bold(node.id)} — run ${run.id} rendering`);
    if (flags.has('--critique')) console.log(pc.dim('  critic will run when the render lands'));
    return;
  }

  // Poll until the run reaches a terminal status. Renders queue behind the
  // project's render semaphore, so allow plenty of wall clock.
  const deadline = Date.now() + 15 * 60 * 1000;
  let last = run.status as string;
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    const detail = await client.nodes.get.query({ nodeId });
    const current = detail.currentRun;
    if (current && current.id === run.id) last = current.status;
    if (current && current.id === run.id && current.status !== 'running') {
      if (flags.has('--json')) {
        return printJson({
          nodeId,
          runId: current.id,
          status: current.status,
          commitSha: current.commitSha,
          previewUrl: current.previewUrl,
          error: current.error,
        });
      }
      if (current.status === 'done') {
        console.log(`${pc.green('✓')} ${pc.bold(nodeId)} rendered — run ${current.id}`);
        if (current.commitSha) console.log(`  ${pc.dim('commit:')} ${current.commitSha}`);
        if (current.previewUrl) console.log(`  ${pc.dim('preview:')} ${current.previewUrl}`);
      } else {
        console.error(
          pc.red(`run ${current.id} landed ${current.status}`) +
            (current.error ? pc.dim(` — ${current.error.phase}: ${current.error.message}`) : '')
        );
        process.exit(1);
      }
      return;
    }
    if (Date.now() > deadline) {
      console.error(pc.red(`Timed out waiting for run ${run.id} (last status: ${last}).`));
      process.exit(1);
    }
  }
}
