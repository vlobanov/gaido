import pc from 'picocolors';
import { connect, parseArgv, printJson } from '../client.js';

/**
 * Margin notes on nodes — provenance/status the artist should see on the
 * card, e.g. `gaido note n_… "published as hero-loop on videoeffects.com"`.
 *
 *   gaido note <nodeId>            print the current note
 *   gaido note <nodeId> "<text>"   set it (overwrites)
 *   gaido note <nodeId> --clear    remove it
 */
export async function runNote(cwd: string, argv: string[]): Promise<void> {
  const { positionals, flags, options } = parseArgv(argv, {
    flags: ['--json', '--clear'],
    options: { '--url': [] },
  });
  const nodeId = positionals[0];
  if (!nodeId) {
    throw new Error('usage: gaido note <nodeId> ["<text>" | --clear]');
  }
  const text = positionals.slice(1).join(' ').trim();
  if (flags.has('--clear') && text) {
    throw new Error('pass either note text or --clear, not both');
  }

  const { client } = await connect(cwd, options['--url']);

  if (!flags.has('--clear') && !text) {
    const { node } = await client.nodes.get.query({ nodeId });
    if (flags.has('--json')) return printJson({ nodeId: node.id, note: node.note });
    console.log(node.note ?? pc.dim('(no note)'));
    return;
  }

  const node = await client.nodes.setNote.mutate({
    nodeId,
    note: flags.has('--clear') ? null : text,
  });
  if (flags.has('--json')) return printJson({ nodeId: node.id, note: node.note });
  console.log(
    node.note
      ? `${pc.green('✓')} note on ${pc.bold(node.id)}: ${node.note}`
      : `${pc.green('✓')} note cleared on ${pc.bold(node.id)}`
  );
}
