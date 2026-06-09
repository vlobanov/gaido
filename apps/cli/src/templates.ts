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
  files: {
    'index.html': string;
    'CLAUDE.md': string;
    /**
     * Optional per-skeleton config overlay. Excluded from the seed commit, so
     * it never lands in a worktree or the art diff — it's read live by the
     * orchestrator to layer checks / render params / adapters over the project
     * config for nodes using this skeleton.
     */
    'gaido.skeleton.ts'?: string;
  };
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

const skeletonConfigExample = `import { defineSkeleton } from 'gaido';

/**
 * Per-skeleton config overlay — a Tailwind-style preset for THIS skeleton.
 *
 * It layers on top of the project's gaido.config.ts for every node that uses
 * this skeleton (the root that picks it and its whole fork lineage). Read live
 * on each run and never committed into a worktree, so editing it takes effect
 * on the next run — no re-seed, no restart.
 *
 * Merge rules:
 *   - a TOP-LEVEL field REPLACES the project value
 *   - a field under \`extend\` MERGES in: \`postCoderChecks\` appends after the
 *     project's checks, \`render\` shallow-merges so you can set just \`width\`
 *
 * \`server\` and \`concurrency\` are process-global and rejected here — set them
 * in gaido.config.ts. Everything goes through this file commented out by
 * default, so it's a no-op until you uncomment something.
 */
export default defineSkeleton({
  // extend: {
  //   // Linter-style checks run after the coder finishes. A non-zero exit
  //   // feeds stdout+stderr back to the coder to fix, up to checkMaxRetries.
  //   // Use \${GAIDO_WORKDIR} etc. to reference run paths.
  //   postCoderChecks: [
  //     { name: 'has-canvas', command: ['grep', '-q', 'app.canvas', 'index.html'] },
  //   ],
  //   // Tune just the dimensions this artifact type needs; fps + duration
  //   // stay whatever gaido.config.ts sets.
  //   render: { width: 512, height: 512 },
  // },
  //
  // // A top-level field REPLACES the project's. e.g. swap in a stricter critic
  // // for this skeleton only:
  // // critic: myStricterCritic(),
});
`;

/**
 * Each entry becomes a folder under `<projectDir>/skeletons/<name>/` at init.
 * The `default` entry is the seed for new roots when the user hasn't picked
 * one explicitly — keep it general-purpose.
 */
export const skeletonCatalog: Record<string, SkeletonTemplate> = {
  default: {
    description: 'Pixi.js v8 via CDN — procedural / canvas / WebGL animations.',
    files: {
      'index.html': pixiIndexHtml,
      'CLAUDE.md': pixiClaudeMd,
      'gaido.skeleton.ts': skeletonConfigExample,
    },
  },
  css: {
    description: 'Pure DOM/CSS/SVG — kinetic typography, layered effects, transforms.',
    files: { 'index.html': cssIndexHtml, 'CLAUDE.md': cssClaudeMd },
  },
};
