#!/usr/bin/env python3
"""
GLB + PNG Processing Pipeline
Processes GLB models (which may contain multiple meshes with embedded textures)
and applies a new PNG texture, then exports the result.

Unlike obj_process.py which uses force="mesh", this script properly handles
GLB's Scene structure with multiple geometries.

Usage:
  python3 glb_process.py \
    --input <glb_file_path> \
    --texture <png_texture_path> \
    --output-dir <output_directory>

Output (JSON on stdout, last line):
  {
    "status": "ok",
    "output_dir": "<output_dir>",
    "new_glb_path": "<path>",
    "new_model_path": "<path>",
    "render_path": "<path>",
    "textures": { ... },
    "metadata_path": "<path>",
    "annotations": { "available": false, "reason": "YOLO/SAM not installed" }
  }
"""

import os
import sys
import json
import argparse
import traceback

# Force EGL for headless rendering
os.environ["PYOPENGL_PLATFORM"] = "egl"

import trimesh
import pyrender
import numpy as np
import cv2
from PIL import Image
from pathlib import Path

# Attempt to import YOLO + SAM (optional)
HAS_YOLO = False
HAS_SAM = False
try:
    from ultralytics import YOLO
    HAS_YOLO = True
except ImportError:
    pass
try:
    from segment_anything import sam_model_registry, SamPredictor
    HAS_SAM = True
except ImportError:
    pass


# ===================== 1. Layered Texture Extraction =====================
def extract_textures_from_scene(scene, output_dir, model_name):
    """Extract layered textures from all meshes in a GLB scene."""
    textures = {}

    for geom_name, mesh in scene.geometry.items():
        prefix = geom_name if geom_name else model_name

        try:
            if hasattr(mesh.visual, "material") and hasattr(mesh.visual.material, "baseColorTexture"):
                if mesh.visual.material.baseColorTexture is not None:
                    diffuse = mesh.visual.material.baseColorTexture
                    path = os.path.join(output_dir, f"{prefix}_diffuse.png")
                    Image.fromarray(diffuse).save(path)
                    textures[f"{prefix}_diffuse"] = path
        except Exception:
            pass

        try:
            if hasattr(mesh.visual, "material") and hasattr(mesh.visual.material, "normalTexture"):
                if mesh.visual.material.normalTexture is not None:
                    normal = mesh.visual.material.normalTexture
                    path = os.path.join(output_dir, f"{prefix}_normal.png")
                    Image.fromarray(normal).save(path)
                    textures[f"{prefix}_normal"] = path
        except Exception:
            pass

        try:
            if hasattr(mesh.visual, "material") and hasattr(mesh.visual.material, "metallicRoughnessTexture"):
                if mesh.visual.material.metallicRoughnessTexture is not None:
                    metal = mesh.visual.material.metallicRoughnessTexture
                    path = os.path.join(output_dir, f"{prefix}_metal_rough.png")
                    Image.fromarray(metal).save(path)
                    textures[f"{prefix}_metal_rough"] = path
        except Exception:
            pass

    return textures


# ===================== 2. Metadata Export =====================
def export_metadata(scene, texture_paths, output_dir, model_name):
    """Export complete metadata JSON for the GLB scene."""
    total_vertices = 0
    total_faces = 0
    for mesh in scene.geometry.values():
        total_vertices += len(mesh.vertices)
        if hasattr(mesh, 'faces'):
            total_faces += len(mesh.faces)

    # Get bounding box from the whole scene
    bounding_box = scene.bounds
    extents = bounding_box[1] - bounding_box[0]

    metadata = {
        "model_info": {
            "name": model_name,
            "file_type": "glb",
            "geometry_count": len(scene.geometry),
            "geometry_names": list(scene.geometry.keys()),
            "vertex_count": int(total_vertices),
            "face_count": int(total_faces),
        },
        "scale_metadata": {
            "scale_factor": 1.0,
            "unit": "meter",
            "bounding_box_size": [float(x) for x in extents],
        },
        "orientation_metadata": {
            "forward_axis": "Z",
            "up_axis": "Y",
            "rotation_matrix": np.eye(4).tolist(),
        },
        "material_metadata": {
            "has_texture": len(texture_paths) > 0,
            "texture_paths": {k: os.path.basename(v) for k, v in texture_paths.items()},
        },
    }

    meta_path = os.path.join(output_dir, f"{model_name}_metadata.json")
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2, ensure_ascii=False)
    return meta_path


# ===================== 3. Render Model =====================
def render_model(mesh, output_path, image_size=(1024, 1024)):
    """Render a high-quality 2D image using pyrender with EGL fallback to matplotlib."""
    # --- Try pyrender with texture ---
    try:
        render_mesh = pyrender.Mesh.from_trimesh(mesh)
        scene = pyrender.Scene(bg_color=[26, 26, 46])
        scene.add(render_mesh)
        camera = pyrender.PerspectiveCamera(yfov=np.pi / 3.0)
        bbox = mesh.bounding_box
        extents = bbox.extents
        max_dim = max(float(x) for x in extents) if len(extents) > 0 else 1.0
        cam_dist = max_dim * 2.5
        cam_pose = np.array([
            [1, 0, 0, 0],
            [0, 1, 0, 0],
            [0, 0, 1, cam_dist],
            [0, 0, 0, 1]
        ])
        scene.add(camera, pose=cam_pose)
        light = pyrender.DirectionalLight(color=[1.0, 1.0, 1.0], intensity=3.0)
        scene.add(light, pose=cam_pose)
        renderer = pyrender.OffscreenRenderer(image_size[0], image_size[1])
        color, _ = renderer.render(scene)
        Image.fromarray(color).save(output_path)
        renderer.delete()
        return output_path
    except Exception:
        pass

    # --- Try pyrender with ColorVisuals fallback ---
    try:
        from trimesh.visual import ColorVisuals
        mesh_color = mesh.copy()
        try:
            colors = mesh.visual.face_colors
            mesh_color.visual = ColorVisuals(mesh_color, face_colors=colors)
        except Exception:
            mesh_color.visual = ColorVisuals(mesh_color)

        render_mesh = pyrender.Mesh.from_trimesh(mesh_color, smooth=False)
        scene = pyrender.Scene(bg_color=[26, 26, 46])
        scene.add(render_mesh)
        camera = pyrender.PerspectiveCamera(yfov=np.pi / 3.0)
        bbox = mesh.bounding_box
        extents = bbox.extents
        max_dim = max(float(x) for x in extents) if len(extents) > 0 else 1.0
        cam_dist = max_dim * 2.5
        cam_pose = np.array([
            [1, 0, 0, 0],
            [0, 1, 0, 0],
            [0, 0, 1, cam_dist],
            [0, 0, 0, 1]
        ])
        scene.add(camera, pose=cam_pose)
        light = pyrender.DirectionalLight(color=[1.0, 1.0, 1.0], intensity=3.0)
        scene.add(light, pose=cam_pose)
        renderer = pyrender.OffscreenRenderer(image_size[0], image_size[1])
        color, _ = renderer.render(scene)
        Image.fromarray(color).save(output_path)
        renderer.delete()
        return output_path
    except Exception:
        pass

    # --- Fallback: matplotlib (pure software rendering, no EGL needed) ---
    try:
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
        from mpl_toolkits.mplot3d.art3d import Poly3DCollection

        fig = plt.figure(figsize=(10, 10), facecolor='#1a1a2e')
        ax = fig.add_subplot(111, projection='3d', facecolor='#1a1a2e')

        vertices = mesh.vertices
        faces = mesh.faces
        mesh_poly = Poly3DCollection(vertices[faces], alpha=0.9)

        try:
            colors = mesh.visual.face_colors
            mesh_poly.set_facecolor(colors / 255.0)
        except Exception:
            mesh_poly.set_facecolor([0.5, 0.45, 0.4, 0.9])

        mesh_poly.set_edgecolor([0.3, 0.3, 0.3, 0.1])
        ax.add_collection3d(mesh_poly)

        scale = float(mesh.extents.max())
        center = mesh.centroid
        ax.set_xlim(center[0] - scale, center[0] + scale)
        ax.set_ylim(center[1] - scale, center[1] + scale)
        ax.set_zlim(center[2] - scale, center[2] + scale)
        ax.set_axis_off()
        ax.view_init(elev=25, azim=45)

        plt.savefig(output_path, dpi=150, bbox_inches='tight', facecolor=fig.get_facecolor())
        plt.close(fig)
        return output_path
    except Exception as e:
        raise RuntimeError(f"All rendering methods failed: {e}")


# ===================== 4. YOLOv8 + SAM (optional) =====================
YOLO_MODEL = "yolov8n-seg.pt"
SAM_CHECKPOINT = "sam_vit_b_01ec64.pth"


def run_yolov8_detection(image_path):
    """Run YOLOv8 instance segmentation on the rendered image."""
    if not HAS_YOLO:
        return []
    model = YOLO(YOLO_MODEL)
    results = model(image_path, device="cpu", nms=True)
    detections = []
    for r in results:
        for box in r.boxes:
            detections.append({
                "bbox": box.xyxy.cpu().numpy().tolist()[0],
                "class_id": int(box.cls.cpu().numpy()[0]),
                "confidence": float(box.conf.cpu().numpy()[0]),
                "class_name": model.names[int(box.cls.cpu().numpy()[0])],
            })
    return detections


def run_sam_segmentation(image_path, detections):
    """Run SAM fine-grained segmentation based on YOLO detections."""
    if not HAS_SAM or not detections:
        return []
    image = cv2.imread(image_path)
    if not os.path.exists(SAM_CHECKPOINT):
        return []
    sam = sam_model_registry["vit_b"](checkpoint=SAM_CHECKPOINT).to("cpu")
    predictor = SamPredictor(sam)
    predictor.set_image(image)

    masks = []
    for det in detections:
        bbox = np.array(det["bbox"]).reshape(1, 4)
        pred_mask, _, _ = predictor.predict(box=bbox, multimask_output=False)
        masks.append({
            "bbox": det["bbox"],
            "mask": pred_mask[0].tolist(),
            "class_id": det["class_id"],
            "class_name": det["class_name"],
            "confidence": det["confidence"],
        })
    return masks


def save_coco_annotations(masks, image_path, output_dir, model_name):
    """Save segmentation results in COCO format."""
    coco = {
        "images": [{"id": 1, "file_name": os.path.basename(image_path)}],
        "annotations": [],
        "categories": [],
    }

    class_map = {}
    for m in masks:
        class_map[m["class_id"]] = m["class_name"]
    for cid, name in class_map.items():
        coco["categories"].append({"id": cid, "name": name})

    for i, ann in enumerate(masks):
        coco["annotations"].append({
            "id": i,
            "image_id": 1,
            "bbox": ann["bbox"],
            "segmentation": ann["mask"],
            "category_id": ann["class_id"],
            "score": ann["confidence"],
        })

    json_path = os.path.join(output_dir, f"{model_name}_annotations.json")
    with open(json_path, "w") as f:
        json.dump(coco, f, indent=2)
    return json_path


# ===================== 5. UV Completion =====================
def complete_uv(mesh):
    """
    Generate or complete UV coordinates for the mesh.
    If UV exists, reuse it. Otherwise, compute spherical projection UV.
    """
    try:
        if hasattr(mesh.visual, "uv") and mesh.visual.uv is not None:
            uv = mesh.visual.uv
            return mesh, uv, True  # existing UV
    except Exception:
        pass

    # Spherical UV projection
    vs = mesh.vertices - mesh.center_mass
    norms = np.linalg.norm(vs, axis=1, keepdims=True) + 1e-6
    vs_normalized = vs / norms
    phi = np.arctan2(vs_normalized[:, 0], vs_normalized[:, 2]) / (2 * np.pi) + 0.5
    theta = np.arcsin(np.clip(vs_normalized[:, 1], -1, 1)) / np.pi + 0.5
    uv = np.stack([phi, theta], axis=1)

    return mesh, uv, False


# ===================== 6. Apply Texture to a single mesh =====================
def apply_texture(mesh, texture_path, uv):
    """Apply a PNG texture to the mesh using the given UV coordinates."""
    texture_image = Image.open(texture_path).convert("RGB")
    # Use PBRMaterial so that baseColorFactor is correctly written to GLB
    # SimpleMaterial uses 'diffuse' which defaults to [102,102,102] and darkens the texture
    material = trimesh.visual.material.PBRMaterial(
        baseColorTexture=texture_image,
        baseColorFactor=[255, 255, 255, 255],
        roughnessFactor=0.6,
        metallicFactor=0.0,
    )
    mesh.visual = trimesh.visual.TextureVisuals(uv=uv, material=material)
    return mesh


# ===================== Main Pipeline =====================
def process_glb_pipeline(glb_path, texture_path, output_dir, no_obj=False):
    """Run the full GLB + PNG processing pipeline."""
    os.makedirs(output_dir, exist_ok=True)
    model_name = Path(glb_path).stem

    # Step 1: Load GLB as Scene (preserves multi-mesh structure + embedded textures)
    loaded = trimesh.load(glb_path)

    # Convert to Scene if it's a single Trimesh
    if isinstance(loaded, trimesh.Trimesh):
        scene = trimesh.Scene(geometry={"default": loaded})
    elif isinstance(loaded, trimesh.Scene):
        scene = loaded
    else:
        scene = loaded

    # Step 2: Extract layered textures from original GLB (before applying new texture)
    textures_dir = os.path.join(output_dir, "textures")
    os.makedirs(textures_dir, exist_ok=True)
    texture_paths = extract_textures_from_scene(scene, textures_dir, model_name)

    # Step 3: Export metadata
    metadata_path = export_metadata(scene, texture_paths, output_dir, model_name)

    # Step 4: Apply the new PNG texture to each geometry in the scene
    uv_source = "existing"
    for geom_name, mesh in scene.geometry.items():
        if not isinstance(mesh, trimesh.Trimesh):
            continue
        if not hasattr(mesh, 'vertices') or len(mesh.vertices) == 0:
            continue

        # Complete UV (reuse existing or compute spherical)
        mesh, uv, had_existing_uv = complete_uv(mesh)
        if not had_existing_uv:
            uv_source = "spherical_projection"

        # Apply the provided PNG texture
        mesh = apply_texture(mesh, texture_path, uv)
        scene.geometry[geom_name] = mesh

    # Step 5: Export as GLB (primary output — preserves embedded textures)
    new_glb_path = os.path.join(output_dir, f"{model_name}_textured.glb")
    scene.export(new_glb_path)

    # Step 6: Also export as OBJ (optional, for downstream compatibility)
    new_model_path = None
    if not no_obj:
        new_model_path = os.path.join(output_dir, f"{model_name}_textured.obj")
        try:
            # Merge all geometries into a single mesh for OBJ export
            all_meshes = [m for m in scene.geometry.values() if isinstance(m, trimesh.Trimesh)]
            if len(all_meshes) == 1:
                all_meshes[0].export(new_model_path)
            elif len(all_meshes) > 1:
                merged = trimesh.util.concatenate(all_meshes)
                merged.export(new_model_path)
        except Exception:
            new_model_path = None

    # Step 7: Render the textured model (use merged mesh for rendering)
    render_path = None
    try:
        all_meshes = [m for m in scene.geometry.values() if isinstance(m, trimesh.Trimesh)]
        if len(all_meshes) == 1:
            render_mesh = all_meshes[0]
        elif len(all_meshes) > 1:
            render_mesh = trimesh.util.concatenate(all_meshes)
        else:
            render_mesh = None

        if render_mesh is not None:
            render_path = os.path.join(output_dir, f"{model_name}_render.png")
            render_model(render_mesh, render_path)
    except Exception as e:
        print(f"[WARN] Rendering failed: {e}", file=sys.stderr)
        render_path = None

    # Step 8: YOLO + SAM segmentation (optional)
    annotations_info = {"available": False, "reason": "YOLO/SAM not installed"}
    if render_path and HAS_YOLO and HAS_SAM:
        try:
            detections = run_yolov8_detection(render_path)
            if detections:
                masks = run_sam_segmentation(render_path, detections)
                if masks:
                    anno_path = save_coco_annotations(masks, render_path, output_dir, model_name)
                    annotations_info = {
                        "available": True,
                        "annotation_path": anno_path,
                        "detection_count": len(detections),
                        "segmentation_count": len(masks),
                    }
                else:
                    annotations_info = {"available": False, "reason": "No objects detected"}
            else:
                annotations_info = {"available": False, "reason": "No objects detected"}
        except Exception as e:
            annotations_info = {"available": False, "reason": str(e)}
    elif render_path and (not HAS_YOLO or not HAS_SAM):
        missing = []
        if not HAS_YOLO:
            missing.append("ultralytics (YOLOv8)")
        if not HAS_SAM:
            missing.append("segment-anything (SAM)")
        annotations_info = {"available": False, "reason": f"Not installed: {', '.join(missing)}"}

    # Count totals
    total_vertices = sum(len(m.vertices) for m in scene.geometry.values() if isinstance(m, trimesh.Trimesh))
    total_faces = sum(len(m.faces) for m in scene.geometry.values() if isinstance(m, trimesh.Trimesh) and hasattr(m, 'faces'))

    # Build result
    result = {
        "status": "ok",
        "output_dir": output_dir,
        "new_glb_path": new_glb_path,
        "new_model_path": new_model_path,
        "render_path": render_path,
        "textures": {k: os.path.basename(v) for k, v in texture_paths.items()},
        "metadata_path": os.path.basename(metadata_path),
        "uv_source": uv_source,
        "annotations": annotations_info,
        "vertex_count": int(total_vertices),
        "face_count": int(total_faces),
    }

    return result


def main():
    parser = argparse.ArgumentParser(description="GLB + PNG Processing Pipeline")
    parser.add_argument("--input", required=True, help="Path to input GLB model file")
    parser.add_argument("--texture", required=True, help="Path to input PNG texture")
    parser.add_argument("--output-dir", required=True, help="Output directory")
    parser.add_argument("--no-obj", action="store_true", help="Skip OBJ generation (GLB only)")
    args = parser.parse_args()

    try:
        result = process_glb_pipeline(args.input, args.texture, args.output_dir, no_obj=args.no_obj)
        # Print result as JSON on the last line of stdout
        print(json.dumps(result, ensure_ascii=False))
    except Exception as e:
        error_result = {
            "status": "error",
            "error": str(e),
            "traceback": traceback.format_exc(),
        }
        print(json.dumps(error_result, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
