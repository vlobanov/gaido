import fs from 'node:fs';
import path from 'node:path';
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import type { AppRouter } from '@vadimlobanov/gaido-server';
import pc from 'picocolors';

/**
 * Typed tRPC client for a running gaido server. The CLI's graph commands
 * (`nodes`, `fork`, `submit`, …) are thin clients over the same API the web
 * UI uses — the server owns the DB, the orchestrator, and the render
 * semaphores, so nothing here touches gaido.db directly.
 */
export type GaidoClient = ReturnType<typeof createTRPCClient<AppRouter>>;

/**
 * Base URL resolution, in priority order: explicit `--url`, `GAIDO_URL`,
 * a best-effort port sniff from gaido.config.ts (a full config load would
 * execute adapter factories just to read one number), else the default port.
 */
export function resolveServerUrl(cwd: string, explicitUrl?: string): string {
  const fromEnv = explicitUrl ?? process.env['GAIDO_URL'];
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  let port = 4288;
  try {
    const src = fs.readFileSync(path.join(cwd, 'gaido.config.ts'), 'utf8');
    const m = src.match(/server\s*:\s*\{[^}]*?port\s*:\s*(\d{2,5})/);
    if (m?.[1]) port = Number(m[1]);
  } catch {
    // no config in cwd — probably not a project dir; connect() will say so
  }
  return `http://127.0.0.1:${port}`;
}

export interface Connection {
  client: GaidoClient;
  url: string;
}

/**
 * Connect to the project's server, probing /health first so a stopped server
 * fails with one clear instruction instead of a tRPC fetch stack trace.
 */
export async function connect(cwd: string, explicitUrl?: string): Promise<Connection> {
  const url = resolveServerUrl(cwd, explicitUrl);
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`health check returned ${res.status}`);
  } catch {
    console.error(
      pc.red(`\nNo gaido server responding at ${url}.\n`) +
        pc.dim(
          `Start it with \`gaido\` in the project directory (or point at it with --url / GAIDO_URL).\n`
        )
    );
    process.exit(1);
  }
  const client = createTRPCClient<AppRouter>({
    links: [httpBatchLink({ url: `${url}/trpc` })],
  });
  return { client, url };
}

/**
 * Resolve `--canvas <slug-or-id>` to a canvas row. Undefined input returns
 * null (meaning "no filter" for list commands, "default" where one is needed).
 */
export async function resolveCanvas(
  client: GaidoClient,
  ref: string | undefined
): Promise<{ id: string; slug: string; name: string | null } | null> {
  if (!ref) return null;
  const bySlugOrId = ref.startsWith('c_')
    ? await client.canvases.get.query({ id: ref })
    : await client.canvases.get.query({ slug: ref });
  if (!bySlugOrId) {
    console.error(pc.red(`Canvas '${ref}' not found.`));
    process.exit(1);
  }
  return bySlugOrId;
}

/** Shared minimal flag parser: `--flag`, `--key value`, `-m value`, positionals. */
export function parseArgv(
  argv: string[],
  spec: { flags?: string[]; options?: Record<string, string[]> }
): { positionals: string[]; flags: Set<string>; options: Record<string, string> } {
  const flagNames = new Set(spec.flags ?? []);
  // canonical name → accepted aliases
  const optionAliases = new Map<string, string>();
  for (const [canonical, aliases] of Object.entries(spec.options ?? {})) {
    for (const a of [canonical, ...aliases]) optionAliases.set(a, canonical);
  }
  const positionals: string[] = [];
  const flags = new Set<string>();
  const options: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (flagNames.has(a)) {
      flags.add(a);
    } else if (optionAliases.has(a)) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      options[optionAliases.get(a)!] = v;
    } else if (a.startsWith('-')) {
      throw new Error(`unknown flag: ${a}`);
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags, options };
}

export function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

export function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/**
 * Resolve a node reference to a critique node id for actions that operate on
 * critiques (`feedback`, `critique`, `continue`, `switch`). Pointing at a
 * coder resolves to its auto-spawned critique child — the same convenience
 * the UI's card actions provide — so "give feedback on this render" works
 * with the id the agent naturally has in hand.
 */
export async function resolveCritiqueNodeId(
  client: GaidoClient,
  nodeId: string
): Promise<string> {
  const { node } = await client.nodes.get.query({ nodeId });
  if (node.kind === 'critique') return node.id;
  if (node.kind !== 'coder') {
    console.error(pc.red(`${nodeId} is a ${node.kind} node — expected a coder or critique.`));
    process.exit(1);
  }
  const siblings = await client.nodes.list.query({ canvasId: node.canvasId });
  const critique = siblings.find(
    (n) => n.parentId === node.id && n.kind === 'critique'
  );
  if (!critique) {
    console.error(
      pc.red(`Coder ${nodeId} has no critique child yet — it appears once the coder lands a successful run.`)
    );
    process.exit(1);
  }
  return critique.id;
}

/**
 * Poll a node until the given run reaches a terminal status, then report the
 * outcome (exit 1 on anything but `done`). Coding runs take minutes and queue
 * behind the project's semaphores, so the deadline is generous.
 */
export async function waitForRun(
  client: GaidoClient,
  nodeId: string,
  runId: string,
  opts: { json: boolean; timeoutMs?: number }
): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 30 * 60 * 1000);
  let last = 'running';
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    const detail = await client.nodes.get.query({ nodeId });
    const current = detail.currentRun;
    if (current && current.id === runId) last = current.status;
    if (current && current.id === runId && current.status !== 'running') {
      if (opts.json) {
        printJson({
          nodeId,
          runId: current.id,
          status: current.status,
          commitSha: current.commitSha,
          previewUrl: current.previewUrl,
          error: current.error,
          critique: current.critique,
        });
      } else if (current.status === 'done') {
        console.log(`${pc.green('✓')} ${pc.bold(nodeId)} done — run ${current.id}`);
        if (current.commitSha) console.log(`  ${pc.dim('commit:')} ${current.commitSha}`);
        if (current.previewUrl) console.log(`  ${pc.dim('preview:')} ${current.previewUrl}`);
      } else {
        console.error(
          pc.red(`run ${current.id} landed ${current.status}`) +
            (current.error ? pc.dim(` — ${current.error.phase}: ${current.error.message}`) : '')
        );
        process.exit(1);
      }
      if (current.status !== 'done' && opts.json) process.exit(1);
      return;
    }
    if (Date.now() > deadline) {
      console.error(pc.red(`Timed out waiting for run ${runId} (last status: ${last}).`));
      process.exit(1);
    }
  }
}
