import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import {
  connect,
  parseArgv,
  printJson,
  resolveCanvas,
  truncate,
  type GaidoClient,
} from '../client.js';

/** Rows from `nodes.list` — inferred from the router, aliased for readability. */
type NodeRow = Awaited<ReturnType<GaidoClient['nodes']['list']['query']>>[number];

function statusLabel(status: string): string {
  switch (status) {
    case 'done':
      return pc.green(status);
    case 'running':
      return pc.cyan(status);
    case 'failed':
      return pc.red(status);
    case 'idle':
      return pc.dim(status);
    default:
      return pc.yellow(status); // cancelled / interrupted
  }
}

export async function runCanvases(cwd: string, argv: string[]): Promise<void> {
  const { flags, options } = parseArgv(argv, {
    flags: ['--json'],
    options: { '--url': [] },
  });
  const { client } = await connect(cwd, options['--url']);
  const canvases = await client.canvases.list.query();
  if (flags.has('--json')) return printJson(canvases);
  for (const c of canvases) {
    console.log(`${pc.cyan(c.slug.padEnd(20))} ${c.id}  ${pc.dim(c.name ?? '')}`);
  }
}

export async function runNodes(cwd: string, argv: string[]): Promise<void> {
  const { flags, options } = parseArgv(argv, {
    flags: ['--json'],
    options: { '--canvas': [], '--url': [] },
  });
  const { client } = await connect(cwd, options['--url']);
  const canvas = await resolveCanvas(client, options['--canvas']);
  const nodes = await client.nodes.list.query(
    canvas ? { canvasId: canvas.id } : undefined
  );
  if (flags.has('--json')) return printJson(nodes);
  for (const n of nodes) {
    const coder = n.kind === 'coder' ? (n.external ? 'external' : n.resolvedCoderName) : '';
    console.log(
      `${n.id}  ${n.kind.padEnd(11)} ${statusLabel(n.status).padEnd(16)} ` +
        `${pc.magenta(coder.padEnd(14))} ${pc.dim(truncate(n.instruction, 60))}`
    );
  }
}

export async function runNode(cwd: string, argv: string[]): Promise<void> {
  const { positionals, flags, options } = parseArgv(argv, {
    flags: ['--json'],
    options: { '--url': [] },
  });
  const nodeId = positionals[0];
  if (!nodeId) throw new Error('usage: gaido node <nodeId> [--json]');
  const { client } = await connect(cwd, options['--url']);
  const detail = await client.nodes.get.query({ nodeId });
  if (flags.has('--json')) return printJson(detail);

  const { node, currentRun } = detail;
  console.log(`${pc.bold(node.id)}  ${node.kind} · ${statusLabel(node.status)}`);
  console.log(`${pc.dim('instruction:')} ${node.instruction}`);
  if (node.kind === 'coder') {
    console.log(`${pc.dim('coder:')}       ${detail.resolvedCoderName}`);
  }
  if (detail.worktreePath) console.log(`${pc.dim('worktree:')}    ${detail.worktreePath}`);
  if (detail.logDir) console.log(`${pc.dim('logs:')}        ${detail.logDir}`);
  if (currentRun) {
    console.log(`${pc.dim('run:')}         ${currentRun.id} · ${statusLabel(currentRun.status)}`);
    if (currentRun.commitSha)
      console.log(`${pc.dim('commit:')}      ${currentRun.commitSha}`);
    if (currentRun.previewUrl)
      console.log(`${pc.dim('preview:')}     ${currentRun.previewUrl}`);
    if (currentRun.error) {
      console.log(
        pc.red(`error (${currentRun.error.phase}): ${currentRun.error.message}`)
      );
    }
    if (currentRun.critique) {
      console.log(`\n${formatCritique(currentRun.critique)}`);
    }
  }
}

export async function runTree(cwd: string, argv: string[]): Promise<void> {
  const { options } = parseArgv(argv, {
    options: { '--canvas': [], '--url': [] },
  });
  const { client } = await connect(cwd, options['--url']);
  const canvasFilter = await resolveCanvas(client, options['--canvas']);
  const canvases = canvasFilter
    ? [canvasFilter]
    : await client.canvases.list.query();
  const nodes = await client.nodes.list.query(
    canvasFilter ? { canvasId: canvasFilter.id } : undefined
  );

  const byParent = new Map<string | null, NodeRow[]>();
  for (const n of nodes) {
    const list = byParent.get(n.parentId) ?? [];
    list.push(n);
    byParent.set(n.parentId, list);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.createdAt - b.createdAt);

  const label = (n: NodeRow): string => {
    const bits = [pc.bold(n.id), n.kind, statusLabel(n.status)];
    if (n.kind === 'coder') {
      bits.push(pc.magenta(n.external ? 'external' : n.resolvedCoderName));
    }
    bits.push(pc.dim(`"${truncate(n.instruction, 48)}"`));
    return bits.join(' · ');
  };

  const printSubtree = (n: NodeRow, prefix: string, isLast: boolean): void => {
    console.log(`${prefix}${isLast ? '└─ ' : '├─ '}${label(n)}`);
    const children = (byParent.get(n.id) ?? []).filter((c) => c.canvasId === n.canvasId);
    const childPrefix = prefix + (isLast ? '   ' : '│  ');
    children.forEach((c, i) => printSubtree(c, childPrefix, i === children.length - 1));
  };

  for (const canvas of canvases) {
    const roots = (byParent.get(null) ?? []).filter((n) => n.canvasId === canvas.id);
    if (canvases.length > 1 && roots.length === 0) continue;
    console.log(pc.bold(`canvas ${canvas.slug}`) + pc.dim(` (${canvas.id})`));
    roots.forEach((r, i) => printSubtree(r, '', i === roots.length - 1));
    console.log('');
  }
}

export async function runLogs(cwd: string, argv: string[]): Promise<void> {
  const { positionals, flags, options } = parseArgv(argv, {
    flags: ['--dir'],
    options: { '--url': [] },
  });
  const id = positionals[0];
  if (!id) throw new Error('usage: gaido logs <runId|nodeId> [--dir]');

  let runId = id;
  let logDir: string | null = null;
  if (id.startsWith('n_')) {
    const { client } = await connect(cwd, options['--url']);
    const detail = await client.nodes.get.query({ nodeId: id });
    if (!detail.currentRun) {
      console.error(pc.red(`Node ${id} has no run yet.`));
      process.exit(1);
    }
    runId = detail.currentRun.id;
    logDir = detail.logDir;
  }
  logDir ??= path.join(cwd, 'runs', '.logs', runId);

  if (!fs.existsSync(logDir)) {
    console.error(pc.red(`No logs at ${logDir}.`));
    process.exit(1);
  }
  if (flags.has('--dir')) {
    console.log(logDir);
    return;
  }
  const events = path.join(logDir, 'events.ndjson');
  if (fs.existsSync(events)) {
    process.stdout.write(fs.readFileSync(events, 'utf8'));
  } else {
    console.log(pc.dim(`(no events.ndjson — files in ${logDir}:)`));
    for (const f of fs.readdirSync(logDir)) console.log(f);
  }
}

export async function runCritiques(cwd: string, argv: string[]): Promise<void> {
  const { flags, options } = parseArgv(argv, {
    flags: ['--json'],
    options: { '--canvas': [], '--url': [] },
  });
  const { client } = await connect(cwd, options['--url']);
  const canvas = await resolveCanvas(client, options['--canvas']);
  const critiques = await client.runs.listCritiques.query(
    canvas ? { canvasId: canvas.id } : undefined
  );
  if (flags.has('--json')) return printJson(critiques);
  if (critiques.length === 0) {
    console.log(pc.dim('No critiques yet.'));
    return;
  }
  for (const c of critiques) {
    console.log(
      pc.bold(`── ${c.nodeId}`) +
        pc.dim(` (coder ${c.coderNodeId ?? '?'}, run ${c.runId})`)
    );
    if (c.critique) console.log(formatCritique(c.critique));
    console.log('');
  }
}

function formatCritique(critique: {
  overall: string;
  rating?: number;
  strengths: string[];
  weaknesses: string[];
  suggestions: string[];
  proposedRules?: string[];
  author?: { kind: string; critic?: string; model?: string };
}): string {
  const lines: string[] = [];
  const author =
    critique.author?.kind === 'human'
      ? 'human'
      : [critique.author?.critic, critique.author?.model].filter(Boolean).join(' ');
  const head = [
    critique.rating != null ? `rating ${critique.rating}/5` : null,
    author || null,
  ]
    .filter(Boolean)
    .join(' · ');
  if (head) lines.push(pc.dim(head));
  lines.push(critique.overall);
  const section = (title: string, items: string[] | undefined) => {
    if (!items?.length) return;
    lines.push(pc.dim(`${title}:`));
    for (const item of items) lines.push(`  - ${item}`);
  };
  section('strengths', critique.strengths);
  section('weaknesses', critique.weaknesses);
  section('suggestions', critique.suggestions);
  section('proposed rules', critique.proposedRules);
  return lines.join('\n');
}
