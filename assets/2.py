"""
实现扩散或 Text2Mesh 模型以⽣成视觉变化和材质变化。

text2mesh_output/
├─ xxx_texture.png    ← AI生成的材质
├─ xxx_new.obj        ← 带材质模型
└─ xxx_render.png     ← 新材质渲染图
"""

import os
import trimesh
import pyrender
import numpy as np
import torch
from PIL import Image
from diffusers import StableDiffusionPipeline
import warnings

warnings.filterwarnings("ignore")

# ===================== 配置 =====================
os.environ["CUDA_VISIBLE_DEVICES"] = "-1"
DEVICE = "cpu"
DTYPE = torch.float32
TEXTURE_SIZE = 512


# ===================== 核心 Text2Mesh =====================
def generate_material_by_text(mesh, prompt):
    print("生成 UV 坐标...")

    # 自动安全 UV
    try:
        if hasattr(mesh.visual, "uv") and mesh.visual.uv is not None:
            uv = mesh.visual.uv
        else:
            uv = trimesh.visual.unwrap_parameters(mesh.vertices, mesh.faces)
    except:
        # 备用球面 UV
        vs = mesh.vertices - mesh.center_mass
        phi = np.arctan2(vs[:, 0], vs[:, 2]) / (2 * np.pi) + 0.5
        theta = np.arcsin(vs[:, 1] / (np.linalg.norm(vs, axis=1) + 1e-6)) / np.pi + 0.5
        uv = np.stack([phi, theta], axis=1)

    print("AI 生成材质纹理...")

    pipe = StableDiffusionPipeline.from_pretrained(
        "runwayml/stable-diffusion-v1-5", torch_dtype=DTYPE, safety_checker=None
    ).to(DEVICE)

    # 材质专用提示词（不会生成物体/沙发）
    prompt_final = (
        f"{prompt}, seamless texture, tileable, flat material, 4k, high detail, "
        "no object, no shadow, plain surface, only texture"
    )

    negative_prompt = (
        "human, person, body, face, man, woman, furniture, sofa, chair, table, "
        "scene, shadow, blurry, low quality, noise, deformed"
    )

    texture = pipe(
        prompt=prompt_final,
        negative_prompt=negative_prompt,
        width=TEXTURE_SIZE,
        height=TEXTURE_SIZE,
        num_inference_steps=28,
        guidance_scale=8.0,
    ).images[0]

    mesh.visual = trimesh.visual.TextureVisuals(uv=uv, image=texture)
    return mesh, texture


# ===================== 渲染新材质模型 =====================
def render_new_model(mesh, output_path):
    scene = pyrender.Scene(bg_color=[255, 255, 255])
    mesh_pyrender = pyrender.Mesh.from_trimesh(mesh)
    scene.add(mesh_pyrender)

    camera = pyrender.PerspectiveCamera(yfov=np.pi / 3.0)
    cam_pose = np.array([[1, 0, 0, 0], [0, 1, 0, 15], [0, 0, 1, 45.0], [0, 0, 0, 1]])
    scene.add(camera, pose=cam_pose)

    light = pyrender.DirectionalLight(color=np.ones(3), intensity=4.0)
    scene.add(light, pose=cam_pose)

    r = pyrender.OffscreenRenderer(1024, 1024)
    color, _ = r.render(scene)
    Image.fromarray(color).save(output_path)
    print(f"新材质渲染图已保存：{output_path}")


# ===================== 批量运行 =====================
def run_text2mesh(
    input_folder="data", prompt="shiny golden metal, smooth, 8k, realistic"
):
    os.makedirs("text2mesh_output", exist_ok=True)

    for fname in os.listdir(input_folder):
        if not fname.endswith((".obj", ".glb")):
            continue

        name = os.path.splitext(fname)[0]
        mesh = trimesh.load(os.path.join(input_folder, fname), force="mesh")

        print(f"\n=== 处理模型: {fname} ===")
        mesh_new, tex = generate_material_by_text(mesh, prompt)

        tex.save(f"text2mesh_output/{name}_texture.png")
        mesh_new.export(f"text2mesh_output/{name}_new.obj")
        render_new_model(mesh_new, f"text2mesh_output/{name}_render.png")

    print("\n全部完成")


# ===================== 运行 =====================
if __name__ == "__main__":
    # 粉色绒布
    PROMPT = "pink velvet, soft fluffy fabric, textile, seamless texture, high detail"
    run_text2mesh(input_folder="data", prompt=PROMPT)
