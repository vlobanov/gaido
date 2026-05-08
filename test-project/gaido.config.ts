import { defineConfig, claudeCodeCoder, playwrightRenderer, stubCritic } from 'gaido';

export default defineConfig({
  name: 'My Gaido Project',

  coder: claudeCodeCoder(),
  renderer: playwrightRenderer(),
  // Critic is still a stub.
  critic: stubCritic(),

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
