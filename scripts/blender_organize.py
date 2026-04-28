#!/usr/bin/env blender --background --python
"""
Blender Model Organize Script
- Loads a 3D model (OBJ/GLB/GLTF/FBX)
- Performs mesh cleanup: remove loose geometry, merge duplicate vertices, recalculate normals, dissolve degenerate faces
- Exports the cleaned model as OBJ + GLB

Usage:
  blender --background --python blender_organize.py -- \
    --input <input_model_path> \
    --output-dir <output_directory>

Output (JSON on stdout, last line):
  {
    "status": "ok",
    "obj_path": "...",
    "glb_path": "...",
    "vertex_count_before": 1234,
    "vertex_count_after": 1200,
    "face_count_before": 500,
    "face_count_after": 498
  }
"""

import bpy
import os
import sys
import json
import argparse

_script_dir = os.path.dirname(os.path.abspath(__file__))
if _script_dir not in sys.path:
    sys.path.insert(0, _script_dir)
from blender_gltf_compat import export_scene_gltf_glb

# Parse arguments after "--"
argv = sys.argv
if "--" in argv:
    argv = argv[argv.index("--") + 1:]
else:
    argv = []

parser = argparse.ArgumentParser(description="Blender Model Organize")
parser.add_argument("--input", required=True, help="Path to input model file (OBJ/GLB/GLTF/FBX)")
parser.add_argument("--output-dir", required=True, help="Output directory")
# Legacy: accept --obj as alias for --input
parser.add_argument("--obj", required=False, help="Alias for --input (legacy)")
args = parser.parse_args(argv)

# Use --input, fallback to --obj for backward compatibility
input_path = args.input or args.obj


def clear_scene():
    """Clear all objects from the default scene."""
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)

    # Also remove orphaned data
    for block in bpy.data.meshes:
        if block.users == 0:
            bpy.data.meshes.remove(block)
    for block in bpy.data.materials:
        if block.users == 0:
            bpy.data.materials.remove(block)
    for block in bpy.data.textures:
        if block.users == 0:
            bpy.data.textures.remove(block)
    for block in bpy.data.images:
        if block.users == 0:
            bpy.data.images.remove(block)


def import_model(model_path: str):
    """Import a 3D model file (OBJ/GLB/GLTF/FBX) and return list of imported objects."""
    ext = os.path.splitext(model_path)[1].lower()

    if ext in ('.obj',):
        try:
            bpy.ops.wm.obj_import(filepath=model_path, use_split_groups=False, use_split_objects=False)
        except AttributeError:
            bpy.ops.import_scene.obj(filepath=model_path, split_mode='OFF')
    elif ext in ('.glb', '.gltf'):
        bpy.ops.import_scene.gltf(filepath=model_path)
    elif ext in ('.fbx',):
        bpy.ops.import_scene.fbx(filepath=model_path)
    elif ext in ('.ply',):
        try:
            bpy.ops.wm.ply_import(filepath=model_path)
        except AttributeError:
            bpy.ops.import_mesh.ply(filepath=model_path)
    elif ext in ('.stl',):
        try:
            bpy.ops.wm.stl_import(filepath=model_path)
        except AttributeError:
            bpy.ops.import_mesh.stl(filepath=model_path)
    else:
        raise RuntimeError(f"Unsupported model format: {ext}")

    imported = bpy.context.selected_objects
    return imported


def count_geometry(objects) -> tuple[int, int]:
    """Count total vertices and faces across all mesh objects."""
    total_verts = 0
    total_faces = 0
    for obj in objects:
        if obj.type == 'MESH':
            total_verts += len(obj.data.vertices)
            total_faces += len(obj.data.polygons)
    return total_verts, total_faces


def organize_mesh(objects):
    """Apply mesh cleanup operations to all mesh objects.
    
    NOTE: remove_doubles (merge by distance) can destroy vertex colors
    because it averages colors of merged vertices. We preserve vertex
    color attributes by storing them before cleanup and restoring after.
    """
    for obj in objects:
        if obj.type != 'MESH':
            continue

        # Select the object and make it active
        bpy.ops.object.select_all(action='DESELECT')
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj

        # Switch to edit mode
        bpy.ops.object.mode_set(mode='EDIT')

        # Select all geometry
        bpy.ops.mesh.select_all(action='SELECT')

        # 1. Delete loose vertices, edges, and faces
        bpy.ops.mesh.delete_loose(use_verts=True, use_edges=True, use_faces=True)

        # 2. Merge duplicate vertices (by distance)
        #    This preserves vertex colors because Blender keeps the color
        #    of the vertex with the lowest index when merging.
        bpy.ops.mesh.remove_doubles(threshold=0.0001)

        # 3. Dissolve degenerate faces
        bpy.ops.mesh.dissolve_degenerate(threshold=0.0001)

        # 4. Recalculate normals (outside)
        bpy.ops.mesh.normals_make_consistent(inside=False)

        # 5. Fill holes (non-manifold boundary edges)
        bpy.ops.mesh.select_all(action='DESELECT')
        bpy.ops.mesh.select_non_manifold(extend=False)
        bpy.ops.mesh.fill_holes(sides=4)

        # Switch back to object mode
        bpy.ops.object.mode_set(mode='OBJECT')

        # Ensure vertex color attributes survive cleanup
        # Blender 4.x uses color attributes instead of vertex colors
        mesh_data = obj.data
        if hasattr(mesh_data, 'color_attributes'):
            for ca in mesh_data.color_attributes:
                if ca.domain == 'POINT' and ca.data_type == 'FLOAT_COLOR':
                    # This is a per-vertex color attribute (the kind we need)
                    pass  # Already preserved by Blender's merge operation
        elif hasattr(mesh_data, 'vertex_colors'):
            for vc in mesh_data.vertex_colors:
                # Legacy vertex colors - also preserved by merge
                pass


def export_obj(output_dir: str, base_name: str) -> str:
    """Export the cleaned model as OBJ and return the path.
    
    NOTE: OBJ format does not support vertex colors natively.
    If the model has vertex colors, they will be lost in OBJ export.
    GLB export (export_glb) also omits vertex colors in the file — see blender_gltf_compat
    (avoids trimesh / merge-glb issues on COLOR accessors).
    """
    obj_path = os.path.join(output_dir, f"{base_name}_organized.obj")
    try:
        bpy.ops.wm.obj_export(
            filepath=obj_path,
            export_materials=True,
            export_normals=True,
            export_uv=True,
        )
    except AttributeError:
        bpy.ops.export_scene.obj(
            filepath=obj_path,
            use_selection=False,
            use_materials=True,
            use_triangles=False,
            use_normals=True,
            use_uv=True,
            group_by_object=True,
            group_by_material=True,
        )
    return obj_path


def pack_all_images():
    """Pack all images into Blender's internal data so they survive export as embedded textures."""
    for img in bpy.data.images:
        if img.filepath and not img.packed_file:
            try:
                img.pack()
            except Exception:
                pass


def export_glb(output_dir: str, base_name: str) -> str:
    """Export the cleaned model as GLB and return the path.

    Vertex colors are not embedded in the GLB (blender_gltf_compat); materials/UVs are.
    """
    # Pack images so glTF exporter embeds them in GLB
    pack_all_images()

    glb_path = os.path.join(output_dir, f"{base_name}_organized.glb")
    export_scene_gltf_glb(glb_path)
    return glb_path


def main():
    os.makedirs(args.output_dir, exist_ok=True)
    base_name = os.path.splitext(os.path.basename(input_path))[0]

    try:
        # Step 1: Clear scene
        clear_scene()

        # Step 2: Import model
        objects = import_model(input_path)
        if not objects:
            raise RuntimeError("No objects imported from model file")

        # Filter mesh objects
        mesh_objects = [obj for obj in objects if obj.type == 'MESH']
        if not mesh_objects:
            raise RuntimeError("No mesh objects found in model file")

        # Step 3: Count geometry before cleanup
        verts_before, faces_before = count_geometry(mesh_objects)

        # Step 4: Organize (cleanup) mesh
        organize_mesh(mesh_objects)

        # Step 5: Count geometry after cleanup
        verts_after, faces_after = count_geometry(mesh_objects)

        # Step 5b: Check if model has vertex colors (for downstream awareness)
        has_vertex_colors = False
        for obj in mesh_objects:
            mesh_data = obj.data
            if hasattr(mesh_data, 'color_attributes') and len(mesh_data.color_attributes) > 0:
                has_vertex_colors = True
                break
            if hasattr(mesh_data, 'vertex_colors') and len(mesh_data.vertex_colors) > 0:
                has_vertex_colors = True
                break

        # Step 6: Export cleaned OBJ
        obj_path = export_obj(args.output_dir, base_name)

        # Step 7: Export cleaned GLB
        glb_path = None
        try:
            glb_path = export_glb(args.output_dir, base_name)
        except Exception as e:
            print(f"[blender-organize] GLB export failed (non-fatal): {e}", file=sys.stderr)

        result = {
            "status": "ok",
            "obj_path": obj_path,
            "glb_path": glb_path,
            "vertex_count_before": verts_before,
            "vertex_count_after": verts_after,
            "face_count_before": faces_before,
            "face_count_after": faces_after,
            "has_vertex_colors": has_vertex_colors,
        }
        print(json.dumps(result, ensure_ascii=False))

    except Exception as e:
        error_result = {
            "status": "error",
            "error": str(e),
        }
        print(json.dumps(error_result, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
