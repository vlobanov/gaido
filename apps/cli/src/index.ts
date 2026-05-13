export { defineConfig, stubCoder, stubCritic, stubRenderer, humanCritic } from '@gaido/core';
export { claudeCodeCoder, claudeCodeCritic } from '@gaido/adapter-claude-code';
export type {
  ClaudeCodeCoderOpts,
  ClaudeCodeCriticOpts,
  ClaudeCodePermissionMode,
} from '@gaido/adapter-claude-code';
export {
  playwrightRenderer,
  playwrightRecordRenderer,
} from '@gaido/adapter-playwright-renderer';
export type {
  PlaywrightRendererOpts,
  PlaywrightRecordRendererOpts,
} from '@gaido/adapter-playwright-renderer';
export { geminiCritic } from '@gaido/adapter-openrouter';
export type { GeminiCriticOpts } from '@gaido/adapter-openrouter';
export type {
  GaidoConfig,
  Coder,
  Critic,
  Renderer,
  CoderInput,
  CoderResult,
  CriticInput,
  CriticResult,
  RenderInput,
  RenderResult,
  RunContext,
  Critique,
  EventPayload,
  NodeStatus,
  RunStatus,
  PreviewServerConfig,
  PostCoderCheck,
} from '@gaido/core';
