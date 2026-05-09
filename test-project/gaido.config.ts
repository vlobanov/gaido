import { defineConfig, claudeCodeCoder, playwrightRenderer, geminiCritic } from 'gaido';

export default defineConfig({
  name: 'My Gaido Project',

  coder: claudeCodeCoder(),
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
