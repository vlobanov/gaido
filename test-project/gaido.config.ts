import {
  defineConfig,
  claudeCodeCoder,
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
