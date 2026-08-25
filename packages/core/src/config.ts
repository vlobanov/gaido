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
 * Built-in per-run static preview server. Enabled by default: gaido serves
 * each run's committed code over HTTP at
 * `http://<runId>.<canvasSlug>.localhost:<port>/`, so the artist can open the
 * live, interactive page for any run straight from the graph — no project dev
 * server required. The page is served from a `git archive` of the run's commit
 * (immutable, decoupled from the worktree), materialized lazily on first
 * request and cached under `runs/.previews/`.
 *
 * Each run gets its own subdomain origin so root-absolute asset URLs
 * (`/assets/app.js`) resolve correctly. `*.localhost` resolves to loopback in
 * Chrome and Firefox out of the box; Safari / the macOS system resolver may
 * need an `/etc/hosts` entry.
 *
 * Process-global (one server, bound once at startup) like `server` and
 * `concurrency`: set it in `gaido.config.ts`, never in a skeleton overlay.
 */
export interface StaticPreviewConfig {
  /** Turn the built-in preview server off entirely. Default: enabled. */
  disabled?: boolean;
  /**
   * Port the preview server binds on 127.0.0.1. Default: the main server port
   * + 1 (4289 alongside the default 4288). Must differ from `server.port`.
   */
  port?: number;
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

/**
 * Static publishing target (`gaido publish`). Process-global like `server` /
 * `staticPreview` — set it in gaido.config.ts, never in a skeleton overlay.
 * Everything (pages, the viewer bundle, media, live previews) is served from
 * the single `siteUrl` origin; R2 object keys mirror the URL paths. See
 * `docs/publishing.md`.
 */
export interface PublishConfig {
  /**
   * The one origin that serves published canvases — pages at `/<slug>`, the
   * viewer bundle at `/assets/*`, media at `/<slug>/artifacts/*`, and live
   * previews at `/p/<sha>/*`. No trailing slash, e.g. 'https://graphs.gaido.ai'.
   */
  siteUrl: string;
  /** Cloudflare R2 bucket the bundle uploads to (S3 API). Creds belong in env. */
  r2: {
    accountId: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    /**
     * Override the S3 endpoint. Defaults to
     * `https://<accountId>.r2.cloudflarestorage.com`. Set this to target any
     * S3-compatible store (e.g. a local MinIO at `http://127.0.0.1:9000`);
     * `accountId` is then unused.
     */
    endpoint?: string;
    /** SigV4 signing region. Default `'auto'` (R2). MinIO often wants `'us-east-1'`. */
    region?: string;
  };
  /** What rides the published snapshot. */
  include?: {
    /**
     * Archive + publish each run's committed source so its live preview works
     * on the published site. **Publishes source code.** Default false.
     */
    livePreviews?: boolean;
    /** Bake the (filtered) event timeline into the snapshot. Default false. */
    events?: boolean;
    /** Publish node instructions (the artist's prompts). Default true. */
    instructions?: boolean;
    /** Publish LESSONS.md project rules. Default true. */
    rules?: boolean;
  };
  /** Extra redaction beyond the always-stripped fields (sessions, paths, cost…). */
  redact?: {
    /** Strip the artist's reply-thread text. Default true. */
    artistFollowUp?: boolean;
  };
  /** Map a canvas to its public URL slug. Default: the canvas's own slug. */
  slug?: (canvas: { id: string; slug: string; name: string | null }) => string;
  /**
   * Append `/index.html` to the extensionless URLs (the canvas page and the
   * live-preview links). Set this when serving straight from R2 with **no
   * Worker / URL-rewrite rule** — R2 has no directory-index, so `/p/<sha>/`
   * 404s while `/p/<sha>/index.html` (an exact object key) resolves. Default
   * false (clean URLs, assuming the Worker or a rewrite rule supplies the
   * index.html fallback).
   */
  indexHtmlUrls?: boolean;
}

/**
 * One project-declared branch-metadata field. Branch metadata is a small set
 * of typed key/values shared by every coder on a branch — "what this branch
 * *is* outside gaido": the template name/code it was published under, a
 * ticket id, a client's approval flag. Declaring the fields here is what lets
 * the card render them (`card: true`), the sidebar offer a form, and
 * `nodes.setMeta` / `gaido meta` reject typos. Values are stored once on the
 * branch anchor and inherited by Continue; a Fork starts with none. See
 * "Branch metadata" in docs/graph-model.md.
 */
export interface MetaField {
  /** Key used in `setMeta` / `gaido meta key=value`. Dotted names are fine: 'template.code'. */
  key: string;
  /** Display label on the card / in the sidebar. Defaults to `key`. */
  label?: string;
  /** Value type. `url` is a string that must parse as an absolute URL (rendered as a link). */
  type: 'string' | 'boolean' | 'number' | 'url';
  /** Show this field in the coder card's meta strip (booleans show only when true). Default false. */
  card?: boolean;
  /** Strip this field from `gaido publish` snapshots (admin links, internal ids). Default false. */
  private?: boolean;
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
  staticPreview?: StaticPreviewConfig;
  publish?: PublishConfig;
  /**
   * Branch-metadata schema (see {@link MetaField}). Omit it and `setMeta`
   * accepts free-form scalar keys (nothing renders on cards — the sidebar
   * lists whatever is set). Project-level: the schema is what `gaido meta`
   * validates against regardless of skeleton, so it's rejected in skeleton
   * overlays like the process-global fields.
   */
  meta?: MetaField[];
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
 * `server`, `concurrency`, `staticPreview`, and `publish` are process-global
 * (bound once at startup / a deployment decision), and `meta` is project-level
 * (one schema for `gaido meta` across every branch), so they cannot be set
 * per-skeleton: they're omitted from the type here and rejected at load time.
 */
export type SkeletonConfigLayer = Partial<
  Omit<GaidoConfig, 'server' | 'concurrency' | 'staticPreview' | 'publish' | 'meta'>
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
