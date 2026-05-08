import { defineConfig, stubCoder, stubCritic, stubRenderer } from 'gaido';

export default defineConfig({
  name: 'My Gaido Project',

  // Adapter implementations are not yet shipped.
  // The stubs below let the framework run end-to-end with a fake orchestrator
  // (status transitions, fake critique). Replace with real adapters when ready.
  coder: stubCoder(),
  critic: stubCritic(),
  renderer: stubRenderer(),

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
