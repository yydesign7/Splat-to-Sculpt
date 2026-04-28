#!/usr/bin/env blender --background --python
"""
Blender Material Processing Script
- Loads an OBJ model
- Identifies mesh groups (layers)
- Creates a Principled BSDF material with configurable parameters
- Applies the material to a specified group (or all groups)
- Exports the modified model as OBJ + GLB
- Optionally renders a preview image

Usage:
  blender --background --python blender_material.py -- \
    --obj <input_obj_path> \
    --output-dir <output_directory> \
    [--group <group_name>] \
    [--texture <texture_image_path>] \
    [--list-groups] \
    [--material-params <json_string>] \
    [--base-color-modified] \
    [--render]

Material Params JSON format:
  {
    "base_color": [r, g, b],       // 0-1 range
    "metallic": 0.0,               // 0-1
    "roughness": 0.5,              // 0-1
    "emissive_color": [r, g, b],   // 0-1 range
    "emissive_strength": 0.0,      // 0-10
    "alpha": 1.0,                  // 0-1
    "normal_scale": 1.0,            // 0-5
    "base_color_modified": false
  }

Per-layer file (--layer-params): JSON object mapping object/mesh name -> material params (as above).
When set, all listed layers are applied in a single import/export pass.

Output (JSON on stdout, last line):
  {
    "status": "ok",
    "output_dir": "...",
    "obj_path": "...",
    "glb_path": "...",
    "render_path": "...",
    "groups": ["group1", "group2", ...],
    "applied_group": "group1"
  }
"""

import bpy
import os
import sys
import json
import argparse
import tempfile

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

parser = argparse.ArgumentParser(description="Blender Material Processing")
parser.add_argument("--obj", required=True, help="Path to input OBJ file")
parser.add_argument("--texture", required=False, help="Path to texture image (PNG/JPG)")
parser.add_argument("--group", required=False, default="all", help="Group name to apply material to, or 'all'")
parser.add_argument("--output-dir", required=True, help="Output directory")
parser.add_argument("--list-groups", action="store_true", help="Only list groups, don't process")
parser.add_argument("--material-params", required=False, default=None, help="JSON string with Principled BSDF parameters")
parser.add_argument("--light-params", required=False, default=None, help="JSON string with light parameters")
parser.add_argument("--base-color-modified", action="store_true", help="Whether user explicitly changed base_color (if not, modify existing material in-place to preserve texture)")
parser.add_argument("--layer-params", required=False, default=None, help="Path to JSON file: mesh object name -> material params (applies all in one run)")
parser.add_argument("--render", action="store_true", help="Render a preview image after applying material")
args = parser.parse_args(argv)

# Default material parameters
DEFAULT_PARAMS = {
    "base_color": [0.8, 0.75, 0.7],
    "metallic": 0.0,
    "roughness": 0.5,
    "emissive_color": [0.0, 0.0, 0.0],
    "emissive_strength": 0.0,
    "alpha": 1.0,
    "normal_scale": 1.0,
    "base_color_modified": False,
}

# Default light parameters
DEFAULT_LIGHT_PARAMS = {
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


def spherical_to_cartesian(azimuth_deg: float, elevation_deg: float, radius: float = 5.0):
    """Convert spherical coordinates (azimuth, elevation in degrees) to cartesian (x, y, z)."""
    import math
    az = math.radians(azimuth_deg)
    el = math.radians(elevation_deg)
    x = radius * math.cos(el) * math.cos(az)
    y = radius * math.cos(el) * math.sin(az)
    z = radius * math.sin(el)
    return (x, y, z)


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


def import_obj(obj_path: str):
    """Import a 3D model file (OBJ/GLB/GLTF/FBX/PLY) and return list of imported objects."""
    ext = os.path.splitext(obj_path)[1].lower()

    if ext in ('.obj',):
        try:
            bpy.ops.wm.obj_import(filepath=obj_path, use_split_groups=True, use_split_objects=True)
        except AttributeError:
            bpy.ops.import_scene.obj(filepath=obj_path, split_mode='GROUP')
    elif ext in ('.glb', '.gltf'):
        bpy.ops.import_scene.gltf(filepath=obj_path)
    elif ext in ('.fbx',):
        bpy.ops.import_scene.fbx(filepath=obj_path)
    elif ext in ('.ply',):
        try:
            bpy.ops.wm.ply_import(filepath=obj_path)
        except AttributeError:
            bpy.ops.import_mesh.ply(filepath=obj_path)
    elif ext in ('.stl',):
        try:
            bpy.ops.wm.stl_import(filepath=obj_path)
        except AttributeError:
            bpy.ops.import_mesh.stl(filepath=obj_path)
    else:
        # Fallback: try OBJ import
        try:
            bpy.ops.wm.obj_import(filepath=obj_path, use_split_groups=True, use_split_objects=True)
        except AttributeError:
            bpy.ops.import_scene.obj(filepath=obj_path, split_mode='GROUP')

    imported = bpy.context.selected_objects
    return imported


def list_groups(objects) -> list[str]:
    """List all group/object names in the imported model."""
    groups = []
    for obj in objects:
        if obj.type == 'MESH':
            groups.append(obj.name)
    return groups


def parse_material_params(params_json: str | None) -> dict:
    """Parse and merge material parameters from JSON string."""
    params = DEFAULT_PARAMS.copy()
    if params_json:
        try:
            custom = json.loads(params_json)
            params.update(custom)
        except json.JSONDecodeError:
            pass
    return params


def parse_light_params(params_json: str | None) -> dict:
    """Parse and merge light parameters from JSON string."""
    params = DEFAULT_LIGHT_PARAMS.copy()
    if params_json:
        try:
            custom = json.loads(params_json)
            params.update(custom)
        except json.JSONDecodeError:
            pass
    return params


def find_bsdf_node(material: bpy.types.Material) -> bpy.types.Node | None:
    """Find the Principled BSDF node in a material's node tree."""
    if not material.use_nodes:
        return None
    for node in material.node_tree.nodes:
        if node.type == 'BSDF_PRINCIPLED':
            return node
    return None


def modify_existing_material(material: bpy.types.Material, params: dict) -> None:
    """Modify an existing material's Principled BSDF parameters in-place, preserving texture connections.
    
    This only updates non-color parameters (metallic, roughness, emissive, alpha).
    It does NOT touch the Base Color input if a texture is connected to it,
    which preserves the original model's texture/color.
    """
    bsdf = find_bsdf_node(material)
    if not bsdf:
        # No Principled BSDF found; create one
        material.use_nodes = True
        nodes = material.node_tree.nodes
        links = material.node_tree.links
        # Remove all existing nodes
        for node in nodes:
            nodes.remove(node)
        bsdf = nodes.new('ShaderNodeBsdfPrincipled')
        bsdf.location = (0, 0)
        output = nodes.new('ShaderNodeOutputMaterial')
        output.location = (400, 0)
        links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])
        # No texture — set base_color from params
        base_color = params.get("base_color", [0.8, 0.75, 0.7])
        bsdf.inputs['Base Color'].default_value = (base_color[0], base_color[1], base_color[2], 1.0)

    # Update non-color parameters (always safe to change)
    bsdf.inputs['Metallic'].default_value = float(params.get("metallic", 0.0))
    bsdf.inputs['Roughness'].default_value = float(params.get("roughness", 0.5))

    # Emissive
    emissive_color = params.get("emissive_color", [0.0, 0.0, 0.0])
    bsdf.inputs['Emission Color'].default_value = (emissive_color[0], emissive_color[1], emissive_color[2], 1.0)
    bsdf.inputs['Emission Strength'].default_value = float(params.get("emissive_strength", 0.0))

    # Alpha
    alpha = float(params.get("alpha", 1.0))
    bsdf.inputs['Alpha'].default_value = alpha
    if alpha < 1.0 and hasattr(material, 'blend_method'):
        material.blend_method = 'BLEND'


def create_principled_material(
    material_name: str,
    texture_path: str | None,
    params: dict,
) -> bpy.types.Material:
    """Create a NEW Principled BSDF material with configurable parameters and optional texture.
    
    Used when the user has explicitly changed base_color (base_color_modified=True),
    or when the model has no existing material to modify.
    """
    mat = bpy.data.materials.new(name=material_name)
    mat.use_nodes = True

    nodes = mat.node_tree.nodes
    links = mat.node_tree.links

    # Remove default nodes
    for node in nodes:
        nodes.remove(node)

    # Create Principled BSDF node
    bsdf = nodes.new('ShaderNodeBsdfPrincipled')
    bsdf.location = (0, 0)

    # Apply parameters
    base_color = params.get("base_color", [0.8, 0.75, 0.7])
    bsdf.inputs['Base Color'].default_value = (base_color[0], base_color[1], base_color[2], 1.0)
    bsdf.inputs['Metallic'].default_value = float(params.get("metallic", 0.0))
    bsdf.inputs['Roughness'].default_value = float(params.get("roughness", 0.5))

    # Emissive
    emissive_color = params.get("emissive_color", [0.0, 0.0, 0.0])
    bsdf.inputs['Emission Color'].default_value = (emissive_color[0], emissive_color[1], emissive_color[2], 1.0)
    bsdf.inputs['Emission Strength'].default_value = float(params.get("emissive_strength", 0.0))

    # Alpha
    alpha = float(params.get("alpha", 1.0))
    bsdf.inputs['Alpha'].default_value = alpha

    # Handle transparency
    if alpha < 1.0:
        mat.blend_method = 'BLEND' if hasattr(mat, 'blend_method') else None

    # Create Material Output node
    output = nodes.new('ShaderNodeOutputMaterial')
    output.location = (400, 0)

    # Link BSDF to output
    links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])

    # Normal scale
    normal_scale = float(params.get("normal_scale", 1.0))

    # If texture is provided, add Image Texture node
    if texture_path and os.path.exists(texture_path):
        img_tex = nodes.new('ShaderNodeTexImage')
        img_tex.location = (-400, 0)
        img_tex.label = "Material Texture"

        # Load the image and pack it into .blend for reliable GLB embedding
        img = bpy.data.images.load(texture_path)
        img.colorspace_settings.name = 'sRGB'
        try:
            img.pack()
        except Exception:
            pass
        img_tex.image = img

        # Link texture to Base Color — this is the primary use for glTF export
        links.new(img_tex.outputs['Color'], bsdf.inputs['Base Color'])

        # Detect texture type by filename
        tex_lower = texture_path.lower()
        if 'normal' in tex_lower:
            normal_map = nodes.new('ShaderNodeNormalMap')
            normal_map.location = (-200, -200)
            normal_map.inputs['Strength'].default_value = normal_scale
            links.new(img_tex.outputs['Color'], normal_map.inputs['Color'])
            links.new(normal_map.outputs['Normal'], bsdf.inputs['Normal'])
            img.colorspace_settings.name = 'Non-Color'
        elif 'rough' in tex_lower:
            img.colorspace_settings.name = 'Non-Color'
            links.new(img_tex.outputs['Color'], bsdf.inputs['Roughness'])
        elif 'metal' in tex_lower:
            img.colorspace_settings.name = 'Non-Color'
            links.new(img_tex.outputs['Color'], bsdf.inputs['Metallic'])
        elif 'emissive' in tex_lower:
            img.colorspace_settings.name = 'sRGB'
            links.new(img_tex.outputs['Color'], bsdf.inputs['Emission Color'])
        elif 'alpha' in tex_lower or 'opacity' in tex_lower:
            img.colorspace_settings.name = 'Non-Color'
            links.new(img_tex.outputs['Color'], bsdf.inputs['Alpha'])

        # Add Mapping + Texture Coordinate for better UV
        tex_coord = nodes.new('ShaderNodeTexCoord')
        tex_coord.location = (-800, 0)
        mapping = nodes.new('ShaderNodeMapping')
        mapping.location = (-600, 0)

        links.new(tex_coord.outputs['UV'], mapping.inputs['Vector'])
        links.new(mapping.outputs['Vector'], img_tex.inputs['Vector'])

    # If no texture was applied, the solid base_color default_value set above will be used

    return mat


def apply_material_to_group(objects, group_name: str, material: bpy.types.Material):
    """Apply material to objects matching the group name (case-insensitive)."""
    applied = False
    group_lower = group_name.lower()
    for obj in objects:
        if obj.type != 'MESH':
            continue

        # Apply to specific group (case-insensitive) or all
        if group_name == 'all' or obj.name == group_name or obj.name.lower() == group_lower:
            if obj.data.materials:
                for i in range(len(obj.data.materials)):
                    obj.data.materials[i] = material
            else:
                obj.data.materials.append(material)
            applied = True

    return applied


def merge_material_dict(custom: dict) -> dict:
    """Merge one layer's material params with DEFAULT_PARAMS (including base_color_modified)."""
    p = DEFAULT_PARAMS.copy()
    p.update(custom)
    return p


def find_params_for_object_name(obj_name: str, layer_map: dict) -> dict | None:
    """Case-insensitive resolve: layer map keys are mesh object names from the app."""
    if obj_name in layer_map:
        return layer_map[obj_name]
    oln = obj_name.lower()
    for k, v in layer_map.items():
        if isinstance(k, str) and k.lower() == oln:
            return v
    return None


def apply_layer_params_to_all_meshes(objects, layer_map: dict, texture_path: str | None) -> list[str]:
    """Apply per-mesh material params in one pass. Skips objects with no entry in layer_map.
    Returns the list of object names that were updated.
    """
    applied: list[str] = []
    for obj in objects:
        if obj.type != "MESH":
            continue
        raw = find_params_for_object_name(obj.name, layer_map)
        if raw is None:
            continue
        p = merge_material_dict(raw if isinstance(raw, dict) else {})
        if not p.get("base_color_modified", False):
            mod = modify_materials_in_place(objects, obj.name, p)
            if not mod:
                material = create_principled_material(
                    f"Material_{obj.name}",
                    texture_path,
                    p,
                )
                apply_material_to_group(objects, obj.name, material)
        else:
            material = create_principled_material(
                f"Material_{obj.name}",
                texture_path,
                p,
            )
            apply_material_to_group(objects, obj.name, material)
        applied.append(obj.name)
    return applied


def modify_materials_in_place(objects, group_name: str, params: dict) -> bool:
    """Modify existing materials on target objects in-place, preserving texture connections.
    
    This is the preferred path when the user hasn't changed base_color — it keeps
    the original texture/image connections intact and only updates other BSDF parameters.
    Returns True if any material was modified.
    """
    modified = False
    group_lower = group_name.lower()
    for obj in objects:
        if obj.type != 'MESH':
            continue
        if group_name != 'all' and obj.name != group_name and obj.name.lower() != group_lower:
            continue

        for slot in obj.material_slots:
            mat = slot.material
            if mat:
                modify_existing_material(mat, params)
                modified = True

    return modified


def setup_render_scene(light_params: dict | None = None):
    """Setup lighting and camera for rendering a preview."""
    lp = light_params or DEFAULT_LIGHT_PARAMS

    # Add camera
    bpy.ops.object.camera_add(location=(0, -4, 2), rotation=(1.1, 0, 0))
    camera = bpy.context.active_object
    bpy.context.scene.camera = camera

    # Add ambient light (sun or area for environment)
    bpy.ops.object.light_add(type='SUN', location=(0, 0, 10))
    ambient = bpy.context.active_object
    ambient.data.energy = lp.get("ambientIntensity", 0.6) * 3.0  # scale up for Blender
    color = lp.get("mainLightColor", [1.0, 1.0, 1.0])
    ambient.data.color = (color[0], color[1], color[2])

    # Add main area light — position from spherical coordinates
    main_az = lp.get("mainLightAzimuth", 45)
    main_el = lp.get("mainLightElevation", 45)
    main_pos = spherical_to_cartesian(main_az, main_el, radius=5.0)
    bpy.ops.object.light_add(type='AREA', location=main_pos)
    light1 = bpy.context.active_object
    light1.data.energy = lp.get("mainLightIntensity", 0.8) * 600
    light1.data.size = 5
    light1.data.color = (color[0], color[1], color[2])

    # Add fill light — position from spherical coordinates
    fill_az = lp.get("fillLightAzimuth", -135)
    fill_el = lp.get("fillLightElevation", 30)
    fill_pos = spherical_to_cartesian(fill_az, fill_el, radius=5.0)
    bpy.ops.object.light_add(type='AREA', location=fill_pos)
    light2 = bpy.context.active_object
    light2.data.energy = lp.get("fillLightIntensity", 0.3) * 400
    light2.data.size = 3

    # Use EEVEE — Cycles requires OpenImageDenoiser which is unavailable in sandbox
    # Try EEVEE_NEXT first (Blender 4.2+), fall back to EEVEE (Blender 4.0)
    try:
        bpy.context.scene.render.engine = 'BLENDER_EEVEE_NEXT'
    except Exception:
        bpy.context.scene.render.engine = 'BLENDER_EEVEE'

    bpy.context.scene.render.resolution_x = 512
    bpy.context.scene.render.resolution_y = 512
    bpy.context.scene.render.resolution_percentage = 100

    # EEVEE settings
    if hasattr(bpy.context.scene, 'eevee'):
        bpy.context.scene.eevee.taa_render_samples = 32

    # Apply exposure
    exposure = lp.get("exposure", 1.0)
    if hasattr(bpy.context.scene, 'view_settings'):
        try:
            bpy.context.scene.view_settings.exposure = (exposure - 1.0) * 2.0
        except Exception:
            pass

    # Frame all objects
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.view3d.camera_to_view_selected()


def render_preview(output_dir: str, base_name: str) -> str:
    """Render a preview image and return the path."""
    render_path = os.path.join(output_dir, f"{base_name}_preview.png")
    bpy.context.scene.render.filepath = render_path
    bpy.context.scene.render.image_settings.file_format = 'PNG'
    bpy.context.scene.render.image_settings.color_mode = 'RGBA'
    bpy.ops.render.render(write_still=True)
    return render_path


def pack_all_images():
    """Pack all images into Blender's internal data so they survive export as embedded textures."""
    for img in bpy.data.images:
        if img.filepath and not img.packed_file:
            try:
                img.pack()
            except Exception:
                pass  # Some images cannot be packed (e.g. render results)


def export_model(output_dir: str, base_name: str) -> dict:
    """Export the modified model as OBJ and GLB."""
    result = {}

    # Pack images into .blend so glTF exporter embeds them in GLB
    pack_all_images()

    # Export OBJ
    obj_path = os.path.join(output_dir, f"{base_name}_material.obj")
    try:
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
        result['obj_path'] = obj_path
    except Exception as e:
        result['obj_error'] = str(e)

    # Export GLB — materials/textures/UVs; vertex colors omitted (blender_gltf_compat)
    glb_path = os.path.join(output_dir, f"{base_name}_material.glb")
    try:
        export_scene_gltf_glb(glb_path)
        result['glb_path'] = glb_path
    except Exception as e:
        result['glb_error'] = str(e)

    return result


def main():
    os.makedirs(args.output_dir, exist_ok=True)
    base_name = os.path.splitext(os.path.basename(args.obj))[0]

    try:
        # Step 1: Clear scene
        clear_scene()

        # Step 2: Import model
        objects = import_obj(args.obj)
        if not objects:
            raise RuntimeError("No objects imported from model file")

        # Step 3: List groups
        groups = list_groups(objects)

        # If only listing groups, return them
        if args.list_groups:
            result = {
                "status": "ok",
                "groups": groups,
                "output_dir": args.output_dir,
            }
            print(json.dumps(result, ensure_ascii=False))
            return

        # Shared: lights for final render
        light_params = parse_light_params(args.light_params)

        # Step 3b: Multi-layer (single Blender run with full per-object params)
        if args.layer_params and os.path.isfile(args.layer_params):
            with open(args.layer_params, "r", encoding="utf-8") as f:
                layer_map = json.load(f)
            if not isinstance(layer_map, dict):
                layer_map = {}
            texture_path = args.texture if args.texture else None
            applied = apply_layer_params_to_all_meshes(objects, layer_map, texture_path)
            export_result = export_model(args.output_dir, base_name)
            result = {
                "status": "ok",
                "output_dir": args.output_dir,
                "groups": groups,
                "applied_group": applied[0] if applied else None,
                "applied_groups": applied,
                "obj_path": export_result.get("obj_path"),
                "glb_path": export_result.get("glb_path"),
                "glb_error": export_result.get("glb_error"),
            }
            if args.render:
                setup_render_scene(light_params)
                render_path = render_preview(args.output_dir, base_name)
                result["render_path"] = render_path
            print(json.dumps(result, ensure_ascii=False))
            return

        # Step 4: Parse material parameters (single-group / legacy)
        params = parse_material_params(args.material_params)

        # Step 5: Decide how to apply the material
        if not args.base_color_modified:
            # User hasn't changed base_color → modify existing materials in-place
            # This preserves original texture/color connections
            modified = modify_materials_in_place(objects, args.group, params)
            if not modified:
                # No existing materials found; create a new one
                texture_path = args.texture if args.texture else None
                material = create_principled_material(
                    f"Material_{args.group}",
                    texture_path,
                    params,
                )
                apply_material_to_group(objects, args.group, material)
        else:
            # User explicitly changed base_color → create new material with the chosen color
            texture_path = args.texture if args.texture else None
            material = create_principled_material(
                f"Material_{args.group}",
                texture_path,
                params,
            )
            apply_material_to_group(objects, args.group, material)

        # Step 7: Export modified model
        export_result = export_model(args.output_dir, base_name)

        result = {
            "status": "ok",
            "output_dir": args.output_dir,
            "groups": groups,
            "applied_group": args.group,
            "obj_path": export_result.get('obj_path'),
            "glb_path": export_result.get('glb_path'),
            "glb_error": export_result.get('glb_error'),
        }

        # Step 8: Render preview if requested
        if args.render:
            setup_render_scene(light_params)
            render_path = render_preview(args.output_dir, base_name)
            result['render_path'] = render_path

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
