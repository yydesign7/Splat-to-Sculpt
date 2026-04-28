#!/usr/bin/env python3
"""
Run inside Blender: 360° turntable render of a GLB/GLTF with materials (EEVEE).

  blender --background --python blender_rotation_video.py -- \\
    --model /path/to/model.glb \\
    --frames-dir /path/to/frames/ \\
    --total-frames 180 \\
    --width 512 --height 512 \\
    [--light-json /path/to/lights.json]

Last stdout line: JSON { "status": "ok"|"error", ... }
"""
from __future__ import annotations

import json
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector


def _argv_after_dd() -> list[str]:
    if "--" not in sys.argv:
        return []
    return sys.argv[sys.argv.index("--") + 1 :]


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for mesh in list(bpy.data.meshes):
        bpy.data.meshes.remove(mesh)
    for mat in list(bpy.data.materials):
        bpy.data.materials.remove(mat)


def spherical_to_cartesian(azimuth_deg: float, elevation_deg: float, radius: float = 5.0):
    az = math.radians(azimuth_deg)
    el = math.radians(elevation_deg)
    x = radius * math.cos(el) * math.cos(az)
    y = radius * math.cos(el) * math.sin(az)
    z = radius * math.sin(el)
    return Vector((x, y, z))


def combined_mesh_bounds_world():
    """World-space AABB over all mesh objects (respects parent transforms)."""
    min_c = Vector((1e30, 1e30, 1e30))
    max_c = Vector((-1e30, -1e30, -1e30))
    found = False
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH":
            continue
        found = True
        for corner in obj.bound_box:
            w = obj.matrix_world @ Vector(corner)
            for i in range(3):
                if w[i] < min_c[i]:
                    min_c[i] = w[i]
                if w[i] > max_c[i]:
                    max_c[i] = w[i]
    if not found:
        return Vector((0, 0, 0)), Vector((1, 1, 1))
    return (min_c + max_c) / 2, max_c - min_c


def mesh_hierarchy_roots():
    """One root per mesh object tree (Empty / Armature / root Mesh)."""
    roots: set[bpy.types.Object] = set()
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH":
            continue
        p = obj
        while p.parent is not None:
            p = p.parent
        roots.add(p)
    return roots


def center_scene_content_at_origin():
    """Move entire import hierarchies so mesh world AABB center is at origin.

    Per-mesh ``matrix_world.translation -= center`` breaks parented GLB
    (Empties / Armatures): geometry leaves the camera target.
    """
    center, _ext = combined_mesh_bounds_world()
    if center.length < 1e-20:
        return
    offset = Matrix.Translation(-center)
    for root in mesh_hierarchy_roots():
        root.matrix_world = offset @ root.matrix_world


def setup_lights(lp: dict):
    color = lp.get("mainLightColor", [1.0, 1.0, 1.0])
    bpy.ops.object.light_add(type="SUN", location=(0, 0, 10))
    ambient = bpy.context.active_object
    ambient.data.energy = float(lp.get("ambientIntensity", 0.6)) * 3.0
    ambient.data.color = (float(color[0]), float(color[1]), float(color[2]))

    main_az = float(lp.get("mainLightAzimuth", 45))
    main_el = float(lp.get("mainLightElevation", 45))
    main_pos = spherical_to_cartesian(main_az, main_el, 5.0)
    bpy.ops.object.light_add(type="AREA", location=tuple(main_pos))
    light1 = bpy.context.active_object
    light1.data.energy = float(lp.get("mainLightIntensity", 0.8)) * 600
    light1.data.size = 5
    light1.data.color = (float(color[0]), float(color[1]), float(color[2]))

    fill_az = float(lp.get("fillLightAzimuth", -135))
    fill_el = float(lp.get("fillLightElevation", 30))
    fill_pos = spherical_to_cartesian(fill_az, fill_el, 5.0)
    bpy.ops.object.light_add(type="AREA", location=tuple(fill_pos))
    light2 = bpy.context.active_object
    light2.data.energy = float(lp.get("fillLightIntensity", 0.3)) * 400
    light2.data.size = 3


def setup_render(width: int, height: int, lp: dict):
    scene = bpy.context.scene
    try:
        scene.render.engine = "BLENDER_EEVEE_NEXT"
    except Exception:
        try:
            scene.render.engine = "BLENDER_EEVEE"
        except Exception:
            scene.render.engine = "CYCLES"

    scene.render.resolution_x = int(width)
    scene.render.resolution_y = int(height)
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"

    exposure = float(lp.get("exposure", 1.0))
    if hasattr(scene, "view_settings"):
        try:
            scene.view_settings.exposure = (exposure - 1.0) * 2.0
        except Exception:
            pass


def camera_look_at(cam: bpy.types.Object, target: Vector):
    direction = target - cam.location
    if direction.length < 1e-8:
        return
    rot_quat = direction.to_track_quat("-Z", "Y")
    cam.rotation_euler = rot_quat.to_euler()


def main_blender():
    import argparse

    p = argparse.ArgumentParser()
    p.add_argument("--model", required=True)
    p.add_argument("--frames-dir", required=True)
    p.add_argument("--total-frames", type=int, required=True)
    p.add_argument("--width", type=int, default=512)
    p.add_argument("--height", type=int, default=512)
    p.add_argument("--light-json", default=None)
    args, _rest = p.parse_known_args(_argv_after_dd())

    lp = {
        "ambientIntensity": 0.6,
        "mainLightIntensity": 0.8,
        "mainLightColor": [1.0, 1.0, 1.0],
        "mainLightAzimuth": 45,
        "mainLightElevation": 45,
        "fillLightIntensity": 0.3,
        "fillLightAzimuth": -135,
        "fillLightElevation": 30,
        "exposure": 1.0,
    }
    if args.light_json and os.path.isfile(args.light_json):
        with open(args.light_json, "r", encoding="utf-8") as f:
            user_lp = json.load(f)
        if isinstance(user_lp, dict):
            lp.update({k: user_lp[k] for k in user_lp if k in lp})

    os.makedirs(args.frames_dir, exist_ok=True)

    clear_scene()

    ext = os.path.splitext(args.model)[1].lower()
    if ext not in (".glb", ".gltf"):
        print(json.dumps({"status": "error", "error": "blender_rotation_video expects .glb or .gltf"}))
        sys.exit(1)

    bpy.ops.import_scene.gltf(filepath=args.model)

    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if not meshes:
        print(json.dumps({"status": "error", "error": "No mesh after GLB import"}))
        sys.exit(1)

    center_scene_content_at_origin()
    target, extents = combined_mesh_bounds_world()
    max_dim = max(float(extents[i]) for i in range(3)) if extents.length > 0 else 1.0
    max_dim = max(max_dim, 1e-4)
    cam_dist = max_dim * 2.8

    setup_lights(lp)
    setup_render(args.width, args.height, lp)

    bpy.ops.object.camera_add(location=(cam_dist, 0, max_dim * 0.35))
    cam = bpy.context.active_object
    cam.data.clip_start = max(0.001, max_dim * 1e-4)
    cam.data.clip_end = max(1000.0, cam_dist * 20.0, max_dim * 50.0)
    bpy.context.scene.camera = cam
    camera_look_at(cam, target)

    scene = bpy.context.scene
    total = max(1, int(args.total_frames))

    for i in range(total):
        angle = (i / total) * 2 * math.pi
        x = cam_dist * math.cos(angle)
        y = cam_dist * math.sin(angle)
        z = max_dim * 0.35
        cam.location = Vector((x, y, z))
        camera_look_at(cam, target)

        scene.render.filepath = os.path.join(args.frames_dir, f"{i:04d}.png")
        bpy.ops.render.render(write_still=True)

    print(
        json.dumps(
            {
                "status": "ok",
                "frames_dir": os.path.abspath(args.frames_dir),
                "frame_count": total,
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    try:
        main_blender()
    except Exception as e:
        import traceback

        print(
            json.dumps(
                {"status": "error", "error": str(e), "traceback": traceback.format_exc()},
                ensure_ascii=False,
            )
        )
        sys.exit(1)
