from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Vector


VIEW_NAMES = (
    "front",
    "front_right",
    "right",
    "back_right",
    "back",
    "back_left",
    "left",
    "front_left",
    "high_three_quarter",
)


def _args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--resolution", type=int, default=1024)
    parser.add_argument("--selection", choices=("all", "auto_origin"), default="all")
    parser.add_argument("--background", choices=("studio", "black", "white", "transparent"), default="studio")
    parser.add_argument("--elevation", type=float, default=12.0)
    parser.add_argument("--padding", type=float, default=1.25)
    parser.add_argument("--engine", choices=("eevee", "cycles"), default="eevee")
    return parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])


def _remove_scene_helpers():
    for obj in list(bpy.data.objects):
        if obj.type in {"CAMERA", "LIGHT"}:
            bpy.data.objects.remove(obj, do_unlink=True)


def _clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (bpy.data.meshes, bpy.data.curves, bpy.data.materials, bpy.data.cameras, bpy.data.lights):
        for block in list(datablocks):
            if block.users == 0:
                datablocks.remove(block)


def _import_model(path: Path):
    suffix = path.suffix.lower()
    if suffix == ".fbx":
        bpy.ops.import_scene.fbx(filepath=str(path), use_image_search=True)
    elif suffix in {".glb", ".gltf"}:
        bpy.ops.import_scene.gltf(filepath=str(path))
    elif suffix == ".obj":
        if hasattr(bpy.ops.wm, "obj_import"):
            bpy.ops.wm.obj_import(filepath=str(path))
        else:
            bpy.ops.import_scene.obj(filepath=str(path))
    else:
        raise ValueError(f"Unsupported model type: {suffix}")


def _mesh_bounds():
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH" and not obj.hide_render]
    if not meshes:
        raise RuntimeError("模型中没有可渲染的网格（MESH）。")
    corners = [obj.matrix_world @ Vector(corner) for obj in meshes for corner in obj.bound_box]
    low = Vector((min(v.x for v in corners), min(v.y for v in corners), min(v.z for v in corners)))
    high = Vector((max(v.x for v in corners), max(v.y for v in corners), max(v.z for v in corners)))
    center = (low + high) * 0.5
    size = high - low
    radius = max(size.length * 0.5, max(size) * 0.5, 0.001)
    return meshes, center, size, radius


def _auto_select_origin_cluster():
    """Keep one spatially separated product cluster, preferring the one nearest the file origin."""
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH" and not obj.hide_render]
    if len(meshes) < 2:
        return

    object_bounds = []
    for obj in meshes:
        corners = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
        low = Vector((min(v.x for v in corners), min(v.y for v in corners), min(v.z for v in corners)))
        high = Vector((max(v.x for v in corners), max(v.y for v in corners), max(v.z for v in corners)))
        object_bounds.append((obj, low, high, (low + high) * 0.5))

    scene_low = Vector(
        (
            min(item[1].x for item in object_bounds),
            min(item[1].y for item in object_bounds),
            min(item[1].z for item in object_bounds),
        )
    )
    scene_high = Vector(
        (
            max(item[2].x for item in object_bounds),
            max(item[2].y for item in object_bounds),
            max(item[2].z for item in object_bounds),
        )
    )
    spans = scene_high - scene_low
    axis = max(range(3), key=lambda i: spans[i])
    if spans[axis] <= 0:
        return

    ordered = sorted(object_bounds, key=lambda item: item[3][axis])
    split_threshold = max(spans[axis] * 0.012, 1e-6)
    clusters = [[ordered[0]]]
    for previous, current in zip(ordered, ordered[1:]):
        gap = current[1][axis] - previous[2][axis]
        if gap > split_threshold:
            clusters.append([])
        clusters[-1].append(current)

    if len(clusters) <= 1:
        return
    chosen = min(
        clusters,
        key=lambda cluster: abs(
            (
                min(item[1][axis] for item in cluster)
                + max(item[2][axis] for item in cluster)
            )
            * 0.5
        ),
    )
    keep = {item[0] for item in chosen}
    for obj in meshes:
        obj.hide_render = obj not in keep
        obj.hide_viewport = obj not in keep


def _normalize_scene(center: Vector, radius: float):
    """Normalize arbitrary mm/cm/m model scales to a radius of one Blender unit."""
    transform = Matrix.Scale(1.0 / radius, 4) @ Matrix.Translation(-center)
    for obj in list(bpy.context.scene.objects):
        if obj.parent is None:
            obj.matrix_world = transform @ obj.matrix_world
    bpy.context.view_layer.update()


def _look_at(obj, point: Vector):
    obj.rotation_euler = (point - obj.location).to_track_quat("-Z", "Y").to_euler()


def _area_light(name, location, energy, size, color, target):
    data = bpy.data.lights.new(name=name, type="AREA")
    data.energy = energy
    data.shape = "DISK"
    data.size = size
    data.color = color
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    obj.location = location
    _look_at(obj, target)
    return obj


def _setup_lighting(center: Vector, radius: float):
    # Large softboxes produce controlled jewelry highlights instead of harsh point-light speckles.
    _area_light(
        "Key_Softbox",
        center + Vector((radius * 2.4, -radius * 2.8, radius * 2.6)),
        1000.0,
        radius * 2.6,
        (1.0, 0.92, 0.82),
        center,
    )
    _area_light(
        "Fill_Softbox",
        center + Vector((-radius * 2.8, -radius * 1.2, radius * 1.2)),
        700.0,
        radius * 2.2,
        (0.72, 0.82, 1.0),
        center,
    )
    _area_light(
        "Rim_Strip",
        center + Vector((0.0, radius * 2.5, radius * 2.8)),
        1200.0,
        radius * 1.8,
        (1.0, 1.0, 1.0),
        center,
    )
    _area_light(
        "Front_Fill",
        center + Vector((0.0, -radius * 3.0, 0.0)),
        450.0,
        radius * 3.0,
        (1.0, 1.0, 1.0),
        center,
    )


def _setup_world(background: str):
    world = bpy.data.worlds.new("SeedanceWorld") if bpy.context.scene.world is None else bpy.context.scene.world
    bpy.context.scene.world = world
    world.use_nodes = True
    node = world.node_tree.nodes.get("Background")
    colors = {
        "studio": (0.018, 0.018, 0.022, 1.0),
        "black": (0.0, 0.0, 0.0, 1.0),
        "white": (0.92, 0.92, 0.92, 1.0),
        "transparent": (0.0, 0.0, 0.0, 1.0),
    }
    node.inputs["Color"].default_value = colors[background]
    node.inputs["Strength"].default_value = 0.22 if background == "studio" else 0.12


def main():
    args = _args()
    model_path = Path(args.model).resolve()
    output_dir = Path(args.output).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    if model_path.suffix.lower() == ".blend":
        _remove_scene_helpers()
    else:
        _clear_scene()
        _import_model(model_path)

    if args.selection == "auto_origin":
        _auto_select_origin_cluster()

    _, center, _, radius = _mesh_bounds()
    _normalize_scene(center, radius)
    _, center, size, radius = _mesh_bounds()
    scene = bpy.context.scene
    if args.engine == "eevee":
        try:
            scene.render.engine = "BLENDER_EEVEE_NEXT"
        except TypeError:
            scene.render.engine = "BLENDER_EEVEE"
    else:
        scene.render.engine = "CYCLES"
    if args.engine == "eevee":
        scene.render.image_settings.file_format = "PNG"
    else:
        scene.cycles.samples = 128
        scene.cycles.use_denoising = True
        try:
            scene.cycles.device = "GPU"
        except Exception:
            pass

    scene.render.resolution_x = args.resolution
    scene.render.resolution_y = args.resolution
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA" if args.background == "transparent" else "RGB"
    scene.render.film_transparent = args.background == "transparent"
    scene.render.use_file_extension = True
    scene.render.image_settings.color_depth = "8"
    scene.render.resolution_percentage = 100

    try:
        scene.view_settings.look = "AgX - Medium High Contrast"
    except Exception:
        pass
    scene.view_settings.exposure = 1.0

    _setup_world(args.background)
    _setup_lighting(center, radius)

    camera_data = bpy.data.cameras.new("SeedanceCamera")
    camera = bpy.data.objects.new("SeedanceCamera", camera_data)
    bpy.context.collection.objects.link(camera)
    scene.camera = camera
    camera.data.lens = 70.0
    camera.data.sensor_width = 36.0

    # For a square frame the vertical and horizontal FOV are equal.
    half_fov = camera.data.angle * 0.5
    distance = (radius * args.padding) / max(math.sin(half_fov), 0.1)
    distance = max(distance, max(size) * 1.5, 0.01)

    views = [(index * 45.0, args.elevation) for index in range(8)]
    views.append((315.0, min(args.elevation + 28.0, 75.0)))

    for index, ((azimuth, elevation), name) in enumerate(zip(views, VIEW_NAMES), 1):
        az = math.radians(azimuth - 90.0)
        el = math.radians(elevation)
        horizontal = distance * math.cos(el)
        camera.location = center + Vector(
            (
                horizontal * math.cos(az),
                horizontal * math.sin(az),
                distance * math.sin(el),
            )
        )
        _look_at(camera, center)
        scene.render.filepath = str(output_dir / f"{index:02d}_{name}.png")
        bpy.ops.render.render(write_still=True)


if __name__ == "__main__":
    main()
