import {
  defineConfig,
  claudeCodeCoder,
  codexCoder,
  opencodeCoder,
  stubCoder,
  playwrightRenderer,
  geminiCritic,
} from 'gaido';

export default defineConfig({
  name: 'My Gaido Project',

  // Named coder variants. The first entry ('cc-sonnet') is the default; the
  // seed picker and the mid-graph "Switch coder" modal list all of them.
  // 'stub' is a different adapter kind — switching to/from it is the
  // session-incompatible path (forces a fresh session).
  coders: {
    'cc-sonnet': claudeCodeCoder({ model: 'sonnet' }),
    'cc-opus': claudeCodeCoder({ model: 'opus' }),
    codex: codexCoder({ effort: 'medium' }),
    // OpenCode CLI ('opencode' on PATH). 'opencode/*' free hosted models work
    // with no auth; or point at any provider you've configured (incl. a local
    // 'ollama/<model>'). Different adapter kind — incompatible session switch.
    opencode: opencodeCoder({ model: 'opencode/deepseek-v4-flash-free' }),
    stub: stubCoder(),
  },
  renderer: playwrightRenderer(),
  critic: geminiCritic(),

  render: {
    width: 1024,
    height: 1024,
    fps: 30,
    duration: 5,
  },

  concurrency: {
    agents: 8,
    renderers: 2,
  },

  server: {
    port: 4288,
    openBrowser: true,
  },
});
