import {
  defineConfig,
  claudeCodeCoder,
  codexCoder,
  opencodeCoder,
  cursorCoder,
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
    // Cursor CLI ('cursor-agent' on PATH, `cursor-agent login` once). Effort is
    // encoded in the model id (`cursor-agent models` lists them); no effort opt.
    // Different adapter kind — incompatible session switch.
    cursor: cursorCoder({ model: 'auto' }),
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

  // Static publishing target for `gaido publish` (Cloudflare R2 + Worker).
  // Credentials come from env (~/.gaido/.env or ./.env); see infra/worker/README.md.
  publish: {
    siteUrl: 'https://graphs.gaido.ai',
    r2: {
      accountId: process.env.GAIDO_R2_ACCOUNT_ID ?? '',
      bucket: process.env.GAIDO_R2_BUCKET ?? '',
      accessKeyId: process.env.GAIDO_R2_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.GAIDO_R2_SECRET_ACCESS_KEY ?? '',
      // Point at any S3-compatible endpoint (e.g. local MinIO) for testing.
      ...(process.env.GAIDO_R2_ENDPOINT ? { endpoint: process.env.GAIDO_R2_ENDPOINT } : {}),
      ...(process.env.GAIDO_R2_REGION ? { region: process.env.GAIDO_R2_REGION } : {}),
    },
    include: { livePreviews: true },
  },
});
