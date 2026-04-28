# Shared by blender_*.py when run inside Blender. Keeps GLB export working across
# Blender 3.x (export_colors) and Blender 4.0+ / 5.x (vertex color API rename).
import bpy


def export_scene_gltf_glb(filepath: str) -> None:
    """Export the entire scene as binary glTF 2.0 (.glb).

    Vertex colors are **not** written to the GLB (``export_vertex_color='NONE'`` /
    ``export_colors=False``). That avoids malformed COLOR accessors from some meshes
    confusing downstream tools (e.g. trimesh merge). Base color / textures / UVs
    still export via materials.
    """
    common = {
        "filepath": filepath,
        "export_format": "GLB",
        "use_selection": False,
        "export_materials": "EXPORT",
        "export_texcoords": True,
        "export_normals": True,
        "export_cameras": False,
        "export_lights": False,
    }

    if bpy.app.version >= (4, 0, 0):
        bpy.ops.export_scene.gltf(
            **common,
            export_vertex_color="NONE",
            export_all_vertex_colors=False,
            export_active_vertex_color_when_no_material=False,
        )
    else:
        bpy.ops.export_scene.gltf(
            **common,
            export_colors=False,
        )
