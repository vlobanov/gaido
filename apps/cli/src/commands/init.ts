import { writeFile, mkdir, access, lstat, readlink, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import pc from 'picocolors';
import {
  gaidoConfigTemplate,
  envExampleTemplate,
  gitignoreTemplate,
  skeletonCatalog,
} from '../templates.js';

interface FileSpec {
  path: string;
  content: string;
}

export interface InitOptions {}

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

export async function runInit(cwd: string, _options: InitOptions = {}): Promise<void> {
  const skeletonFiles: FileSpec[] = Object.entries(skeletonCatalog).flatMap(
    ([name, tpl]) =>
      Object.entries(tpl.files).map(([file, content]) => ({
        path: `skeletons/${name}/${file}`,
        content,
      }))
  );

  const files: FileSpec[] = [
    { path: 'gaido.config.ts', content: gaidoConfigTemplate },
    { path: '.env.example', content: envExampleTemplate },
    { path: '.gitignore', content: gitignoreTemplate },
    ...skeletonFiles,
  ];

  console.log(pc.bold(`\nInitializing Gaido project in ${cwd}\n`));
  console.log(
    `  ${pc.dim('skeletons:')} ${Object.keys(skeletonCatalog)
      .map((n) => pc.cyan(n))
      .join(', ')}\n`
  );

  for (const file of files) {
    const result = await writeIfMissing(file, cwd);
    if (result === 'wrote') {
      console.log(`  ${pc.green('+')} ${file.path}`);
    } else {
      console.log(`  ${pc.dim('=')} ${pc.dim(`${file.path} (already exists, skipped)`)}`);
    }
  }

  await maybeSymlinkSkill(cwd);

  console.log(`\n${pc.bold('Next:')}\n`);
  console.log(`  ${pc.cyan('1.')} Add ${pc.bold('gaido')} as a dependency in your project's package.json,`);
  console.log(`     or run this CLI from a directory inside the gaido monorepo.`);
  console.log(`  ${pc.cyan('2.')} ${pc.dim('cp .env.example .env')} and fill in OPENROUTER_API_KEY (used by the critic).`);
  console.log(`  ${pc.cyan('3.')} Run ${pc.bold('gaido')} to start the server and open the UI.\n`);

  console.log(
    `${pc.dim('Add more presets at')} ${pc.bold('./skeletons/<name>/')} ${pc.dim('(project) or')} ${pc.bold('~/.gaido/skeletons/<name>/')} ${pc.dim('(global, shared across projects).')}\n`
  );
}

const SKILL_SUGGESTIONS: ReadonlyArray<{ path: string; label: string }> = [
  { path: '.claude/skills/gaido', label: 'Claude Code' },
  { path: '.skills/gaido', label: 'Codex / generic' },
];

async function maybeSymlinkSkill(cwd: string): Promise<void> {
  const source = resolveSkillSource();
  if (!source) return;

  console.log(`\n${pc.bold('Agent skill (optional)')}`);
  console.log(
    `  ${pc.dim('Symlink the bundled SKILL.md so AI agents can read it when working in this project.')}`
  );

  if (!process.stdin.isTTY) {
    console.log(`  ${pc.dim('(Non-interactive stdin — skipping. Symlink manually if you need it.)')}`);
    return;
  }

  const suggested = SKILL_SUGGESTIONS.map(
    (s) => `${pc.cyan(s.path)} ${pc.dim(`(${s.label})`)}`
  ).join(', ');
  console.log(`  ${pc.dim('Suggestions:')} ${suggested}`);

  const defaultAnswer = SKILL_SUGGESTIONS.map((s) => s.path).join(', ');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let answer: string;
  try {
    answer = (
      await rl.question(
        `  ${pc.dim('Paths (comma-separated, blank to skip)')} [${defaultAnswer}]: `
      )
    ).trim();
  } catch {
    // stdin closed / Ctrl+D before input — treat as skip rather than crashing init.
    console.log(`  ${pc.dim('Skipped.')}`);
    return;
  } finally {
    rl.close();
  }

  // Empty input = use the suggested defaults. To skip entirely, type "no" / "skip".
  const effective = answer === '' ? defaultAnswer : answer;
  if (/^(no|skip|n)$/i.test(effective)) {
    console.log(`  ${pc.dim('Skipped.')}`);
    return;
  }

  const targets = effective
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const t of targets) {
    await createSkillSymlink(cwd, t, source);
  }
}

/**
 * Locate the gaido skill folder. Returns the absolute path or null if it's
 * not found in either the dev-tree (running from inside the monorepo) or
 * bundled-inside-cli (future npm install) layouts.
 */
function resolveSkillSource(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Dev: apps/cli/src/commands/init.ts → repo-root/skills/gaido
    resolve(here, '..', '..', '..', '..', 'skills', 'gaido'),
    // Bundled inside the CLI package: <pkg>/src/commands → <pkg>/skills/gaido
    resolve(here, '..', '..', 'skills', 'gaido'),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, 'SKILL.md'))) return c;
  }
  return null;
}

async function createSkillSymlink(
  cwd: string,
  target: string,
  source: string
): Promise<void> {
  const dest = resolve(cwd, target);
  await mkdir(dirname(dest), { recursive: true });

  try {
    const stat = await lstat(dest);
    if (stat.isSymbolicLink()) {
      const current = await readlink(dest);
      const resolved = resolve(dirname(dest), current);
      if (resolved === source) {
        console.log(`  ${pc.dim('=')} ${pc.dim(`${target} (already linked, skipped)`)}`);
        return;
      }
      console.log(
        `  ${pc.yellow('!')} ${target} ${pc.dim(`exists (points to ${resolved}), skipped`)}`
      );
      return;
    }
    console.log(`  ${pc.yellow('!')} ${target} ${pc.dim('exists (not a symlink), skipped')}`);
    return;
  } catch {
    // doesn't exist — fall through to create
  }

  await symlink(source, dest, 'dir');
  console.log(`  ${pc.green('→')} ${target} ${pc.dim(`→ ${source}`)}`);
}
