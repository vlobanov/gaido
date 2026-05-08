import type { Coder, Critic, Renderer } from './adapters.js';

export interface GaidoConfig {
  name?: string;
  description?: string;
  coder: Coder;
  critic: Critic;
  renderer: Renderer;
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
} as const;
