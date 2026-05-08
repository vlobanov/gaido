import { defineConfig, claudeCodeCoder, stubCritic, stubRenderer } from 'gaido';

export default defineConfig({
  name: 'My Gaido Project',

  coder: claudeCodeCoder(),
  // Critic and renderer are still stubs.
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
