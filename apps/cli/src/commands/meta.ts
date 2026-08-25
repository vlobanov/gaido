import pc from 'picocolors';
import { connect, parseArgv, printJson } from '../client.js';

/**
 * Branch metadata — typed key/values the project declares in `gaido.config.ts`
 * (`meta: [...]`), shared by every coder on a branch: what the branch *is*
 * outside gaido (the template it was published as, a ticket, an approval
 * flag). Stored once on the branch anchor, so Continue inherits it and a Fork
 * starts clean. A critique/config id resolves to its coder's branch.
 *
 *   gaido meta <nodeId>                         print the branch's meta
 *   gaido meta <nodeId> key=value [key=value…]  merge-patch (re-stamps each key)
 *   gaido meta <nodeId> --unset key [--unset …] delete keys
 *   gaido meta <nodeId> --clear                 wipe the branch's meta
 *   gaido meta --fields                         the declared schema
 *
 * Values are coerced to the declared type server-side (`true`/`false`,
 * numbers); undeclared keys are rejected when a schema exists.
 */
export async function runMeta(cwd: string, argv: string[]): Promise<void> {
  const { positionals, flags, options, repeated } = parseMetaArgv(argv);
  const { client } = await connect(cwd, options['--url']);

  if (flags.has('--fields')) {
    const info = await client.system.info.query();
    const fields = info.metaFields ?? [];
    if (flags.has('--json')) return printJson(fields);
    if (fields.length === 0) {
      console.log(pc.dim('(no meta fields declared — free-form keys accepted)'));
      return;
    }
    for (const f of fields) {
      console.log(
        `${pc.bold(f.key.padEnd(28))} ${f.type.padEnd(8)} ${f.label ? pc.dim(f.label) : ''}${
          f.card ? pc.dim('  · card') : ''
        }${f.private ? pc.dim('  · private') : ''}`
      );
    }
    return;
  }

  const nodeId = positionals[0];
  if (!nodeId) {
    throw new Error(
      'usage: gaido meta <nodeId> [key=value …] [--unset key] [--clear] | gaido meta --fields'
    );
  }
  const assignments = positionals.slice(1);
  const unsets = repeated['--unset'] ?? [];

  if (flags.has('--clear')) {
    if (assignments.length > 0 || unsets.length > 0) {
      throw new Error('pass either --clear or key=value / --unset, not both');
    }
    const res = await client.nodes.clearMeta.mutate({ nodeId });
    if (flags.has('--json')) return printJson(res);
    console.log(`${pc.green('✓')} meta cleared on branch of ${pc.bold(res.nodeId)}`);
    return;
  }

  if (assignments.length === 0 && unsets.length === 0) {
    const detail = await client.nodes.get.query({ nodeId });
    const meta = detail.meta ?? null;
    if (flags.has('--json')) {
      return printJson({
        nodeId: detail.node.id,
        branchAnchorId: detail.branchAnchorId,
        branchSize: detail.branchSize,
        meta,
      });
    }
    if (!meta) {
      console.log(pc.dim('(no meta on this branch)'));
      return;
    }
    printMeta(meta, nodeId);
    return;
  }

  const patch: Record<string, string | null> = {};
  for (const a of assignments) {
    const eq = a.indexOf('=');
    if (eq <= 0) throw new Error(`expected key=value, got "${a}"`);
    patch[a.slice(0, eq)] = a.slice(eq + 1);
  }
  for (const k of unsets) patch[k] = null;

  const res = await client.nodes.setMeta.mutate({ nodeId, patch });
  if (flags.has('--json')) return printJson(res);
  console.log(`${pc.green('✓')} meta on branch of ${pc.bold(res.nodeId)}:`);
  if (res.meta) printMeta(res.meta, res.nodeId);
  else console.log(pc.dim('  (empty)'));
}

function printMeta(
  meta: Record<string, { value: string | number | boolean; at: number; nodeId: string }>,
  viaNodeId: string
): void {
  for (const [key, entry] of Object.entries(meta)) {
    const when = new Date(entry.at).toISOString().slice(0, 16).replace('T', ' ');
    const via = entry.nodeId === viaNodeId ? 'here' : `via ${entry.nodeId}`;
    console.log(
      `  ${pc.bold(key.padEnd(26))} ${String(entry.value).padEnd(32)} ${pc.dim(`${via} · ${when}`)}`
    );
  }
}

/**
 * `parseArgv` keeps one value per option; `--unset` repeats, so collect it
 * before delegating the rest.
 */
function parseMetaArgv(argv: string[]): ReturnType<typeof parseArgv> & {
  repeated: Record<string, string[]>;
} {
  const rest: string[] = [];
  const repeated: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--unset') {
      const v = argv[++i];
      if (v === undefined) throw new Error('--unset needs a key');
      (repeated['--unset'] ??= []).push(v);
    } else {
      rest.push(a);
    }
  }
  const parsed = parseArgv(rest, {
    flags: ['--json', '--clear', '--fields'],
    options: { '--url': [] },
  });
  return { ...parsed, repeated };
}
