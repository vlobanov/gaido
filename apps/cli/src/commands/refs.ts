import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { connect, parseArgv, printJson, truncate } from '../client.js';

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/**
 * References — artist inputs attached to a coder node, materialized into its
 * worktree's `references/` before each run:
 *
 *   gaido ref list <coderId>
 *   gaido ref add <coderId> --image <path>   attach a local image
 *   gaido ref add <coderId> --run <r_id>     attach another run's code+keyframes
 *   gaido ref rm <referenceId>
 */
export async function runRef(cwd: string, argv: string[]): Promise<void> {
  const { positionals, flags, options } = parseArgv(argv, {
    flags: ['--json'],
    options: { '--image': [], '--run': [], '--url': [] },
  });
  const sub = positionals[0];
  const { client } = await connect(cwd, options['--url']);

  if (sub === 'list') {
    const nodeId = positionals[1];
    if (!nodeId) throw new Error('usage: gaido ref list <coderId>');
    const refs = await client.references.list.query({ nodeId });
    if (flags.has('--json')) return printJson(refs);
    if (refs.length === 0) return console.log(pc.dim('No references.'));
    for (const r of refs) {
      console.log(
        `${r.id}  ${r.kind.padEnd(6)} ${pc.dim(truncate(r.label ?? r.sourceRunId ?? '', 60))}`
      );
    }
    return;
  }

  if (sub === 'add') {
    const nodeId = positionals[1];
    const imagePath = options['--image'];
    const runId = options['--run'];
    if (!nodeId || (imagePath ? 0 : 1) === (runId ? 0 : 1)) {
      throw new Error('usage: gaido ref add <coderId> (--image <path> | --run <r_id>)');
    }
    if (imagePath) {
      const abs = path.resolve(cwd, imagePath);
      const ext = path.extname(abs).toLowerCase();
      const mime = MIME_BY_EXT[ext];
      if (!mime) throw new Error(`unsupported image type '${ext}' (want: ${Object.keys(MIME_BY_EXT).join(', ')})`);
      const dataBase64 = fs.readFileSync(abs).toString('base64');
      const row = await client.references.attachImage.mutate({
        nodeId,
        filename: path.basename(abs),
        mime,
        dataBase64,
      });
      if (flags.has('--json')) return printJson(row);
      console.log(`${pc.green('✓')} image attached to ${pc.bold(nodeId)} as ${row?.id}`);
    } else {
      const row = await client.references.attachRun.mutate({ nodeId, runId: runId! });
      if (flags.has('--json')) return printJson(row);
      console.log(`${pc.green('✓')} run ${runId} attached to ${pc.bold(nodeId)} as ${row?.id}`);
    }
    console.log(pc.dim('Materializes into the worktree on the node\'s next fresh run.'));
    return;
  }

  if (sub === 'rm') {
    const referenceId = positionals[1];
    if (!referenceId) throw new Error('usage: gaido ref rm <referenceId>');
    await client.references.remove.mutate({ referenceId });
    if (flags.has('--json')) return printJson({ referenceId, removed: true });
    console.log(`${pc.green('✓')} reference ${referenceId} removed`);
    return;
  }

  throw new Error(
    `unknown ref subcommand: ${sub ?? '(none)'} (try: list <coderId>, add <coderId> --image|--run …, rm <refId>)`
  );
}
