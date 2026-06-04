import path from 'node:path';

export interface Paths {
  projectDir: string;
  configFile: string;
  dbFile: string;
  runsDir: string;
  artifactsDir: string;
  logsDir: string;
  /** Project-local skeleton presets. Folders inside are named skeletons. */
  projectSkeletonsDir: string;
  lessonsFile: string;
  migrationsDir: string;
  /**
   * Artist-provided reference bytes (images + cached run snapshots). Lives
   * under runs/ so it rides the same gitignore as artifacts. Two children:
   * `uploads/` (pasted/dropped images) and `cache/run-<runId>/` (a run's
   * extracted code + keyframes, materialized into worktrees on demand).
   */
  referencesDir: string;
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
    // Per-run technical logs: events.ndjson (mirror of the event bus) plus
    // raw subprocess stdout/stderr from adapters. Sibling to artifacts so
    // both ride under runs/'s gitignore.
    logsDir: path.join(runsDir, '.logs'),
    projectSkeletonsDir: path.join(projectDir, 'skeletons'),
    // Project-wide rules promoted from critiques (or added manually by the
    // artist). Read by the orchestrator and prepended to coder instructions
    // on fresh sessions. File is created lazily on first promotion.
    lessonsFile: path.join(projectDir, 'LESSONS.md'),
    migrationsDir,
    referencesDir: path.join(runsDir, '.references'),
  };
}
