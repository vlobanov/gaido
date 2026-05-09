export { defineConfig, stubCoder, stubCritic, stubRenderer } from '@gaido/core';
export { claudeCodeCoder, claudeCodeCritic } from '@gaido/adapter-claude-code';
export type {
  ClaudeCodeCoderOpts,
  ClaudeCodeCriticOpts,
  ClaudeCodePermissionMode,
} from '@gaido/adapter-claude-code';
export { playwrightRenderer } from '@gaido/adapter-playwright-renderer';
export type { PlaywrightRendererOpts } from '@gaido/adapter-playwright-renderer';
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
} from '@gaido/core';
