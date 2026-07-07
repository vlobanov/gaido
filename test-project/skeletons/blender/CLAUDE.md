# Project conventions for the coder agent

You are authoring a single Blender scene in `scene.py` in this directory. It
runs headless inside Blender (via gaido's runner) and the result is captured as
video — plus a GLB export of the same scene.

## The contract

- **You write `scene.py` only.** Use `bpy` to build the scene. It executes as
  `__main__` inside Blender `--background`.
- **The scene starts EMPTY** — no default cube, camera, or light. You MUST add
  a camera and set `scene.camera`, and add at least one light (or use emissive
  materials). No camera or no light → a black render.
- **gaido presets defaults before your script runs**: `resolution_x/y`, `fps`,
  and a frame range. Your script's `scene.frame_start` / `scene.frame_end` /
  `render.fps` override them — that's how you control duration. Set the frame
  range explicitly; derive length from `scene.render.fps` so it tracks the
  configured fps.
- **Do NOT call render or export operators.** No `bpy.ops.render.render(...)`,
  no `bpy.ops.export_scene.gltf(...)`, no `render.filepath` /
  `image_settings` changes. The runner owns rendering (Eevee), PNG→mp4
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
