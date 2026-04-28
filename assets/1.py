"""
    分层纹理导出（漫反射 / 法线 / 金属 / UV，支持 PS 精细化编辑）
    元数据导出（比例尺、朝向、材质、UV 索引、顶点面数）
    自动结构化文件夹（批量处理，规范整洁）
    YOLOv8 + SAM 全自动分割标注（COCO 格式）

    3D_Asset_Output/
├─ 模型名称/
│   ├─ textures/          分层纹理（美术可编辑）
│   │   ├─ diffuse.png    漫反射
│   │   ├─ normal.png     法线
│   │   ├─ metal_rough.png 金属粗糙
│   │   └─ uv_vis.png     UV坐标
│   ├─ render.png         渲染图
│   ├─ metadata.json      完整元数据（比例尺/方向/材质/UV）
    └─ annotations.json   YOLO+SAM自动分割标注
"""

import os
import trimesh
import pyrender
import numpy as np
import cv2
import json
import torch
from PIL import Image
from ultralytics import YOLO
from segment_anything import sam_model_registry, SamPredictor
from pathlib import Path

# ===================== 全局配置=====================
os.environ["CUDA_VISIBLE_DEVICES"] = "-1"
torch.backends.cudnn.enabled = False
os.environ["TORCH_USE_CUDA_DSA"] = "0"
DEVICE = "cpu"

# 模型路径
SAM_CHECKPOINT = "sam_vit_b_01ec64.pth"
YOLO_MODEL = "yolov8n-seg.pt"


# ===================== 核心功能：分层纹理导出 =====================
def export_model_textures(mesh, output_dir, model_name):
    """
    导出分层纹理：漫反射、法线、金属度、AO、分割遮罩
    满足美术精细化编辑需求 + 兼容无纹理/无UV模型
    """
    os.makedirs(output_dir, exist_ok=True)
    texture_paths = {}

    # 安全判断：是否有材质和纹理
    try:
        # 1. 基础纹理导出（漫反射/颜色）
        if hasattr(mesh.visual, "material") and hasattr(
            mesh.visual.material, "baseColorTexture"
        ):
            if mesh.visual.material.baseColorTexture is not None:
                diffuse = mesh.visual.material.baseColorTexture
                diffuse_path = os.path.join(output_dir, f"{model_name}_diffuse.png")
                Image.fromarray(diffuse).save(diffuse_path)
                texture_paths["diffuse"] = diffuse_path

        # 2. 法线纹理
        if hasattr(mesh.visual, "material") and hasattr(
            mesh.visual.material, "normalTexture"
        ):
            if mesh.visual.material.normalTexture is not None:
                normal = mesh.visual.material.normalTexture
                normal_path = os.path.join(output_dir, f"{model_name}_normal.png")
                Image.fromarray(normal).save(normal_path)
                texture_paths["normal"] = normal_path

        # 3. 金属度/粗糙度纹理
        if hasattr(mesh.visual, "material") and hasattr(
            mesh.visual.material, "metallicRoughnessTexture"
        ):
            if mesh.visual.material.metallicRoughnessTexture is not None:
                metal = mesh.visual.material.metallicRoughnessTexture
                metal_path = os.path.join(output_dir, f"{model_name}_metal_rough.png")
                Image.fromarray(metal).save(metal_path)
                texture_paths["metal_rough"] = metal_path
    except:
        pass

    # 安全判断：是否有UV坐标
    try:
        if hasattr(mesh.visual, "uv") and mesh.visual.uv is not None:
            uv_map = (mesh.visual.uv * 255).astype(np.uint8)
            uv_path = os.path.join(output_dir, f"{model_name}_uv_vis.png")
            Image.fromarray(uv_map).save(uv_path)
            texture_paths["uv_visual"] = uv_path
    except:
        pass

    return texture_paths


# ===================== 核心功能：导出3D元数据 =====================
def export_model_metadata(mesh, texture_paths, output_dir, model_name, filename):
    """
    导出完整元数据：比例尺、方向、材质、UV、顶点、包围盒
    保证跨软件导入一致性
    """
    # 安全判断UV
    has_uv = False
    uv_shape = None
    try:
        if hasattr(mesh.visual, "uv") and mesh.visual.uv is not None:
            has_uv = True
            uv_shape = mesh.visual.uv.shape
    except:
        pass

    # 安全获取文件后缀
    try:
        file_type = Path(filename).suffix.lower().replace(".", "")
    except:
        file_type = "unknown"

    metadata = {
        "model_info": {
            "name": model_name,
            "file_type": file_type,
            "vertex_count": len(mesh.vertices),
            "face_count": len(mesh.faces) if hasattr(mesh, "faces") else 0,
            "has_uv": has_uv,
        },
        "scale_metadata": {
            "scale_factor": 1.0,
            "unit": "meter",
            "bounding_box_size": mesh.extents.tolist(),
        },
        "orientation_metadata": {
            "forward_axis": "Z",
            "up_axis": "Y",
            "rotation_matrix": np.eye(4).tolist(),
        },
        "material_metadata": {
            "has_texture": len(texture_paths) > 0,
            "texture_paths": texture_paths,
        },
        "uv_metadata": {"uv_index": 0, "uv_dimensions": uv_shape},
    }

    meta_path = os.path.join(output_dir, f"{model_name}_metadata.json")
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2, ensure_ascii=False)
    return meta_path


# ===================== 3D模型渲染 =====================
def render_model_to_image(mesh, output_dir, model_name, image_size=(1024, 1024)):
    """渲染高质量2D图用于检测分割"""
    render_mesh = pyrender.Mesh.from_trimesh(mesh)
    scene = pyrender.Scene()
    scene.add(render_mesh)

    # 相机设置（标准视角）
    camera = pyrender.PerspectiveCamera(yfov=np.pi / 3.0)
    # cam_pose = np.array([[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 2.5], [0, 0, 0, 1]])
    cam_pose = np.array([[1, 0, 0, 0], [0, 1, 0, 15], [0, 0, 1, 45.0], [0, 0, 0, 1]])
    scene.add(camera, pose=cam_pose)

    # 光照
    light = pyrender.DirectionalLight(color=[1, 1, 1], intensity=4.0)
    scene.add(light, pose=cam_pose)

    # 渲染
    renderer = pyrender.OffscreenRenderer(image_size[0], image_size[1])
    color, _ = renderer.render(scene)
    render_path = os.path.join(output_dir, f"{model_name}_render.png")
    Image.fromarray(color).save(render_path)
    return render_path


# ===================== YOLOv8 检测 =====================
def run_yolov8(image_path):
    model = YOLO(YOLO_MODEL)
    results = model(image_path, device=DEVICE, nms=True)
    detections = []
    for r in results:
        for box in r.boxes:
            detections.append(
                {
                    "bbox": box.xyxy.cpu().numpy().tolist()[0],
                    "class_id": int(box.cls.cpu().numpy()[0]),
                    "confidence": float(box.conf.cpu().numpy()[0]),
                    "class_name": model.names[int(box.cls.cpu().numpy()[0])],
                }
            )
    return detections


# ===================== SAM 精细分割 =====================
def run_sam(image_path, detections):
    if not detections:
        return []
    image = cv2.imread(image_path)
    sam = sam_model_registry["vit_b"](checkpoint=SAM_CHECKPOINT).to(DEVICE)
    predictor = SamPredictor(sam)
    predictor.set_image(image)

    masks = []
    for det in detections:
        bbox = np.array(det["bbox"]).reshape(1, 4)
        pred_mask, _, _ = predictor.predict(box=bbox, multimask_output=False)
        masks.append(
            {
                "bbox": det["bbox"],
                "mask": pred_mask[0].tolist(),
                "class_id": det["class_id"],
                "class_name": det["class_name"],
                "confidence": det["confidence"],
            }
        )
    return masks


# ===================== COCO 标注保存 =====================
def save_coco_annotations(masks, image_path, output_dir, model_name):
    coco = {
        "images": [{"id": 1, "file_name": os.path.basename(image_path)}],
        "annotations": [],
        "categories": [],
    }

    # 类别映射
    class_map = {}
    for m in masks:
        class_map[m["class_id"]] = m["class_name"]
    for cid, name in class_map.items():
        coco["categories"].append({"id": cid, "name": name})

    # 标注
    for i, ann in enumerate(masks):
        coco["annotations"].append(
            {
                "id": i,
                "image_id": 1,
                "bbox": ann["bbox"],
                "segmentation": ann["mask"],
                "category_id": ann["class_id"],
                "score": ann["confidence"],
            }
        )

    json_path = os.path.join(output_dir, f"{model_name}_annotations.json")
    with open(json_path, "w") as f:
        json.dump(coco, f, indent=2)
    return json_path


# ===================== 结构化批量处理 =====================
def process_3d_assets(input_folder="data", root_output="3D_Asset_Output"):
    """
    自动创建结构化文件夹：
    root_output/
        ├─ 模型1/
        │   ├─ textures/  分层纹理
        │   ├─ render.png 渲染图
        │   ├─ metadata.json 元数据
        │   └─ annotations.json 分割标注
        └─ 模型2/ ...
    """
    os.makedirs(root_output, exist_ok=True)
    model_files = [
        f for f in os.listdir(input_folder) if f.endswith((".obj", ".glb", ".gltf"))
    ]

    if not model_files:
        print("未找到3D模型文件！")
        return

    print(f"找到 {len(model_files)} 个模型，开始全流程处理...\n")

    for idx, filename in enumerate(model_files, 1):
        model_name = Path(filename).stem
        model_path = os.path.join(input_folder, filename)

        # 结构化输出目录
        asset_dir = os.path.join(root_output, model_name)
        texture_dir = os.path.join(asset_dir, "textures")
        os.makedirs(asset_dir, exist_ok=True)
        os.makedirs(texture_dir, exist_ok=True)

        print(f"===== 处理 {idx}/{len(model_files)}: {filename} =====")

        # 1. 加载模型
        mesh = trimesh.load(model_path, force="mesh")

        # 2. 导出分层纹理
        textures = export_model_textures(mesh, texture_dir, model_name)
        print(f"分层纹理导出完成：{len(textures)} 张")

        # 3. 导出完整元数据
        meta = export_model_metadata(mesh, textures, asset_dir, model_name, filename)
        print(f"元数据导出完成")

        # 4. 渲染2D图像
        render = render_model_to_image(mesh, asset_dir, model_name)
        print(f"模型渲染完成")

        # 5. YOLO检测 + SAM分割
        dets = run_yolov8(render)
        if not dets:
            print("未检测到目标，跳过分割")
            continue
        masks = run_sam(render, dets)
        print(f"SAM精细分割完成：{len(masks)} 个目标")

        # 6. 导出COCO标注
        anno = save_coco_annotations(masks, render, asset_dir, model_name)
        print(f"自动标注完成\n")

    print("所有模型处理完成")


# ===================== 运行 =====================
if __name__ == "__main__":
    
    process_3d_assets(input_folder="data", root_output="3D_Asset_Output")
