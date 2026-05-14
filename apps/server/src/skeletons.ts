import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface SkeletonEntry {
  name: string;
  source: 'project' | 'global';
  path: string;
}

export interface SkeletonsOpts {
  projectDir: string;
  /** Override for tests. Defaults to `~/.gaido/skeletons`. */
  globalDir?: string;
}

export function defaultGlobalSkeletonsDir(): string {
  return path.join(os.homedir(), '.gaido', 'skeletons');
}

/**
 * Enumerate skeleton presets. Project entries shadow global on name
 * collision. Hidden dirs (dot-prefix) are ignored.
 */
export function listSkeletons(opts: SkeletonsOpts): SkeletonEntry[] {
  const projectDir = path.join(opts.projectDir, 'skeletons');
  const globalDir = opts.globalDir ?? defaultGlobalSkeletonsDir();
  const seen = new Set<string>();
  const out: SkeletonEntry[] = [];

  for (const [dir, source] of [
    [projectDir, 'project'] as const,
    [globalDir, 'global'] as const,
  ]) {
    if (!fs.existsSync(dir)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      out.push({ name: entry.name, source, path: path.join(dir, entry.name) });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Resolve a skeleton name to an absolute directory path. `null` collapses to
 * `'default'`. Returns null if no skeleton with that name exists in either
 * the project or global location.
 */
export function resolveSkeleton(
  name: string | null,
  opts: SkeletonsOpts
): string | null {
  const target = name ?? 'default';
  return listSkeletons(opts).find((s) => s.name === target)?.path ?? null;
}
