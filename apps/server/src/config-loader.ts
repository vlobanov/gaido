import fs from 'node:fs';
import { createJiti } from 'jiti';
import { defaults } from '@gaido/core';
import type { GaidoConfig } from '@gaido/core';

export interface ResolvedConfig {
  name?: string;
  description?: string;
  coder: GaidoConfig['coder'];
  critic: GaidoConfig['critic'];
  renderer: GaidoConfig['renderer'];
  concurrency: { agents: number; renderers: number };
  render: { width: number; height: number; fps: number; duration: number };
  server: { port: number; openBrowser: boolean };
}

export async function loadConfig(configFile: string): Promise<ResolvedConfig> {
  if (!fs.existsSync(configFile)) {
    // eslint-disable-next-line no-console
    console.error(
      `[gaido] gaido.config.ts not found at ${configFile}. ` +
        `Run \`gaido init\` to scaffold a project, or cd into a project directory.`
    );
    process.exit(1);
  }
  const jiti = createJiti(import.meta.url, { interopDefault: true });
  const mod = (await jiti.import(configFile)) as
    | GaidoConfig
    | { default: GaidoConfig };
  const cfg: GaidoConfig =
    'default' in mod && typeof mod.default === 'object' && mod.default !== null
      ? (mod.default as GaidoConfig)
      : (mod as GaidoConfig);

  return mergeWithDefaults(cfg);
}

export function mergeWithDefaults(cfg: GaidoConfig): ResolvedConfig {
  return {
    ...(cfg.name !== undefined ? { name: cfg.name } : {}),
    ...(cfg.description !== undefined ? { description: cfg.description } : {}),
    coder: cfg.coder,
    critic: cfg.critic,
    renderer: cfg.renderer,
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
  };
}
