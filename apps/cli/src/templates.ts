export const gaidoConfigTemplate = `import { defineConfig, claudeCodeCoder, playwrightRenderer, geminiCritic } from 'gaido';

export default defineConfig({
  name: 'My Gaido Project',

  // Real adapters are wired by default.
  // Requires: 'claude' on PATH (coder), 'ffmpeg' on PATH (renderer + critic
  // frame fallbacks), and OPENROUTER_API_KEY in env (critic).
  coder: claudeCodeCoder(),
  // Prefer named variants? Swap \`coder\` for a \`coders\` map and the seed
  // picker + mid-graph "Switch coder" both list them (first entry is the
  // default):
  //   coders: {
  //     'cc-sonnet': claudeCodeCoder({ model: 'sonnet' }),
  //     'cc-opus': claudeCodeCoder({ model: 'opus', effort: 'high' }),
  //     codex: codexCoder({ effort: 'high' }),  // OpenAI Codex CLI ('codex' on PATH)
  //     opencode: opencodeCoder({ model: 'anthropic/claude-sonnet-4-5' }),  // OpenCode CLI ('opencode' on PATH) — any provider, incl. local Ollama
  //     cursor: cursorCoder({ model: 'auto' }),  // Cursor CLI ('cursor-agent' on PATH; effort is part of the model id, see 'cursor-agent models')
  //   },
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

  // Publish a finished canvas as a static read-only site (gaido publish →
  // Cloudflare R2 + Worker). Uncomment, set siteUrl, and put the R2 credentials
  // in .env (see .env.example + infra/worker/README.md in the gaido repo).
  // publish: {
  //   siteUrl: 'https://graphs.example.com',
  //   r2: {
  //     accountId: process.env.GAIDO_R2_ACCOUNT_ID ?? '',
  //     bucket: process.env.GAIDO_R2_BUCKET ?? '',
  //     accessKeyId: process.env.GAIDO_R2_ACCESS_KEY_ID ?? '',
  //     secretAccessKey: process.env.GAIDO_R2_SECRET_ACCESS_KEY ?? '',
  //   },
  //   include: { livePreviews: false }, // true ALSO publishes each run's source code
  // },
});
`;

export const envExampleTemplate = `# API keys for adapter implementations.
# Copy this file to .env and fill in real values.
#
# Loaded from <projectDir>/.env at startup. Shared keys can also live in
# ~/.gaido/.env (project values override).

# Used by geminiCritic (sends rendered video to Gemini via OpenRouter).
# OPENROUTER_API_KEY=

# Used by \`gaido publish\` (Cloudflare R2, S3 API). See infra/worker/README.md.
# GAIDO_R2_ACCOUNT_ID=
# GAIDO_R2_BUCKET=
# GAIDO_R2_ACCESS_KEY_ID=
# GAIDO_R2_SECRET_ACCESS_KEY=
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
  /**
   * Files scaffolded into `skeletons/<name>/`. Every skeleton ships a
   * `CLAUDE.md` (agent guidance) and an entry file the renderer reads —
   * `index.html` for the browser renderer, `scene.py` for Blender.
   * `gaido.skeleton.ts` is the optional per-skeleton config overlay: excluded
   * from the seed commit (never lands in a worktree or the art diff) and read
   * live by the orchestrator to layer checks / render params / adapters over
   * the project config for nodes using this skeleton.
   */
  files: {
    'CLAUDE.md': string;
    'gaido.skeleton.ts'?: string;
  } & Record<string, string>;
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

const websiteIndexHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Untitled site</title>
    <style>
      /* The coder agent replaces this page entirely. The starter only
         establishes a scrollable document — no design baked in. */
      html, body { margin: 0; padding: 0; }
      body {
        font-family: system-ui, -apple-system, sans-serif;
        color: #1a1a1a; background: #fff;
      }
      main { max-width: 56rem; margin: 0 auto; padding: 6rem 1.5rem; }
    </style>
  </head>
  <body>
    <main>
      <h1>Replace me</h1>
      <p>The coder agent builds the whole site here.</p>
    </main>
  </body>
</html>
`;

const websiteClaudeMd = `# Project conventions for the coder agent

You are building a complete static website in this directory. \`index.html\`
is the entry point. The renderer loads it in a headless browser at the
configured viewport and films a slow scroll from the top of the page to the
bottom — that scroll-through video is what the artist (and the critic) see.

## Output requirements

- A full page with real scroll height: hero first, then the sections the
  brief calls for, then a footer. One strong screen is not a website.
- Static and self-contained: plain HTML/CSS (+ small vanilla JS where it
  earns its place). No build step, no frameworks, no external JS libraries.
- You may split into \`styles.css\` / extra pages / inline SVG files in this
  directory. Keep it tidy.
- Fonts: system stacks, or Google Fonts via \`<link>\` (add preconnect).
- Images: draw them — inline SVG, CSS art, data URIs. Do NOT hotlink stock
  photos or external image URLs; the render machine may not fetch them and
  every render must be reproducible.
- Content must be real copy, written for the specific brief: actual names,
  prices, dates, hours, addresses (invented but plausible). Never lorem
  ipsum, never "Your Company", never placeholder anything.

## Motion & capture

- CSS animations/transitions are fine and will show in the scroll-through.
- Content must be visible without JS. If you add entrance animations,
  default elements to visible and enhance — an IntersectionObserver that
  leaves sections at opacity 0 reads as a blank page on capture.
- No scroll-jacking, no JS smooth-scrolling.

## Craft

- Design like a person was paid for it: deliberate type scale, spacing
  rhythm, a color system, considered hierarchy. Semantic landmarks and alt
  text throughout.
- Match the register of the business in the brief — a bakery and a law firm
  should not share a voice.
`;

const websiteSkeletonConfig = `import {
  defineSkeleton,
  playwrightRenderer,
  claudeCodeCritic,
} from 'gaido';

/**
 * Website preset overlay: the camera scrolls the page instead of holding a
 * fixed viewport, the critic reviews as a web designer, and the frame is a
 * desktop viewport. Layers over gaido.config.ts for every node using this
 * skeleton — see the default skeleton's gaido.skeleton.ts for merge rules.
 */
export default defineSkeleton({
  renderer: playwrightRenderer({ capture: 'scroll' }),
  critic: claudeCodeCritic({
    persona:
      'You are a senior web designer reviewing a generated website. The keyframes are a top-to-bottom scroll through the page.',
    criteria:
      'visual hierarchy, typography, spacing and rhythm, color, quality and credibility of the content, how well it satisfies the brief',
    // Websites are tall and the eased scroll moves fastest mid-page; 16
    // frames keeps consecutive samples overlapping at an 800px viewport so
    // no section can slip between keyframes unseen.
    frameCount: 16,
  }),
  extend: {
    render: { width: 1280, height: 800, duration: 10 },
  },
});
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

const blenderScenedPy = `"""Gaido Blender scene — you (the coder agent) edit THIS file only.

It runs headless inside Blender, via gaido's runner, which presets resolution,
fps, and a default frame range BEFORE this script executes. Anything you set
here wins. Do NOT call render/export operators — the runner owns rendering
(Eevee), video encoding, and GLB export. Just describe the scene and keyframe
the motion.

The scene starts EMPTY: no default cube, camera, or light. You must add a
camera AND a light or the render is black.
"""

import math

import bpy

scene = bpy.context.scene

# Duration control: set the frame range explicitly (fps is preset by gaido).
# Here: a 4-second loop at whatever fps gaido configured.
fps = scene.render.fps
scene.frame_start = 1
scene.frame_end = fps * 4

# --- Object: a rounded, glowing torus -------------------------------------
bpy.ops.mesh.primitive_torus_add(
    major_radius=1.0, minor_radius=0.38, major_segments=64, minor_segments=24
)
obj = bpy.context.active_object
bpy.ops.object.shade_smooth()

mat = bpy.data.materials.new("Glow")
mat.use_nodes = True
bsdf = mat.node_tree.nodes.get("Principled BSDF")
if bsdf:
    bsdf.inputs["Base Color"].default_value = (0.05, 0.35, 0.85, 1.0)
    bsdf.inputs["Metallic"].default_value = 0.6
    bsdf.inputs["Roughness"].default_value = 0.25
    # Emission gives Eevee a self-lit look without extra lamps.
    bsdf.inputs["Emission Color"].default_value = (0.1, 0.5, 1.0, 1.0)
    bsdf.inputs["Emission Strength"].default_value = 1.5
obj.data.materials.append(mat)

# --- Animate: one full spin over the whole range (loops cleanly) ----------
obj.rotation_euler = (math.radians(20), 0.0, 0.0)
obj.keyframe_insert("rotation_euler", frame=scene.frame_start)
obj.rotation_euler = (math.radians(20), 0.0, math.radians(360))
obj.keyframe_insert("rotation_euler", frame=scene.frame_end)
# Linear interpolation keeps the spin steady end-to-end.
if obj.animation_data and obj.animation_data.action:
    for fcurve in obj.animation_data.action.fcurves:
        for kp in fcurve.keyframe_points:
            kp.interpolation = "LINEAR"

# --- Camera ----------------------------------------------------------------
cam_data = bpy.data.cameras.new("Camera")
cam = bpy.data.objects.new("Camera", cam_data)
scene.collection.objects.link(cam)
cam.location = (0.0, -4.5, 2.2)
cam.rotation_euler = (math.radians(64), 0.0, 0.0)
scene.camera = cam  # the runner renders through scene.camera

# --- Light -----------------------------------------------------------------
light_data = bpy.data.lights.new("Key", type="AREA")
light_data.energy = 400.0
light_data.size = 6.0
light = bpy.data.objects.new("Key", light_data)
scene.collection.objects.link(light)
light.location = (3.0, -3.0, 5.0)

# World background — a soft dark so the glow reads.
world = scene.world or bpy.data.worlds.new("World")
scene.world = world
world.use_nodes = True
bg = world.node_tree.nodes.get("Background")
if bg:
    bg.inputs["Color"].default_value = (0.02, 0.02, 0.03, 1.0)
`;

const blenderClaudeMd = `# Project conventions for the coder agent

You are authoring a single Blender scene in \`scene.py\` in this directory. It
runs headless inside Blender (via gaido's runner) and the result is captured as
video — plus a GLB export of the same scene.

## The contract

- **You write \`scene.py\` only.** Use \`bpy\` to build the scene. It executes as
  \`__main__\` inside Blender \`--background\`.
- **The scene starts EMPTY** — no default cube, camera, or light. You MUST add
  a camera and set \`scene.camera\`, and add at least one light (or use emissive
  materials). No camera or no light → a black render.
- **gaido presets defaults before your script runs**: \`resolution_x/y\`, \`fps\`,
  and a frame range. Your script's \`scene.frame_start\` / \`scene.frame_end\` /
  \`render.fps\` override them — that's how you control duration. Set the frame
  range explicitly; derive length from \`scene.render.fps\` so it tracks the
  configured fps.
- **Do NOT call render or export operators.** No \`bpy.ops.render.render(...)\`,
  no \`bpy.ops.export_scene.gltf(...)\`, no \`render.filepath\` /
  \`image_settings\` changes. The runner owns rendering (Eevee), PNG→mp4
  encoding, and the GLB export. Touching them will fight the runner.

## Craft

- Animate with keyframes, drivers, or modifiers — not by rendering a still.
  Make the motion read within the clip and, where it makes sense, loop cleanly.
- Renders on **Eevee** (real-time engine). Keep it performant: no heavy physics
  or fluid/smoke bakes, reasonable poly counts, a handful of lights.
- Compose deliberately: frame the subject, light it with intent, give the world
  background a considered value. Emissive materials are a cheap, pretty way to
  get glow in Eevee.
- The starter builds a glowing torus with a camera and area light — replace it
  wholesale to realize the brief; keep the camera + light discipline.
`;

const blenderSkeletonConfig = `import { defineSkeleton, blenderRenderer } from 'gaido';

/**
 * Blender preset overlay: routes nodes using this skeleton to the headless
 * Blender renderer (Eevee → mp4, plus a GLB export) instead of the default
 * browser renderer. Layers over gaido.config.ts for every node using this
 * skeleton — see the default skeleton's gaido.skeleton.ts for merge rules.
 */
export default defineSkeleton({
  renderer: blenderRenderer(),
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
  website: {
    description:
      'Static websites — scroll-through capture, web-designer critic, desktop viewport.',
    files: {
      'index.html': websiteIndexHtml,
      'CLAUDE.md': websiteClaudeMd,
      'gaido.skeleton.ts': websiteSkeletonConfig,
    },
  },
  blender: {
    description:
      'Headless Blender (Eevee) — bpy scene → animation video + GLB export.',
    files: {
      'scene.py': blenderScenedPy,
      'CLAUDE.md': blenderClaudeMd,
      'gaido.skeleton.ts': blenderSkeletonConfig,
    },
  },
};
