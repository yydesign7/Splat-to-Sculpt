"""
    从OBJ模型生成360度旋转视频
    :param obj_path: 输入的OBJ文件路径
    :param fps: 视频帧率
    :param duration: 视频时长(秒)
    :param width: 视频宽度
    :param height: 视频高度
"""

import os
import trimesh
import pyrender
import numpy as np
import cv2
from PIL import Image

def generate_360_rotation_video(obj_path, fps=30, duration=6, width=1024, height=1024):
    # ===================== 自动生成视频文件名 =====================
    model_name = os.path.splitext(os.path.basename(obj_path))[0]
    VIDEO_OUTPUT_DIR = "video"

    if not os.path.exists(VIDEO_OUTPUT_DIR):
        os.makedirs(VIDEO_OUTPUT_DIR)

    OUTPUT_VIDEO = os.path.join(VIDEO_OUTPUT_DIR, f"{model_name}_rotate_360.mp4")

    # ===================== 加载模型 =====================
    mesh = trimesh.load(obj_path, force="mesh")

    # ===================== 场景 =====================
    scene = pyrender.Scene(bg_color=[255, 255, 255])
    mesh_node = scene.add(pyrender.Mesh.from_trimesh(mesh))

    # ===================== 相机 =====================
    camera = pyrender.PerspectiveCamera(yfov=np.pi / 3.0)
    cam_pose = np.array([[1, 0, 0, 0], [0, 1, 0, 15], [0, 0, 1, 45.0], [0, 0, 0, 1]])
    scene.add(camera, pose=cam_pose)

    # ===================== 灯光 =====================
    light = pyrender.DirectionalLight(color=np.ones(3), intensity=4.0)
    scene.add(light, pose=cam_pose)

    # ===================== 渲染器 =====================
    r = pyrender.OffscreenRenderer(width, height)
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    video = cv2.VideoWriter(OUTPUT_VIDEO, fourcc, fps, (width, height))

    # ===================== 360° 旋转渲染 =====================
    total_frames = fps * duration
    print(f"生成旋转视频，总帧数：{total_frames}")

    for i in range(total_frames):
        angle = (i / total_frames) * 2 * np.pi
        rot = trimesh.transformations.rotation_matrix(angle, [0, 1, 0])
        scene.set_pose(mesh_node, rot)

        color, _ = r.render(scene)
        frame = cv2.cvtColor(color, cv2.COLOR_RGB2BGR)
        video.write(frame)

    # ===================== 保存 =====================
    video.release()
    r.delete()
    print(f"视频生成完成：{OUTPUT_VIDEO}")


# ------------------- 调用示例 -------------------
if __name__ == "__main__":
    # OBJ路径
    generate_360_rotation_video("text2mesh_output/Chair_new.obj")
