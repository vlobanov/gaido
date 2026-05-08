export { defineConfig, stubCoder, stubCritic, stubRenderer } from '@gaido/core';
export { claudeCodeCoder } from '@gaido/adapter-claude-code';
export type { ClaudeCodeCoderOpts, ClaudeCodePermissionMode } from '@gaido/adapter-claude-code';
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
