export const gaidoConfigTemplate = `import { defineConfig, claudeCodeCoder, playwrightRenderer, geminiCritic } from 'gaido';

export default defineConfig({
  name: 'My Gaido Project',

  // Real adapters are wired by default.
  // Requires: 'claude' on PATH (coder), 'ffmpeg' on PATH (renderer + critic
  // frame fallbacks), and OPENROUTER_API_KEY in env (critic).
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
`;

export const envExampleTemplate = `# API keys for adapter implementations.
# Copy this file to .env and fill in real values.
#
# Loaded from <projectDir>/.env at startup. Shared keys can also live in
# ~/.gaido/.env (project values override).

# Used by geminiCritic (sends rendered video to Gemini via OpenRouter).
# OPENROUTER_API_KEY=
`;

export const gitignoreTemplate = `# Gaido runtime state
gaido.db
gaido.db-journal
gaido.db-wal
gaido.db-shm
runs/

# Environment
.env
.env.local

# Dependencies
node_modules/

# OS
.DS_Store
`;

/**
 * A built-in skeleton template. Each entry contains the files that get
 * scaffolded into `<projectDir>/skeleton/`.
 */
export interface SkeletonTemplate {
  description: string;
  files: { 'index.html': string; 'CLAUDE.md': string };
}

const pixiIndexHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Gaido scene</title>
    <style>
      html, body { margin: 0; padding: 0; background: #000; overflow: hidden; }
      canvas { display: block; }
    </style>
    <script src="https://pixijs.download/v8.6.0/pixi.min.js"></script>
  </head>
  <body>
    <script type="module">
      // The coder agent will replace or extend this script.
      // It should produce a Pixi/Canvas/WebGL animation that fills the viewport.

      const app = new PIXI.Application();
      await app.init({ resizeTo: window, background: '#000' });
      document.body.appendChild(app.canvas);

      // Placeholder content — agents replace.
      const text = new PIXI.Text({
        text: 'Replace me',
        style: { fontFamily: 'system-ui', fontSize: 64, fill: '#888' },
      });
      text.anchor.set(0.5);
      text.x = app.screen.width / 2;
      text.y = app.screen.height / 2;
      app.stage.addChild(text);
    </script>
  </body>
</html>
`;

const pixiClaudeMd = `# Project conventions for the coder agent

You are generating a self-contained visual animation that runs in a single
\`index.html\` file in this directory. The renderer will load this file in a
headless browser and capture video.

## Output requirements

- Animation must fill the viewport and run smoothly at the configured fps.
- All assets are inline or loaded from a stable CDN. No local file deps.
- Use Pixi.js (already imported via CDN in the skeleton). Plain canvas/WebGL
  also fine if you prefer.
- The animation should loop or play out gracefully within the configured
  duration (default 5 seconds).
- Keep the animation \`<script>\` tag as \`type="module"\` — Pixi's \`app.init()\`
  is async and the skeleton uses top-level await. Removing \`type="module"\`
  will produce a SyntaxError and a black render.

## Style

- Minimal, focused, well-composed.
- Avoid relying on text labels — the visual should carry the idea.
- Typography (when used): system-ui or Inter.

## What to write

When given an instruction, edit \`index.html\` to realize the concept. Keep
the file self-contained. You may add additional \`.js\`/\`.css\` files in
this directory if it helps modularity.
`;

const cssIndexHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Gaido scene</title>
    <style>
      :root { color-scheme: dark; }
      html, body {
        margin: 0; padding: 0; height: 100%;
        background: #000; color: #fff; overflow: hidden;
        font-family: 'Inter', system-ui, -apple-system, sans-serif;
      }
      #stage {
        position: fixed; inset: 0;
        display: grid; place-items: center;
      }
      .placeholder {
        font-size: clamp(32px, 6vw, 72px);
        letter-spacing: 0.02em;
        opacity: 0.5;
      }
    </style>
  </head>
  <body>
    <!-- The coder agent will replace this content. -->
    <!-- Pure DOM/CSS/SVG by default — no JS framework loaded. -->
    <div id="stage">
      <div class="placeholder">Replace me</div>
    </div>
  </body>
</html>
`;

const cssClaudeMd = `# Project conventions for the coder agent

You are generating a self-contained visual animation that runs in a single
\`index.html\` file in this directory. The renderer will load this file in a
headless browser and capture video.

## Output requirements

- Animation must fill the viewport and run smoothly at the configured fps.
- Pure DOM/CSS/SVG. No JS framework is loaded by default — keep it that way
  unless you have a specific reason to add one.
- All assets are inline or loaded from a stable CDN. No local file deps.
- The animation should loop or play out gracefully within the configured
  duration (default 5 seconds).
- Drive motion with CSS keyframes/transitions, SVG \`<animate>\`, or
  \`requestAnimationFrame\` — all play nicely with the renderer's fake clock.

## Style

- Minimal, focused, well-composed.
- Avoid relying on text labels — the visual should carry the idea unless
  typography IS the idea (kinetic type is fair game).
- Typography (when used): system-ui or Inter.

## What to write

When given an instruction, edit \`index.html\` to realize the concept. Keep
the file self-contained. You may add additional \`.js\`/\`.css\` files in
this directory if it helps modularity.
`;

export const skeletonCatalog: Record<string, SkeletonTemplate> = {
  pixi: {
    description: 'Pixi.js v8 via CDN — procedural / canvas / WebGL animations.',
    files: { 'index.html': pixiIndexHtml, 'CLAUDE.md': pixiClaudeMd },
  },
  css: {
    description: 'Pure DOM/CSS/SVG — kinetic typography, layered effects, transforms.',
    files: { 'index.html': cssIndexHtml, 'CLAUDE.md': cssClaudeMd },
  },
};

export const DEFAULT_SKELETON = 'pixi';
