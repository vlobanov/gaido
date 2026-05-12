import type { Db } from './db.js';
import type { EventBus } from './event-bus.js';
import type { Orchestrator } from './orchestrator.js';
import type { Paths } from './paths.js';
import type { ResolvedConfig } from './config-loader.js';
import type { WorkspaceManager } from './workspace.js';
import type { PreviewServerHandle } from './preview-server.js';

export interface Context {
  db: Db;
  eventBus: EventBus;
  orchestrator: Orchestrator;
  paths: Paths;
  config: ResolvedConfig;
  workspace: WorkspaceManager;
  /** Running preview dev server, if one is configured. Null otherwise. */
  previewServer: PreviewServerHandle | null;
}

export interface ContextDeps extends Context {}

export function createContextFactory(deps: ContextDeps): () => Context {
  return () => deps;
}
