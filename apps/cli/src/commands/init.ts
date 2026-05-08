import { writeFile, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import pc from 'picocolors';
import {
  gaidoConfigTemplate,
  envExampleTemplate,
  gitignoreTemplate,
  skeletonIndexHtmlTemplate,
  skeletonClaudeMdTemplate,
} from '../templates.js';

interface FileSpec {
  path: string;
  content: string;
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

export async function runInit(cwd: string): Promise<void> {
  const files: FileSpec[] = [
    { path: 'gaido.config.ts', content: gaidoConfigTemplate },
    { path: '.env.example', content: envExampleTemplate },
    { path: '.gitignore', content: gitignoreTemplate },
    { path: 'skeleton/index.html', content: skeletonIndexHtmlTemplate },
    { path: 'skeleton/CLAUDE.md', content: skeletonClaudeMdTemplate },
  ];

  console.log(pc.bold(`\nInitializing Gaido project in ${cwd}\n`));

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
  console.log(`  ${pc.cyan('2.')} ${pc.dim('cp .env.example .env')} and fill in API keys when you wire up real adapters.`);
  console.log(`  ${pc.cyan('3.')} Run ${pc.bold('gaido')} to start the server and open the UI.\n`);
}
