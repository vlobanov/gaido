import fs from 'node:fs';
import { createJiti } from 'jiti';
import type { SkeletonConfig } from '@gaido/core';
import {
  resolveSkeleton,
  findSkeletonConfigFile,
  type SkeletonsOpts,
} from './skeletons.js';

interface CacheEntry {
  mtimeMs: number;
  value: SkeletonConfig;
}

// Keyed by absolute file path. Re-loads when the file's mtime changes so an
// artist can edit `gaido.skeleton.ts` and have the next run pick it up without
// restarting the server (the project config, by contrast, is loaded once at
// boot — skeleton overlays are meant to evolve live).
const cache = new Map<string, CacheEntry>();

/**
 * Load a skeleton's config overlay from
 * `skeletons/<name>/gaido.skeleton.{ts,mjs,js}`. Returns null when the skeleton
 * has no overlay file (or the skeleton name doesn't resolve to a directory) —
 * the common case, where the project config applies unchanged.
 *
 * Throws if the overlay sets `server` or `concurrency` (top-level or under
 * `extend`): those are process-global, bound once at startup, so a per-skeleton
 * value would be a silent no-op. The `SkeletonConfig` type already forbids them
 * in TS authoring; this guards the JS / type-cast escape hatch by failing loud.
 */
export async function loadSkeletonConfig(
  skeletonName: string,
  opts: SkeletonsOpts & {
    /** Same alias map as `LoadConfigOptions.frameworkAlias` — overlay files
     * import `defineSkeleton` from 'gaido' and need it resolvable outside
     * the monorepo. */
    frameworkAlias?: Record<string, string>;
  }
): Promise<SkeletonConfig | null> {
  const dir = resolveSkeleton(skeletonName, opts);
  if (!dir) return null;
  const file = findSkeletonConfigFile(dir);
  if (!file) return null;

  const mtimeMs = fs.statSync(file).mtimeMs;
  const cached = cache.get(file);
  if (cached && cached.mtimeMs === mtimeMs) return cached.value;

  // Fresh instance with caches disabled so an edited file is re-read and
  // re-transpiled rather than served from jiti's module/source cache.
  const jiti = createJiti(import.meta.url, {
    interopDefault: true,
    moduleCache: false,
    fsCache: false,
    ...(opts.frameworkAlias ? { alias: opts.frameworkAlias } : {}),
  });
  const mod = (await jiti.import(file)) as
    | SkeletonConfig
    | { default: SkeletonConfig };
  const value: SkeletonConfig =
    'default' in mod && typeof mod.default === 'object' && mod.default !== null
      ? (mod.default as SkeletonConfig)
      : (mod as SkeletonConfig);

  assertNoProcessGlobalFields(value, file);
  cache.set(file, { mtimeMs, value });
  return value;
}

function assertNoProcessGlobalFields(cfg: SkeletonConfig, file: string): void {
  const forbidden: string[] = [];
  const scan = (obj: Record<string, unknown> | undefined, prefix: string) => {
    if (!obj) return;
    if (obj.server !== undefined) forbidden.push(`${prefix}server`);
    if (obj.concurrency !== undefined) forbidden.push(`${prefix}concurrency`);
  };
  scan(cfg as Record<string, unknown>, '');
  scan(cfg.extend as Record<string, unknown> | undefined, 'extend.');
  if (forbidden.length > 0) {
    throw new Error(
      `[gaido] ${file}: ${forbidden.join(', ')} cannot be set in a skeleton ` +
        `config — server and concurrency are process-global; set them in ` +
        `gaido.config.ts instead.`
    );
  }
}
