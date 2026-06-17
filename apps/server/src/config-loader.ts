import fs from 'node:fs';
import { createJiti } from 'jiti';
import { defaults, resolveCoderRegistry } from '@vadimlobanov/gaido-core';
import type { Coder, GaidoConfig, PreviewServerConfig, PostCoderCheck } from '@vadimlobanov/gaido-core';

export interface ResolvedConfig {
  name?: string;
  description?: string;
  /**
   * The coder registry, normalized from the config's `coder` / `coders`
   * fields (see `resolveCoderRegistry`). Always non-empty. The orchestrator
   * picks within it per node via the node's resolved `coderName`.
   */
  coders: Map<string, Coder>;
  /** Registry key used when a node names no coder. */
  defaultCoderName: string;
  critic: GaidoConfig['critic'];
  renderer: GaidoConfig['renderer'];
  previewServer: PreviewServerConfig | null;
  postCoderChecks: PostCoderCheck[];
  checkMaxRetries: number;
  concurrency: { agents: number; renderers: number };
  render: { width: number; height: number; fps: number; duration: number };
  server: { port: number; openBrowser: boolean };
  /**
   * Built-in per-run static preview server (`staticPreview` in the config).
   * Enabled by default; `port` defaults to the main server port + 1. The
   * orchestrator reads this to build each run's `previewUrl`; startup uses it
   * to bind the server. Process-global — never overridden by skeleton overlays.
   */
  staticPreview: { enabled: boolean; port: number };
}

export interface LoadedConfig {
  /** Fully-resolved config with defaults applied. Used everywhere at runtime. */
  config: ResolvedConfig;
  /**
   * The raw module export, before defaults were applied. Skeleton overlays
   * merge onto *this* so that a top-level field omitted by the overlay falls
   * back to the framework defaults rather than the project's resolved value
   * (Tailwind "top-level replaces"). See `applySkeletonOverlay`.
   */
  raw: GaidoConfig;
}

export interface LoadConfigOptions {
  /**
   * Module aliases applied when transpiling the config file — maps bare
   * specifiers (`gaido`, `@gaido/*`) to the absolute entry paths of the
   * framework copy that is actually running. Needed for `npx gaido`: the
   * project directory has no node_modules, so `import ... from 'gaido'` in
   * gaido.config.ts can't resolve from the config file's own location. The
   * CLI builds this map (see `buildFrameworkAlias` in the gaido package);
   * monorepo dev entrypoints omit it and rely on workspace links.
   */
  frameworkAlias?: Record<string, string>;
}

export async function loadConfig(
  configFile: string,
  options: LoadConfigOptions = {}
): Promise<LoadedConfig> {
  if (!fs.existsSync(configFile)) {
    // eslint-disable-next-line no-console
    console.error(
      `[gaido] gaido.config.ts not found at ${configFile}. ` +
        `Run \`gaido init\` to scaffold a project, or cd into a project directory.`
    );
    process.exit(1);
  }
  const jiti = createJiti(import.meta.url, {
    interopDefault: true,
    ...(options.frameworkAlias ? { alias: options.frameworkAlias } : {}),
  });
  const mod = (await jiti.import(configFile)) as
    | GaidoConfig
    | { default: GaidoConfig };
  const cfg: GaidoConfig =
    'default' in mod && typeof mod.default === 'object' && mod.default !== null
      ? (mod.default as GaidoConfig)
      : (mod as GaidoConfig);

  return { config: mergeWithDefaults(cfg), raw: cfg };
}

export function mergeWithDefaults(cfg: GaidoConfig): ResolvedConfig {
  const registry = resolveCoderRegistry(cfg);
  return {
    ...(cfg.name !== undefined ? { name: cfg.name } : {}),
    ...(cfg.description !== undefined ? { description: cfg.description } : {}),
    coders: registry.coders,
    defaultCoderName: registry.defaultName,
    critic: cfg.critic,
    renderer: cfg.renderer,
    previewServer: cfg.previewServer ?? null,
    postCoderChecks: cfg.postCoderChecks ?? [],
    checkMaxRetries: cfg.checkMaxRetries ?? defaults.checkMaxRetries,
    concurrency: {
      agents: cfg.concurrency?.agents ?? defaults.concurrency.agents,
      renderers: cfg.concurrency?.renderers ?? defaults.concurrency.renderers,
    },
    render: {
      width: cfg.render?.width ?? defaults.render.width,
      height: cfg.render?.height ?? defaults.render.height,
      fps: cfg.render?.fps ?? defaults.render.fps,
      duration: cfg.render?.duration ?? defaults.render.duration,
    },
    server: {
      port: cfg.server?.port ?? defaults.server.port,
      openBrowser: cfg.server?.openBrowser ?? defaults.server.openBrowser,
    },
    staticPreview: {
      enabled: !(cfg.staticPreview?.disabled ?? false),
      port:
        cfg.staticPreview?.port ??
        (cfg.server?.port ?? defaults.server.port) + 1,
    },
  };
}
