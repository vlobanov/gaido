"""Gaido Blender render runner.

Runs headless inside Blender via:

    blender --background --factory-startup --python runner.py -- --params <file>

Owns orchestration so the agent-authored scene only has to describe *what* to
build: it presets sane render defaults, executes the scene script, reads back
whatever the scene decided (frame range / fps win over our presets), then
renders the animation to PNG frames and best-effort exports a GLB. The Node
adapter parses the GAIDO_META / GAIDO_WARN lines and the Blender `Fra:` progress
lines from stdout.
"""

import json
import runpy
import sys
import traceback

import bpy


def _log(prefix, text):
    # Single-line, prefixed so the Node adapter can grep stdout deterministically.
    sys.stdout.write(prefix + " " + text + "\n")
    sys.stdout.flush()


def _parse_params():
    argv = sys.argv
    # Everything after the standalone "--" is ours; Blender consumes the rest.
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    else:
        argv = []
    if "--params" not in argv:
        _log("GAIDO_WARN", "no --params argument supplied")
        sys.exit(1)
    params_file = argv[argv.index("--params") + 1]
    with open(params_file, "r", encoding="utf-8") as fh:
        return json.load(fh)


def _pick_engine():
    """BLENDER_EEVEE_NEXT on 4.2+, else legacy BLENDER_EEVEE."""
    try:
        items = bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items
        names = {e.identifier for e in items}
    except Exception:
        names = set()
    for candidate in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
        if candidate in names:
            return candidate
    # Fall back to whatever is currently set rather than guessing wrong.
    return None


def main():
    params = _parse_params()
    scene_file = params["sceneFile"]
    frames_dir = params["framesDir"]
    width = int(params["width"])
    height = int(params["height"])
    fps = int(params["fps"])
    duration = float(params["duration"])
    glb_path = params.get("glbPath")

    # Start from a truly empty scene — no default cube / camera / light. The
    # agent's script is responsible for adding a camera AND a light.
    bpy.ops.wm.read_factory_settings(use_empty=True)

    scene = bpy.context.scene
    render = scene.render

    # Preset defaults BEFORE the scene runs; the scene may override any of them.
    render.resolution_x = width
    render.resolution_y = height
    render.resolution_percentage = 100
    render.fps = fps
    render.fps_base = 1.0
    scene.frame_start = 1
    scene.frame_end = max(1, round(duration * fps))

    engine = _pick_engine()
    if engine is not None:
        render.engine = engine

    # Execute the agent-authored scene as __main__ so top-level code runs.
    try:
        runpy.run_path(scene_file, run_name="__main__")
    except Exception:
        traceback.print_exc()
        sys.stderr.flush()
        sys.exit(1)

    # Re-fetch the active scene — the script may have created a fresh one.
    scene = bpy.context.scene
    render = scene.render

    # The scene's own settings win. Read them back for the encoder.
    frame_start = int(scene.frame_start)
    frame_end = int(scene.frame_end)
    out_fps = int(render.fps / max(render.fps_base, 1e-6))

    _log(
        "GAIDO_META",
        json.dumps({"frameStart": frame_start, "frameEnd": frame_end, "fps": out_fps}),
    )

    # Force output settings the runner owns — the scene must not need to set
    # them. Frames land as frame-0001.png … next to each other in frames_dir.
    render.filepath = frames_dir.rstrip("/") + "/frame-"
    render.image_settings.file_format = "PNG"
    render.image_settings.color_mode = "RGBA"
    render.film_transparent = False

    try:
        bpy.ops.render.render(animation=True)
    except Exception:
        traceback.print_exc()
        sys.stderr.flush()
        sys.exit(1)

    # GLB export is best-effort: the video is the load-bearing output.
    if glb_path:
        try:
            bpy.ops.export_scene.gltf(
                filepath=glb_path,
                export_format="GLB",
                export_animations=True,
                export_cameras=True,
                export_lights=True,
            )
        except Exception as exc:
            _log("GAIDO_WARN", "glb export failed: " + repr(exc))


if __name__ == "__main__":
    main()
