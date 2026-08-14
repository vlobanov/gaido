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
