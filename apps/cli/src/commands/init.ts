import { writeFile, mkdir, access, readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import pc from 'picocolors';
import {
  gaidoConfigTemplate,
  envExampleTemplate,
  gitignoreTemplate,
  skeletonCatalog,
  DEFAULT_SKELETON,
} from '../templates.js';

interface FileSpec {
  path: string;
  content: string;
}

export interface InitOptions {
  /**
   * Either the name of a built-in skeleton (`pixi`, `css`, ...) or a path
   * (absolute, or relative to cwd) pointing at a directory whose contents
   * will be copied verbatim into `<projectDir>/skeleton/`. Defaults to
   * `pixi` when omitted.
   */
  skeleton?: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeIfMissing(file: FileSpec, cwd: string): Promise<'wrote' | 'skipped'> {
  const fullPath = join(cwd, file.path);
  if (await exists(fullPath)) return 'skipped';
  await mkdir(join(fullPath, '..'), { recursive: true });
  await writeFile(fullPath, file.content, 'utf8');
  return 'wrote';
}

async function resolveSkeletonFiles(
  source: string,
  cwd: string
): Promise<{ kind: 'builtin' | 'path'; label: string; files: FileSpec[] }> {
  // If it matches a built-in name, use that.
  if (Object.prototype.hasOwnProperty.call(skeletonCatalog, source)) {
    const tpl = skeletonCatalog[source]!;
    return {
      kind: 'builtin',
      label: source,
      files: Object.entries(tpl.files).map(([name, content]) => ({
        path: `skeleton/${name}`,
        content,
      })),
    };
  }
  // Otherwise treat it as a directory path.
  const abs = isAbsolute(source) ? source : resolve(cwd, source);
  const stats = await stat(abs).catch(() => null);
  if (!stats || !stats.isDirectory()) {
    const builtins = Object.keys(skeletonCatalog).join(', ');
    throw new Error(
      `--skeleton '${source}' is neither a built-in (${builtins}) nor an existing directory at ${abs}`
    );
  }
  const files = await collectDirFiles(abs);
  if (files.length === 0) {
    throw new Error(`--skeleton directory ${abs} is empty`);
  }
  return {
    kind: 'path',
    label: relative(cwd, abs) || abs,
    files: files.map((f) => ({
      path: `skeleton/${f.relPath}`,
      content: f.content,
    })),
  };
}

async function collectDirFiles(
  root: string,
  rel = ''
): Promise<{ relPath: string; content: string }[]> {
  const out: { relPath: string; content: string }[] = [];
  const entries = await readdir(join(root, rel), { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.DS_Store' || entry.name === 'node_modules') continue;
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...(await collectDirFiles(root, childRel)));
    } else if (entry.isFile()) {
      const content = await readFile(join(root, childRel), 'utf8');
      out.push({ relPath: childRel, content });
    }
  }
  return out;
}

export async function runInit(cwd: string, options: InitOptions = {}): Promise<void> {
  const skeletonChoice = options.skeleton ?? DEFAULT_SKELETON;
  const skeleton = await resolveSkeletonFiles(skeletonChoice, cwd);

  const files: FileSpec[] = [
    { path: 'gaido.config.ts', content: gaidoConfigTemplate },
    { path: '.env.example', content: envExampleTemplate },
    { path: '.gitignore', content: gitignoreTemplate },
    ...skeleton.files,
  ];

  console.log(pc.bold(`\nInitializing Gaido project in ${cwd}\n`));
  console.log(
    `  ${pc.dim('skeleton:')} ${skeleton.kind === 'builtin' ? pc.cyan(skeleton.label) : `${pc.cyan('path')} ${pc.dim(skeleton.label)}`}\n`
  );

  for (const file of files) {
    const result = await writeIfMissing(file, cwd);
    if (result === 'wrote') {
      console.log(`  ${pc.green('+')} ${file.path}`);
    } else {
      console.log(`  ${pc.dim('=')} ${pc.dim(`${file.path} (already exists, skipped)`)}`);
    }
  }

  console.log(`\n${pc.bold('Next:')}\n`);
  console.log(`  ${pc.cyan('1.')} Add ${pc.bold('gaido')} as a dependency in your project's package.json,`);
  console.log(`     or run this CLI from a directory inside the gaido monorepo.`);
  console.log(`  ${pc.cyan('2.')} ${pc.dim('cp .env.example .env')} and fill in OPENROUTER_API_KEY (used by the critic).`);
  console.log(`  ${pc.cyan('3.')} Run ${pc.bold('gaido')} to start the server and open the UI.\n`);

  if (skeleton.kind === 'builtin') {
    const others = Object.entries(skeletonCatalog)
      .filter(([name]) => name !== skeletonChoice)
      .map(([name, tpl]) => `${pc.cyan(name)} ${pc.dim('— ' + tpl.description)}`);
    if (others.length > 0) {
      console.log(`${pc.dim('Other built-in skeletons:')}`);
      for (const line of others) console.log(`  ${line}`);
      console.log(
        `${pc.dim('Re-run with')} ${pc.bold('gaido init --skeleton=<name>')} ${pc.dim('to pick one, or pass a directory path.')}\n`
      );
    }
  }
}
