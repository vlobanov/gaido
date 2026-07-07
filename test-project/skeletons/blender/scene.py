"""Gaido Blender scene — you (the coder agent) edit THIS file only.

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
