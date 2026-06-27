import { createInterface } from 'node:readline/promises';
import {
  publishCanvas,
  unpublishCanvas,
  type PublishOptions,
} from '@vadimlobanov/gaido-server/publish';
import pc from 'picocolors';
import { buildFrameworkAlias } from './serve.js';

interface ParsedArgs {
  canvas?: string;
  all: boolean;
  out?: string;
  upload: boolean;
  yes: boolean;
  siteUrl?: string;
  viewerDist?: string;
}

function parseArgs(args: string[]): ParsedArgs {
  const out: ParsedArgs = { all: false, upload: true, yes: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => {
      const v = args[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--all') out.all = true;
    else if (a === '--no-upload') out.upload = false;
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--out') out.out = next();
    else if (a === '--site-url') out.siteUrl = next();
    else if (a === '--viewer-dist') out.viewerDist = next();
    else if (a && a.startsWith('-')) throw new Error(`unknown flag: ${a}`);
    else if (a) out.canvas = a;
  }
  return out;
}

export async function runPublish(cwd: string, argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  const confirm: PublishOptions['confirm'] = async ({ willPublishSource, canvases }) => {
    if (args.yes) return true;
    const target =
      canvases.length === 1 ? `canvas ${pc.cyan(canvases[0] ?? '')}` : `${canvases.length} canvases`;
    console.log(`\nPublish ${target}${args.upload ? '' : pc.dim(' (build only, no upload)')}.`);
    if (willPublishSource && args.upload) {
      console.log(
        pc.yellow("  ⚠ livePreviews is on — this publishes each run's SOURCE CODE publicly.")
      );
    }
    if (!process.stdin.isTTY) {
      console.log(pc.dim('  Non-interactive — pass --yes to proceed.'));
      return false;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const ans = (await rl.question('  Proceed? [y/N] ')).trim().toLowerCase();
      return ans === 'y' || ans === 'yes';
    } finally {
      rl.close();
    }
  };

  const result = await publishCanvas({
    cwd,
    canvas: args.canvas,
    all: args.all,
    upload: args.upload,
    outDir: args.out ?? null,
    siteUrlOverride: args.siteUrl ?? null,
    viewerDist: args.viewerDist,
    frameworkAlias: buildFrameworkAlias(),
    confirm,
    log: (m) => console.log(pc.dim(m)),
  });

  if (result.aborted) {
    console.log(pc.dim('\nAborted.'));
    return;
  }

  console.log('');
  for (const c of result.canvases) {
    const size = `${(c.bytes / 1024).toFixed(0)} KB`;
    console.log(
      `${pc.green('✓')} ${pc.bold(c.publishSlug)} ${pc.dim(`— ${c.entries} objects, ${size}`)}` +
        `${c.uploaded ? '' : pc.dim(' (not uploaded)')}`
    );
    console.log(`  ${pc.cyan(c.url)}`);
  }
  if (args.out) console.log(pc.dim(`\nBundle written to ${args.out}`));
}

export async function runUnpublish(cwd: string, argv: string[]): Promise<void> {
  let canvas: string | undefined;
  let all = false;
  let yes = false;
  for (const a of argv) {
    if (a === '--all') all = true;
    else if (a === '--yes' || a === '-y') yes = true;
    else if (a.startsWith('-')) throw new Error(`unknown flag: ${a}`);
    else canvas = a;
  }
  if (!all && !canvas) throw new Error('Specify a canvas to unpublish, or --all.');

  if (!yes) {
    const what = all ? 'ALL published canvases' : `canvas ${pc.cyan(canvas ?? '')}`;
    console.log(`\nUnpublish ${what} — deletes their pages + media from R2.`);
    if (!process.stdin.isTTY) {
      console.log(pc.dim('  Non-interactive — pass --yes to proceed.'));
      return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const ans = (await rl.question('  Proceed? [y/N] ')).trim().toLowerCase();
      if (ans !== 'y' && ans !== 'yes') {
        console.log(pc.dim('Aborted.'));
        return;
      }
    } finally {
      rl.close();
    }
  }

  const result = await unpublishCanvas({
    cwd,
    canvas,
    all,
    frameworkAlias: buildFrameworkAlias(),
    log: (m) => console.log(pc.dim(m)),
  });
  console.log('');
  for (const r of result.removed) {
    console.log(`${pc.green('✓')} ${pc.bold(r.publishSlug)} ${pc.dim(`— removed ${r.objects} objects`)}`);
  }
  if (!result.removed.length) console.log(pc.dim('Nothing to unpublish.'));
}
