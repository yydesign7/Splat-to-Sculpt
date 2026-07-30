from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
from pathlib import Path

import folder_paths
import numpy as np
import torch
from PIL import Image


MODEL_EXTENSIONS = {".blend", ".fbx", ".glb", ".gltf", ".obj"}
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


def _model_root() -> Path:
    root = Path(folder_paths.get_input_directory()) / "3d"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _model_files() -> list[str]:
    root = _model_root()
    files = sorted(
        path.relative_to(root).as_posix()
        for path in root.rglob("*")
        if path.is_file() and path.suffix.lower() in MODEL_EXTENSIONS
    )
    return files or ["请把 .blend/.fbx/.glb/.gltf/.obj 放入 input/3d"]


def _find_blender() -> Path:
    candidates: list[Path] = []
    configured = os.environ.get("BLENDER_EXECUTABLE", "").strip()
    if configured:
        candidates.append(Path(configured))

    for base in (
        Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Blender Foundation",
        Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "Blender Foundation",
    ):
        if base.is_dir():
            candidates.extend(sorted(base.glob("Blender */blender.exe"), reverse=True))

    candidates.extend(
        [
            Path(r"C:\Program Files (x86)\Steam\steamapps\common\Blender\blender.exe"),
            Path(r"C:\Program Files\Steam\steamapps\common\Blender\blender.exe"),
        ]
    )
    in_path = shutil.which("blender")
    if in_path:
        candidates.append(Path(in_path))

    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    raise FileNotFoundError(
        "没有找到 Blender。请安装 Blender，或设置环境变量 BLENDER_EXECUTABLE 指向 blender.exe。"
    )


def _load_rgb(path: Path) -> torch.Tensor:
    with Image.open(path) as image:
        rgb = image.convert("RGB")
        array = np.asarray(rgb, dtype=np.float32) / 255.0
    return torch.from_numpy(array)[None, ...]


class Seedance3DModelLoader:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": (_model_files(),),
            }
        }

    RETURN_TYPES = ("SEEDANCE_3D_MODEL",)
    RETURN_NAMES = ("3D模型",)
    FUNCTION = "load_model"
    CATEGORY = "Seedance广告视频/3D模型"
    DESCRIPTION = "从 ComfyUI/input/3d 中选择一个 3D 模型，交给九角度渲染节点。"

    @classmethod
    def IS_CHANGED(cls, model: str):
        candidate = (_model_root() / model).resolve()
        return candidate.stat().st_mtime_ns if candidate.is_file() else model

    def load_model(self, model: str):
        root = _model_root().resolve()
        model_path = (root / model).resolve()
        try:
            model_path.relative_to(root)
        except ValueError as exc:
            raise ValueError("模型路径必须位于 ComfyUI/input/3d 文件夹内。") from exc
        if not model_path.is_file() or model_path.suffix.lower() not in MODEL_EXTENSIONS:
            raise FileNotFoundError(f"没有找到可读取的 3D 模型：{model_path}")
        return (model,)


class Seedance3DModelMultiView:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("SEEDANCE_3D_MODEL",),
                "scene_selection": (
                    ["场景全部对象", "自动选择靠近原点的单件"],
                    {"default": "场景全部对象"},
                ),
                "resolution": ([512, 768, 1024, 1536], {"default": 1024}),
                "background": (
                    ["深灰影棚", "纯黑", "纯白", "透明"],
                    {"default": "深灰影棚"},
                ),
                "camera_elevation": (
                    "FLOAT",
                    {"default": 12.0, "min": -20.0, "max": 60.0, "step": 1.0},
                ),
                "frame_padding": (
                    "FLOAT",
                    {"default": 1.25, "min": 1.02, "max": 2.5, "step": 0.01},
                ),
                "render_engine": (
                    ["Eevee（快速）", "Cycles（高质量）"],
                    {"default": "Eevee（快速）"},
                ),
                "force_render": ("BOOLEAN", {"default": False}),
            }
        }

    RETURN_TYPES = ("IMAGE",) * 10 + ("STRING",)
    RETURN_NAMES = (
        "全部角度（批次）",
        "正面",
        "右前45°",
        "右侧",
        "右后45°",
        "背面",
        "左后45°",
        "左侧",
        "左前45°",
        "高位英雄角度",
        "图片文件夹",
    )
    FUNCTION = "render"
    CATEGORY = "Seedance广告视频/3D模型"
    DESCRIPTION = "用 Blender 后台读取 3D 模型并渲染 9 张 Seedance 参考图。"

    @classmethod
    def IS_CHANGED(
        cls,
        model: str,
        scene_selection: str,
        resolution: int,
        background: str,
        camera_elevation: float,
        frame_padding: float,
        render_engine: str,
        force_render: bool,
    ):
        candidate = (_model_root() / model).resolve()
        stamp = candidate.stat().st_mtime_ns if candidate.is_file() else 0
        if force_render:
            stamp = f"{stamp}-{os.urandom(8).hex()}"
        return (
            stamp,
            scene_selection,
            resolution,
            background,
            camera_elevation,
            frame_padding,
            render_engine,
        )

    def render(
        self,
        model: str,
        scene_selection: str,
        resolution: int,
        background: str,
        camera_elevation: float,
        frame_padding: float,
        render_engine: str,
        force_render: bool,
    ):
        root = _model_root().resolve()
        model_path = (root / model).resolve()
        try:
            model_path.relative_to(root)
        except ValueError as exc:
            raise ValueError("模型路径必须位于 ComfyUI/input/3d 文件夹内。") from exc
        if not model_path.is_file() or model_path.suffix.lower() not in MODEL_EXTENSIONS:
            raise FileNotFoundError(f"没有找到可读取的 3D 模型：{model_path}")

        blender = _find_blender()
        script = Path(__file__).with_name("blender_multiview.py").resolve()
        cache_key = hashlib.sha1(
            "|".join(
                [
                    str(model_path),
                    str(model_path.stat().st_mtime_ns),
                    scene_selection,
                    str(resolution),
                    background,
                    f"{camera_elevation:.3f}",
                    f"{frame_padding:.3f}",
                    render_engine,
                    "v1",
                ]
            ).encode("utf-8")
        ).hexdigest()[:12]
        output_dir = (
            Path(folder_paths.get_output_directory())
            / "Seedance_3D_Views"
            / f"{model_path.stem}_{cache_key}"
        )
        output_dir.mkdir(parents=True, exist_ok=True)
        expected = [output_dir / f"{index:02d}_{name}.png" for index, name in enumerate(VIEW_NAMES, 1)]

        if force_render or not all(path.is_file() for path in expected):
            background_map = {
                "深灰影棚": "studio",
                "纯黑": "black",
                "纯白": "white",
                "透明": "transparent",
            }
            engine = "cycles" if render_engine.startswith("Cycles") else "eevee"
            selection = "auto_origin" if scene_selection.startswith("自动") else "all"
            command = [str(blender)]
            if model_path.suffix.lower() == ".blend":
                command += ["-b", str(model_path)]
            else:
                command += ["-b"]
            command += [
                "--python-exit-code",
                "1",
                "--python",
                str(script),
                "--",
                "--model",
                str(model_path),
                "--output",
                str(output_dir),
                "--resolution",
                str(int(resolution)),
                "--selection",
                selection,
                "--background",
                background_map[background],
                "--elevation",
                str(float(camera_elevation)),
                "--padding",
                str(float(frame_padding)),
                "--engine",
                engine,
            ]
            result = subprocess.run(
                command,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=900,
            )
            if result.returncode:
                tail = "\n".join(result.stderr.splitlines()[-60:])
                raise RuntimeError(f"Blender 多角度渲染失败（返回 {result.returncode}）：\n{tail}")

        missing = [str(path) for path in expected if not path.is_file()]
        if missing:
            raise RuntimeError("Blender 没有生成完整的参考图：\n" + "\n".join(missing))

        views = [_load_rgb(path) for path in expected]
        batch = torch.cat(views, dim=0)
        return (batch, *views, str(output_dir))


NODE_CLASS_MAPPINGS = {
    "Seedance3DModelLoader": Seedance3DModelLoader,
    "Seedance3DModelMultiView": Seedance3DModelMultiView,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "Seedance3DModelLoader": "加载3D模型（Seedance）",
    "Seedance3DModelMultiView": "Seedance 3D模型多角度参考图",
}
