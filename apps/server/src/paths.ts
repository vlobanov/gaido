import path from 'node:path';

export interface Paths {
  projectDir: string;
  configFile: string;
  dbFile: string;
  runsDir: string;
  skeletonDir: string;
  migrationsDir: string;
}

export function resolvePaths(cwd: string = process.cwd()): Paths {
  const projectDir = path.resolve(cwd);
  // The migrations dir lives in this package, not the user project. Resolve
  // it relative to this file so it works regardless of cwd.
  const here = path.dirname(new URL(import.meta.url).pathname);
  const migrationsDir = path.resolve(here, '..', 'migrations');
  return {
    projectDir,
    configFile: path.join(projectDir, 'gaido.config.ts'),
    dbFile: path.join(projectDir, 'gaido.db'),
    runsDir: path.join(projectDir, 'runs'),
    skeletonDir: path.join(projectDir, 'skeleton'),
    migrationsDir,
  };
}
