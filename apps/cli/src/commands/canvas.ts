import pc from 'picocolors';
import { connect, parseArgv, printJson, resolveCanvas } from '../client.js';

/**
 * Canvas management (the list lives on `gaido canvases`):
 *
 *   gaido canvas create ["<name>"]         new canvas (unnamed → "untitled-N")
 *   gaido canvas rename <slugOrId> "<name>"
 */
export async function runCanvas(cwd: string, argv: string[]): Promise<void> {
  const { positionals, flags, options } = parseArgv(argv, {
    flags: ['--json'],
    options: { '--url': [] },
  });
  const sub = positionals[0];
  const { client } = await connect(cwd, options['--url']);

  if (sub === 'create') {
    const name = positionals.slice(1).join(' ').trim() || undefined;
    const canvas = await client.canvases.create.mutate({ name });
    if (flags.has('--json')) return printJson(canvas);
    console.log(
      `${pc.green('✓')} canvas ${pc.cyan(canvas.slug)} ${pc.dim(`(${canvas.id})`)}` +
        (canvas.name ? ` — ${canvas.name}` : '')
    );
    return;
  }

  if (sub === 'rename') {
    const ref = positionals[1];
    const name = positionals.slice(2).join(' ').trim();
    if (!ref || !name) {
      throw new Error('usage: gaido canvas rename <slugOrId> "<new name>"');
    }
    const target = await resolveCanvas(client, ref);
    const canvas = await client.canvases.rename.mutate({ id: target!.id, name });
    if (flags.has('--json')) return printJson(canvas);
    console.log(`${pc.green('✓')} ${pc.cyan(canvas.slug)} renamed to "${canvas.name}"`);
    return;
  }

  throw new Error(
    `unknown canvas subcommand: ${sub ?? '(none)'} (try: create ["name"], rename <slugOrId> "name"; list with \`gaido canvases\`)`
  );
}
