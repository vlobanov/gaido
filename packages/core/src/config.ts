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
  coder: Coder;
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

export const defaults = {
  concurrency: { agents: 8, renderers: 2 },
  render: { width: 1024, height: 1024, fps: 30, duration: 5 },
  server: { port: 4288, openBrowser: true },
  checkMaxRetries: 3,
} as const;
