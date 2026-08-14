import pc from 'picocolors';
import { connect, parseArgv, printJson } from '../client.js';

/**
 * `gaido lessons` — print LESSONS.md. `gaido lessons add "<rule>"` — promote
 * a rule through the server's dedup (same normalization the UI's [Promote]
 * button uses), so an external feedback-generalization pass lands rules
 * without re-implementing the matching.
 */
export async function runLessons(cwd: string, argv: string[]): Promise<void> {
  const { positionals, flags, options } = parseArgv(argv, {
    flags: ['--json'],
    options: { '--url': [] },
  });

  const { client } = await connect(cwd, options['--url']);

  if (positionals[0] === 'add') {
    const rule = positionals.slice(1).join(' ').trim();
    if (!rule) throw new Error('usage: gaido lessons add "<rule>"');
    const result = await client.lessons.promote.mutate({ rule });
    if (flags.has('--json')) return printJson(result);
    console.log(
      result.added
        ? `${pc.green('✓')} added: ${rule}`
        : pc.dim(`= already in rules: ${rule}`)
    );
    return;
  }
  if (positionals.length > 0) {
    throw new Error(`unknown lessons subcommand: ${positionals[0]} (try: gaido lessons add "<rule>")`);
  }

  const { contents } = await client.lessons.get.query();
  if (flags.has('--json')) return printJson({ contents });
  if (!contents) {
    console.log(pc.dim('No LESSONS.md yet — add the first rule with: gaido lessons add "<rule>"'));
    return;
  }
  process.stdout.write(contents.endsWith('\n') ? contents : `${contents}\n`);
}
