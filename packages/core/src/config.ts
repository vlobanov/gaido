import type { Coder, Critic, Renderer } from './adapters.js';

/**
 * Long-lived dev server the project provides for previewing renders and (for
 * adapters like the browser-record renderer) hosting the page Playwright
 * drives. Gaido spawns this on startup, waits for it to be ready, and shuts
 * it down on exit. Optional — projects without parameter-driven previews can
 * omit it.
 */
export interface PreviewServerConfig {
  /** Command + args, e.g. ['pnpm', 'exec', 'serve']. */
  command: string[];
  /** Port the server binds to. Must match what `command` actually uses. */
  port: number;
  /** Path probed for readiness (GET, expects 2xx). Default '/'. */
  ready?: string;
  /** Subprocess cwd. Default: project root. */
  cwd?: string;
  /**
   * Build the per-run URL the artist's browser opens (the "Open live preview"
   * link in the UI). Use this when gaido is fronted by a tunnel/reverse proxy
   * and the artist-facing URL differs from `http://127.0.0.1:<port>`, or when
   * you want the path/query to differ from what Playwright records against.
   * The renderer still hits localhost server-side. When omitted, the URL the
   * renderer returns is persisted as-is.
   */
  publicUrl?: (args: { runId: string; nodeId: string }) => string;
  /**
   * If set, gaido exports this env var to the subprocess pointing at the
   * shared artifacts dir (where per-run scene.json / metaparams.json live).
   * Example: 'VE_ANIMATOR_OUT_DIR'.
   */
  outDirEnv?: string;
  /** Additional env vars to pass through. */
  env?: Record<string, string>;
}

/**
 * A shell check run after the coder phase. Failure feeds combined stdout +
 * stderr back to the coder as the next message in the resumed session, up
 * to `checkMaxRetries` attempts.
 */
export interface PostCoderCheck {
  /** Display label, surfaced in events and errors. */
  name: string;
  /** Command + args. */
  command: string[];
  /**
   * Working directory. 'workdir' = the node's worktree (default); 'project' =
   * the project root.
   */
  cwd?: 'workdir' | 'project';
}

export interface GaidoConfig {
  name?: string;
  description?: string;
  /**
   * The project's coder. Either set this (single coder), or `coders` (named
   * variants), or both — when both are set, `coder` registers under the name
   * `"default"` unless `coders` already defines that key. At least one of the
   * two must be present. See {@link resolveCoderRegistry}.
   */
  coder?: Coder;
  /**
   * Named coder variants, selectable per root node in the seed picker and
   * switchable mid-graph via a config node. Keys are the names shown in the
   * UI (e.g. `"cc-sonnet"`, `"cc-opus-48"`). A key named `"default"` is the
   * implicit fallback; otherwise the first declared entry is the default.
   */
  coders?: Record<string, Coder>;
  critic: Critic;
  renderer: Renderer;
  previewServer?: PreviewServerConfig;
  postCoderChecks?: PostCoderCheck[];
  /** Max coder attempts per run when post-coder checks fail. Default 3. */
  checkMaxRetries?: number;
  concurrency?: {
    agents?: number;
    renderers?: number;
  };
  render?: {
    width?: number;
    height?: number;
    fps?: number;
    duration?: number;
  };
  server?: {
    port?: number;
    openBrowser?: boolean;
  };
}

export function defineConfig(config: GaidoConfig): GaidoConfig {
  return config;
}

export interface CoderRegistry {
  /** name → coder, in declaration order. Always non-empty. */
  coders: Map<string, Coder>;
  /** Name used when a node names no coder (or names one no longer defined). */
  defaultName: string;
}

/**
 * Normalize a config's `coder` / `coders` into a flat registry. `coder`
 * registers under `"default"` unless `coders` already defines that key. The
 * default selection is `"default"` when present, else the first declared
 * coder. Throws when neither field is set. Used by the config loader and by
 * skeleton-overlay resolution, so the same precedence applies everywhere.
 */
export function resolveCoderRegistry(
  cfg: Pick<GaidoConfig, 'coder' | 'coders'>
): CoderRegistry {
  const coders = new Map<string, Coder>();
  if (cfg.coders) {
    for (const [name, coder] of Object.entries(cfg.coders)) {
      coders.set(name, coder);
    }
  }
  if (cfg.coder && !coders.has('default')) {
    coders.set('default', cfg.coder);
  }
  if (coders.size === 0) {
    throw new Error(
      'gaido.config.ts defines no coder — set `coder`, or at least one entry in `coders`.'
    );
  }
  const defaultName = coders.has('default')
    ? 'default'
    : (coders.keys().next().value as string);
  return { coders, defaultName };
}

/**
 * Per-skeleton config overlay — a partial GaidoConfig that layers on top of
 * the project config for every node that uses the skeleton (the root that
 * picked it and its whole fork lineage). Dropped at
 * `skeletons/<name>/gaido.skeleton.ts`, read live by the orchestrator on each
 * run, and never committed into a worktree (so it stays out of the art diff).
 *
 * Merge is Tailwind-style (see {@link applySkeletonOverlay}): a top-level
 * field REPLACES the project value; a field under `extend` MERGES into it —
 * the `postCoderChecks` array appends, `render` shallow-merges key-by-key.
 *
 * `server` and `concurrency` are process-global (bound once at startup), so
 * they cannot be set per-skeleton: they're omitted from the type here and
 * rejected at load time.
 */
export type SkeletonConfigLayer = Partial<
  Omit<GaidoConfig, 'server' | 'concurrency'>
>;

export interface SkeletonConfig extends SkeletonConfigLayer {
  /**
   * Fields here MERGE into the project config instead of replacing it —
   * `postCoderChecks` appends after the project's checks, `render`
   * shallow-merges so you can set just `width` and keep the rest.
   */
  extend?: SkeletonConfigLayer;
}

export function defineSkeleton(config: SkeletonConfig): SkeletonConfig {
  return config;
}

/** `extend` keys whose array value is appended onto the base array. */
const SKELETON_EXTEND_APPEND_KEYS: readonly string[] = ['postCoderChecks'];
/** `extend` keys whose object value shallow-merges (key-by-key) onto the base. */
const SKELETON_EXTEND_MERGE_KEYS: readonly string[] = ['render'];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Merge a skeleton overlay onto a base config, Tailwind-style. Pure — returns
 * a new object and mutates nothing. Top-level overlay fields replace the
 * base's (`theme`); `extend` fields merge into it (`theme.extend`): arrays
 * append, `render` shallow-merges, anything else replaces. The result is still
 * a raw GaidoConfig — run it through the server's `mergeWithDefaults` to fill
 * any omitted fields from defaults.
 */
export function applySkeletonOverlay(
  base: GaidoConfig,
  overlay: SkeletonConfig
): GaidoConfig {
  const { extend, ...top } = overlay;
  const out = { ...base } as Record<string, unknown>;

  // Top-level fields replace the project value wholesale.
  for (const [key, value] of Object.entries(top)) {
    if (value !== undefined) out[key] = value;
  }

  // `extend` fields merge into whatever the base/top-level left in place.
  if (extend) {
    for (const [key, value] of Object.entries(extend)) {
      if (value === undefined) continue;
      const current = out[key];
      if (SKELETON_EXTEND_APPEND_KEYS.includes(key) && Array.isArray(value)) {
        out[key] = [...(Array.isArray(current) ? current : []), ...value];
      } else if (
        SKELETON_EXTEND_MERGE_KEYS.includes(key) &&
        isPlainObject(value)
      ) {
        out[key] = { ...(isPlainObject(current) ? current : {}), ...value };
      } else {
        out[key] = value;
      }
    }
  }

  return out as unknown as GaidoConfig;
}

export const defaults = {
  concurrency: { agents: 8, renderers: 2 },
  render: { width: 1024, height: 1024, fps: 30, duration: 5 },
  server: { port: 4288, openBrowser: true },
  checkMaxRetries: 3,
} as const;
