import pc from 'picocolors';
import { connect, parseArgv, printJson } from '../client.js';

/**
 * `gaido skeleton list` — enumerate skeleton presets (project + global).
 * `gaido skeleton reseed <name>` — commit the skeleton dir's current contents
 * as a new tip on `seed/<name>`, so roots created from now on pick up edits.
 * Existing lineages are untouched (branch history is theirs); propagate a
 * skeleton change into live branches with the external-edit flow instead.
 */
export async function runSkeleton(cwd: string, argv: string[]): Promise<void> {
  const { positionals, flags, options } = parseArgv(argv, {
    flags: ['--json'],
    options: { '--url': [] },
  });
  const sub = positionals[0] ?? 'list';

  const { client } = await connect(cwd, options['--url']);

  if (sub === 'list') {
    const skeletons = await client.skeletons.list.query();
    if (flags.has('--json')) return printJson(skeletons);
    for (const s of skeletons) {
      console.log(`${pc.cyan(s.name.padEnd(16))} ${pc.dim(`${s.source} · ${s.path}`)}`);
    }
    return;
  }

  if (sub === 'reseed') {
    const name = positionals[1];
    if (!name) throw new Error('usage: gaido skeleton reseed <name>');
    const result = await client.skeletons.reseed.mutate({ name });
    if (flags.has('--json')) return printJson(result);
    if (result.created) {
      console.log(`${pc.green('✓')} seed/${name} created at ${result.sha}`);
    } else if (result.changed) {
      console.log(`${pc.green('✓')} seed/${name} reseeded → ${result.sha}`);
      console.log(pc.dim('  Only NEW roots pick this up; existing branches keep their history.'));
    } else {
      console.log(pc.dim(`= seed/${name} already matches skeletons/${name}/ — nothing to commit`));
    }
    return;
  }

  throw new Error(`unknown skeleton subcommand: ${sub} (try: list, reseed <name>)`);
}
