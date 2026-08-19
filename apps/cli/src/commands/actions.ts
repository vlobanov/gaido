import pc from 'picocolors';
import {
  connect,
  parseArgv,
  printJson,
  resolveCanvas,
  resolveCritiqueNodeId,
  waitForRun,
} from '../client.js';

/**
 * Everything a human can do from the UI's cards and modals, as CLI verbs —
 * so an external agent can drive the full loop: seed roots, run/write
 * critiques, launch more coders, steer and stop them.
 */

/**
 * `gaido root "<prompt>"` — seed a new instruction root and run its coder
 * (the seed modal). `--batch coder[:skeleton],…` fans the same prompt out
 * over several coder×skeleton branches (the Batch button).
 */
export async function runRoot(cwd: string, argv: string[]): Promise<void> {
  const { positionals, flags, options } = parseArgv(argv, {
    flags: ['--json', '--wait'],
    options: {
      '--canvas': [],
      '--coder': [],
      '--skeleton': [],
      '--auto': [],
      '--batch': [],
      '--url': [],
    },
  });
  const instruction = positionals.join(' ').trim();
  if (!instruction) {
    throw new Error(
      'usage: gaido root "<prompt>" [--canvas <slug>] [--coder <name>] [--skeleton <name>] [--auto N] [--batch coder[:skeleton],…]'
    );
  }
  const { client } = await connect(cwd, options['--url']);
  const canvas = await resolveCanvas(client, options['--canvas']);

  if (options['--batch']) {
    if (options['--coder'] || options['--skeleton'] || options['--auto']) {
      throw new Error('--batch replaces --coder/--skeleton (and auto-run is per-root only)');
    }
    const combinations = options['--batch'].split(',').map((entry) => {
      const [coderName, skeletonName] = entry.trim().split(':');
      if (!coderName) throw new Error(`bad --batch entry: '${entry}' (want coder[:skeleton])`);
      return { coderName, ...(skeletonName ? { skeletonName } : {}) };
    });
    const { node, coderIds, runs } = await client.nodes.createBatch.mutate({
      instruction,
      ...(canvas ? { canvasId: canvas.id } : {}),
      combinations,
    });
    if (flags.has('--json')) {
      return printJson({ rootId: node.id, coderIds, runIds: runs.map((r) => r.id) });
    }
    console.log(`${pc.green('✓')} root ${pc.bold(node.id)} with ${coderIds.length} branches:`);
    coderIds.forEach((id, i) => {
      console.log(`  ${id}  ${pc.magenta(combinations[i]!.coderName)}${combinations[i]!.skeletonName ? pc.dim(` · ${combinations[i]!.skeletonName}`) : ''}`);
    });
    console.log(pc.dim('\nFollow along: gaido tree, or gaido node <id>'));
    return;
  }

  const auto = options['--auto'] ? Number(options['--auto']) : undefined;
  if (auto !== undefined && (!Number.isInteger(auto) || auto < 1)) {
    throw new Error('--auto wants a positive integer');
  }
  const { node, run } = await client.nodes.createRoot.mutate({
    instruction,
    ...(canvas ? { canvasId: canvas.id } : {}),
    ...(options['--coder'] ? { coderName: options['--coder'] } : {}),
    ...(options['--skeleton'] ? { skeletonName: options['--skeleton'] } : {}),
    ...(auto ? { autoRun: auto } : {}),
  });
  if (flags.has('--wait')) return waitForRun(client, node.id, run.id, { json: flags.has('--json') });
  if (flags.has('--json')) return printJson({ nodeId: node.id, runId: run.id, status: run.status });
  console.log(`${pc.green('✓')} coder ${pc.bold(node.id)} running — run ${run.id}`);
  console.log(pc.dim(`Follow along: gaido node ${node.id} (or --wait next time)`));
}

/** `gaido coders` — the project's coder registry (for --coder choices). */
export async function runCoders(cwd: string, argv: string[]): Promise<void> {
  const { flags, options } = parseArgv(argv, {
    flags: ['--json'],
    options: { '--url': [] },
  });
  const { client } = await connect(cwd, options['--url']);
  const coders = await client.coders.list.query();
  if (flags.has('--json')) return printJson(coders);
  for (const c of coders) {
    console.log(
      `${pc.magenta(c.name.padEnd(16))} ${pc.dim(c.kind)}${c.isDefault ? pc.green('  (default)') : ''}`
    );
  }
}

/**
 * `gaido feedback <coderOrCritiqueId> "<notes>" [--rating 1-5]` — write a
 * human critique onto the critique node (the human-critic editor and the
 * "Critique manually" override alike). A coder id resolves to its critique
 * child. The critique lands done; iterate from it with `gaido continue`.
 */
export async function runFeedback(cwd: string, argv: string[]): Promise<void> {
  const { positionals, flags, options } = parseArgv(argv, {
    flags: ['--json'],
    options: { '--rating': [], '--url': [] },
  });
  const target = positionals[0];
  const notes = positionals.slice(1).join(' ').trim();
  if (!target || !notes) {
    throw new Error('usage: gaido feedback <coderOrCritiqueId> "<notes>" [--rating 1-5]');
  }
  const rating = options['--rating'] ? Number(options['--rating']) : undefined;
  if (rating !== undefined && (!Number.isInteger(rating) || rating < 1 || rating > 5)) {
    throw new Error('--rating wants an integer 1-5');
  }
  const { client } = await connect(cwd, options['--url']);
  const critiqueId = await resolveCritiqueNodeId(client, target);
  const run = await client.runs.setHumanCritique.mutate({
    nodeId: critiqueId,
    notes,
    ...(rating ? { rating } : {}),
  });
  if (flags.has('--json')) return printJson({ nodeId: critiqueId, runId: run.id });
  console.log(`${pc.green('✓')} feedback saved on ${pc.bold(critiqueId)}`);
  console.log(pc.dim(`Iterate from it: gaido continue ${critiqueId}`));
}

/**
 * `gaido critique <coderOrCritiqueId>` — run the configured model critic on
 * the critique node (the idle-critique "Run critic" click; re-running
 * overwrites). Rejected on human-critic projects — use `gaido feedback`.
 */
export async function runCritiqueNode(cwd: string, argv: string[]): Promise<void> {
  const { positionals, flags, options } = parseArgv(argv, {
    flags: ['--json', '--wait'],
    options: { '--url': [] },
  });
  const target = positionals[0];
  if (!target) throw new Error('usage: gaido critique <coderOrCritiqueId> [--wait]');
  const { client } = await connect(cwd, options['--url']);
  const info = await client.system.info.query();
  if (info.criticKind === 'human') {
    console.error(
      pc.red('This project uses a human critic — write the review yourself with `gaido feedback`.')
    );
    process.exit(1);
  }
  const critiqueId = await resolveCritiqueNodeId(client, target);
  const run = await client.nodes.retry.mutate({ nodeId: critiqueId });
  if (flags.has('--wait')) return waitForRun(client, critiqueId, run.id, { json: flags.has('--json') });
  if (flags.has('--json')) return printJson({ nodeId: critiqueId, runId: run.id, status: run.status });
  console.log(`${pc.green('✓')} critic running on ${pc.bold(critiqueId)} — run ${run.id}`);
}

/**
 * `gaido continue <coderOrCritiqueId>` — continue iterating on the same
 * branch (resumed session, critique feedback as the instruction). The
 * critique must hold a saved review first.
 */
export async function runContinue(cwd: string, argv: string[]): Promise<void> {
  const { positionals, flags, options } = parseArgv(argv, {
    flags: ['--json', '--wait'],
    options: { '--url': [] },
  });
  const target = positionals[0];
  if (!target) throw new Error('usage: gaido continue <coderOrCritiqueId> [--wait]');
  const { client } = await connect(cwd, options['--url']);
  const critiqueId = await resolveCritiqueNodeId(client, target);
  const { node, run } = await client.nodes.continue.mutate({ critiqueNodeId: critiqueId });
  if (flags.has('--wait')) return waitForRun(client, node.id, run.id, { json: flags.has('--json') });
  if (flags.has('--json')) return printJson({ nodeId: node.id, runId: run.id, status: run.status });
  console.log(`${pc.green('✓')} coder ${pc.bold(node.id)} continuing — run ${run.id}`);
}

/**
 * `gaido retry <nodeId>` — re-run a leaf coder (or a critique) from scratch.
 * `-m` steers the re-run; `--coder` swaps the model (session-compatible only).
 */
export async function runRetry(cwd: string, argv: string[]): Promise<void> {
  const { positionals, flags, options } = parseArgv(argv, {
    flags: ['--json', '--wait'],
    options: { '--message': ['-m'], '--coder': [], '--url': [] },
  });
  const nodeId = positionals[0];
  if (!nodeId) throw new Error('usage: gaido retry <nodeId> [-m "<steer>"] [--coder <name>] [--wait]');
  const { client } = await connect(cwd, options['--url']);
  const run = await client.nodes.retry.mutate({
    nodeId,
    ...(options['--message'] ? { prompt: options['--message'] } : {}),
    ...(options['--coder'] ? { coderName: options['--coder'] } : {}),
  });
  if (flags.has('--wait')) return waitForRun(client, nodeId, run.id, { json: flags.has('--json') });
  if (flags.has('--json')) return printJson({ nodeId, runId: run.id, status: run.status });
  console.log(`${pc.green('✓')} retrying ${pc.bold(nodeId)} — run ${run.id}`);
}

/**
 * `gaido reply <coderId> "<text>"` — next turn in the leaf coder's live
 * session (the card's reply box), e.g. answering a question the coder asked.
 */
export async function runReply(cwd: string, argv: string[]): Promise<void> {
  const { positionals, flags, options } = parseArgv(argv, {
    flags: ['--json', '--wait'],
    options: { '--url': [] },
  });
  const nodeId = positionals[0];
  const text = positionals.slice(1).join(' ').trim();
  if (!nodeId || !text) throw new Error('usage: gaido reply <coderId> "<text>" [--wait]');
  const { client } = await connect(cwd, options['--url']);
  const run = await client.nodes.reply.mutate({ nodeId, text });
  if (flags.has('--wait')) return waitForRun(client, nodeId, run.id, { json: flags.has('--json') });
  if (flags.has('--json')) return printJson({ nodeId, runId: run.id, status: run.status });
  console.log(`${pc.green('✓')} replied to ${pc.bold(nodeId)} — run ${run.id}`);
}

/**
 * `gaido auto <nodeId> -n <N>` — start an unattended code→critique→continue
 * loop from a leaf (needs a model critic). `--stop` interrupts the loop
 * reachable from the node (soft: current step finishes); `--stop --now`
 * also aborts the in-flight run.
 */
export async function runAuto(cwd: string, argv: string[]): Promise<void> {
  const { positionals, flags, options } = parseArgv(argv, {
    flags: ['--json', '--stop', '--now'],
    options: { '--iterations': ['-n'], '--url': [] },
  });
  const nodeId = positionals[0];
  if (!nodeId) {
    throw new Error('usage: gaido auto <nodeId> -n <iterations> | gaido auto <nodeId> --stop [--now]');
  }
  const { client } = await connect(cwd, options['--url']);

  if (flags.has('--stop')) {
    const result = await client.nodes.interruptAuto.mutate({
      nodeId,
      mode: flags.has('--now') ? 'now' : 'after',
    });
    if (flags.has('--json')) return printJson(result);
    console.log(
      result.stopped
        ? `${pc.green('✓')} auto-run stopped at ${pc.bold(result.stopped)}${flags.has('--now') ? '' : pc.dim(' (in-flight step will finish)')}`
        : pc.dim('No auto-run in flight on that chain.')
    );
    return;
  }

  const iterations = options['--iterations'] ? Number(options['--iterations']) : NaN;
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new Error('-n wants a positive integer (how many coder cycles to run)');
  }
  const { nodeId: startId, run } = await client.nodes.autoRun.mutate({ nodeId, iterations });
  if (flags.has('--json')) return printJson({ startedAt: startId, runId: run.id, iterations });
  console.log(`${pc.green('✓')} auto-run of ${iterations} started at ${pc.bold(startId)} — run ${run.id}`);
  console.log(pc.dim(`Stop it: gaido auto ${startId} --stop [--now]`));
}

/**
 * `gaido switch <coderOrCritiqueId> --coder <name> -m "<instruction>"` —
 * switch coder mid-graph via a config node, then run the new coder.
 * Default policy is `reset` (fresh session off the parent's code);
 * `--retain` resumes the existing session (same adapter kind only).
 */
export async function runSwitch(cwd: string, argv: string[]): Promise<void> {
  const { positionals, flags, options } = parseArgv(argv, {
    flags: ['--json', '--wait', '--retain'],
    options: { '--coder': [], '--message': ['-m'], '--url': [] },
  });
  const target = positionals[0];
  const coderName = options['--coder'];
  const instruction = options['--message'];
  if (!target || !coderName || !instruction) {
    throw new Error(
      'usage: gaido switch <coderOrCritiqueId> --coder <name> -m "<instruction>" [--retain] [--wait]'
    );
  }
  const { client } = await connect(cwd, options['--url']);
  const critiqueId = await resolveCritiqueNodeId(client, target);
  const { node, run } = await client.nodes.switchCoder.mutate({
    critiqueNodeId: critiqueId,
    coderName,
    sessionPolicy: flags.has('--retain') ? 'retain' : 'reset',
    instruction,
  });
  if (flags.has('--wait')) return waitForRun(client, node.id, run.id, { json: flags.has('--json') });
  if (flags.has('--json')) return printJson({ nodeId: node.id, runId: run.id, status: run.status });
  console.log(`${pc.green('✓')} switched to ${pc.magenta(coderName)} — coder ${pc.bold(node.id)} running (run ${run.id})`);
}

/** `gaido cancel <nodeId>` — abort the node's in-flight run. */
export async function runCancel(cwd: string, argv: string[]): Promise<void> {
  const { positionals, flags, options } = parseArgv(argv, {
    flags: ['--json'],
    options: { '--url': [] },
  });
  const nodeId = positionals[0];
  if (!nodeId) throw new Error('usage: gaido cancel <nodeId>');
  const { client } = await connect(cwd, options['--url']);
  await client.nodes.cancel.mutate({ nodeId });
  if (flags.has('--json')) return printJson({ nodeId, ok: true });
  console.log(`${pc.green('✓')} cancelled ${pc.bold(nodeId)}`);
}

/**
 * `gaido rerender <coderId>` — repeat only the render phase of the node's
 * current run (transient renderer failure; no coder turn, no tokens).
 */
export async function runRerender(cwd: string, argv: string[]): Promise<void> {
  const { positionals, flags, options } = parseArgv(argv, {
    flags: ['--json', '--wait'],
    options: { '--url': [] },
  });
  const nodeId = positionals[0];
  if (!nodeId) throw new Error('usage: gaido rerender <coderId> [--wait]');
  const { client } = await connect(cwd, options['--url']);
  const run = await client.nodes.rerunRender.mutate({ nodeId });
  if (flags.has('--wait')) return waitForRun(client, nodeId, run.id, { json: flags.has('--json') });
  if (flags.has('--json')) return printJson({ nodeId, runId: run.id, status: run.status });
  console.log(`${pc.green('✓')} re-rendering ${pc.bold(nodeId)} — run ${run.id}`);
}

/** `gaido favorite <nodeId> [--off]` — star/unstar a node. */
export async function runFavorite(cwd: string, argv: string[]): Promise<void> {
  const { positionals, flags, options } = parseArgv(argv, {
    flags: ['--json', '--off'],
    options: { '--url': [] },
  });
  const nodeId = positionals[0];
  if (!nodeId) throw new Error('usage: gaido favorite <nodeId> [--off]');
  const { client } = await connect(cwd, options['--url']);
  const node = await client.nodes.setFavorite.mutate({
    nodeId,
    isFavorite: !flags.has('--off'),
  });
  if (flags.has('--json')) return printJson({ nodeId: node.id, isFavorite: node.isFavorite });
  console.log(`${pc.green('✓')} ${pc.bold(node.id)} ${node.isFavorite ? 'starred' : 'unstarred'}`);
}

/**
 * `gaido delete <nodeId> --yes` — delete the node AND its whole subtree
 * (runs, artifacts, worktrees). Destructive, hence the explicit --yes.
 */
export async function runDelete(cwd: string, argv: string[]): Promise<void> {
  const { positionals, flags, options } = parseArgv(argv, {
    flags: ['--json', '--yes'],
    options: { '--url': [] },
  });
  const nodeId = positionals[0];
  if (!nodeId) throw new Error('usage: gaido delete <nodeId> --yes');
  if (!flags.has('--yes')) {
    console.error(
      pc.red(`This deletes ${nodeId} and its ENTIRE subtree (runs, artifacts, worktrees).`) +
        `\nRe-run with --yes to confirm.`
    );
    process.exit(1);
  }
  const { client } = await connect(cwd, options['--url']);
  await client.nodes.delete.mutate({ nodeId });
  if (flags.has('--json')) return printJson({ nodeId, deleted: true });
  console.log(`${pc.green('✓')} deleted ${pc.bold(nodeId)} and its subtree`);
}
