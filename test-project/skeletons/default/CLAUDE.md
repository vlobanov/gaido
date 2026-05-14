# Project conventions for the coder agent

You are generating a self-contained visual animation that runs in a single
`index.html` file in this directory. The renderer will load this file in a
headless browser and capture video.

## Output requirements

- Animation must fill the viewport and run smoothly at the configured fps.
- All assets are inline or loaded from a stable CDN. No local file deps.
- Use Pixi.js (already imported via CDN in the skeleton). Plain canvas/WebGL
  also fine if you prefer.
- The animation should loop or play out gracefully within the configured
  duration (default 5 seconds).
- Keep the animation `<script>` tag as `type="module"` — Pixi's `app.init()`
  is async and the skeleton uses top-level await. Removing `type="module"`
  will produce a SyntaxError and a black render.

## Style

- Minimal, focused, well-composed.
- Avoid relying on text labels — the visual should carry the idea.
- Typography (when used): system-ui or Inter.

## What to write

When given an instruction, edit `index.html` to realize the concept. Keep
the file self-contained. You may add additional `.js`/`.css` files in
this directory if it helps modularity.
