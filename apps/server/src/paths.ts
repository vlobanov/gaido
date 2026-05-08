import path from 'node:path';

export interface Paths {
  projectDir: string;
  configFile: string;
  dbFile: string;
  runsDir: string;
  artifactsDir: string;
  skeletonDir: string;
  migrationsDir: string;
}

export function resolvePaths(cwd: string = process.cwd()): Paths {
  const projectDir = path.resolve(cwd);
  // The migrations dir lives in this package, not the user project. Resolve
  // it relative to this file so it works regardless of cwd.
  const here = path.dirname(new URL(import.meta.url).pathname);
  const migrationsDir = path.resolve(here, '..', 'migrations');
  const runsDir = path.join(projectDir, 'runs');
  return {
    projectDir,
    configFile: path.join(projectDir, 'gaido.config.ts'),
    dbFile: path.join(projectDir, 'gaido.db'),
    runsDir,
    // Render outputs land here, keyed by runId. Lives under runs/ so both
    // worktrees (versioned source) and artifacts (binary outputs) share a
    // single .gitignore'd top-level dir.
    artifactsDir: path.join(runsDir, '.artifacts'),
    skeletonDir: path.join(projectDir, 'skeleton'),
    migrationsDir,
  };
}
