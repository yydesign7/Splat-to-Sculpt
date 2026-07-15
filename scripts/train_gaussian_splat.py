#!/usr/bin/env python3
"""
Train and export a real 3D Gaussian Splat using Nerfstudio Splatfacto.

Input is an existing COLMAP reconstruction (images + sparse/0) produced by the
workflow. The script prepares a Nerfstudio dataset, trains `splatfacto`, and
exports a 3DGS-compatible PLY via `ns-export gaussian-splat`.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import textwrap
from pathlib import Path

CURRENT_PROC: subprocess.Popen[str] | None = None
CANCEL_REQUESTED = False


def emit(**payload) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def handle_signal(signum, _frame) -> None:
    global CANCEL_REQUESTED
    CANCEL_REQUESTED = True
    if CURRENT_PROC and CURRENT_PROC.poll() is None:
        CURRENT_PROC.terminate()
    raise SystemExit(130 if signum == signal.SIGINT else 143)


signal.signal(signal.SIGTERM, handle_signal)
signal.signal(signal.SIGINT, handle_signal)


def require_command(name: str) -> str:
    resolved = shutil.which(name)
    if not resolved:
        raise RuntimeError(
            f"Missing `{name}`. Install Nerfstudio with Splatfacto support, then make `{name}` available on PATH."
        )
    return resolved


def copy_images(src_dir: Path, dst_dir: Path) -> None:
    dst_dir.mkdir(parents=True, exist_ok=True)
    for src in sorted(src_dir.iterdir()):
        if src.is_file() and src.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}:
            shutil.copy2(src, dst_dir / src.name)


def copy_sparse(src_dir: Path, dst_dir: Path) -> None:
    dst_dir.mkdir(parents=True, exist_ok=True)
    for name in ("cameras.bin", "images.bin", "points3D.bin", "cameras.txt", "images.txt", "points3D.txt"):
        src = src_dir / name
        if src.exists():
            shutil.copy2(src, dst_dir / name)


def copy_masks(src_dir: Path, dst_dir: Path) -> set[str]:
    copied: set[str] = set()
    if not src_dir.exists():
        return copied
    dst_dir.mkdir(parents=True, exist_ok=True)
    for src in sorted(src_dir.iterdir()):
        if src.is_file() and src.suffix.lower() == ".png":
            shutil.copy2(src, dst_dir / src.name)
            copied.add(src.stem)
    return copied


def attach_masks_to_transforms(dataset_dir: Path, mask_stems: set[str]) -> int:
    if not mask_stems:
        return 0
    transforms_path = dataset_dir / "transforms.json"
    if not transforms_path.exists():
        return 0

    with transforms_path.open("r", encoding="utf-8") as handle:
        transforms = json.load(handle)

    frames = transforms.get("frames")
    if not isinstance(frames, list):
        return 0

    attached = 0
    for frame in frames:
        if not isinstance(frame, dict):
            continue
        file_path = frame.get("file_path")
        if not isinstance(file_path, str):
            continue
        stem = Path(file_path).stem
        if stem not in mask_stems:
            continue
        frame["mask_path"] = f"masks/{stem}.png"
        attached += 1

    with transforms_path.open("w", encoding="utf-8") as handle:
        json.dump(transforms, handle, indent=2)
        handle.write("\n")

    return attached


def prepare_nerfstudio_dataset(images_dir: Path, sparse_dir: Path, dataset_dir: Path, masks_dir: Path | None) -> int:
    try:
        from nerfstudio.process_data.colmap_utils import colmap_to_json
    except Exception as exc:  # pragma: no cover - depends on external install
        raise RuntimeError(
            "Nerfstudio is not importable in this Python environment. "
            "Install Nerfstudio and ensure this script runs with that Python."
        ) from exc

    images_out = dataset_dir / "images"
    masks_out = dataset_dir / "masks"
    sparse_out = dataset_dir / "colmap" / "sparse" / "0"
    copy_images(images_dir, images_out)
    copy_sparse(sparse_dir, sparse_out)
    mask_stems = copy_masks(masks_dir, masks_out) if masks_dir else set()
    if not any(images_out.iterdir()):
        raise RuntimeError(f"No images found in {images_dir}")
    if not ((sparse_out / "cameras.bin").exists() and (sparse_out / "images.bin").exists()):
        raise RuntimeError(f"COLMAP sparse reconstruction is incomplete: {sparse_dir}")

    registered_images = int(colmap_to_json(sparse_out, dataset_dir, ply_filename="sparse_pc.ply"))
    attached_masks = attach_masks_to_transforms(dataset_dir, mask_stems)
    if mask_stems:
        emit(
            status="progress",
            progress=f"Attached foreground masks to {attached_masks}/{registered_images} training frames...",
            progressStep=5,
        )
    return registered_images


def parse_training_iteration(line: str, max_iterations: int) -> int | None:
    candidates = [
        rf"(?:step|iter|iteration)\D+(\d+)\D+{max_iterations}\b",
        rf"\b(\d+)\s*/\s*{max_iterations}\b",
        r"(?:step|iter|iteration)[=: ]+(\d+)\b",
    ]
    for pattern in candidates:
        match = re.search(pattern, line, re.IGNORECASE)
        if not match:
            continue
        try:
            value = int(match.group(1))
        except ValueError:
            continue
        if 0 <= value <= max_iterations:
            return value
    return None


def run_command(
    args: list[str],
    cwd: Path | None = None,
    max_iterations: int | None = None,
    env: dict[str, str] | None = None,
) -> None:
    global CURRENT_PROC
    tail: list[str] = []
    last_reported_iteration = -1
    proc = subprocess.Popen(
        args,
        cwd=str(cwd) if cwd else None,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        env=env,
    )
    CURRENT_PROC = proc
    assert proc.stdout is not None
    line_buffer = ""

    def handle_output_line(line: str) -> None:
        nonlocal last_reported_iteration, tail
        stripped = line.strip()
        if stripped:
            tail.append(stripped)
            tail = tail[-60:]
            print(stripped, file=sys.stderr, flush=True)
            if max_iterations:
                iteration = parse_training_iteration(stripped, max_iterations)
                if iteration is not None and iteration > last_reported_iteration:
                    last_reported_iteration = iteration
                    emit(
                        status="progress",
                        progress=f"Training Splatfacto step {iteration}/{max_iterations}...",
                        progressStep=6,
                        currentTrainingIteration=iteration,
                        maxTrainingIterations=max_iterations,
                    )

    while True:
        char = proc.stdout.read(1)
        if char == "" and proc.poll() is not None:
            break
        if char == "":
            continue
        if char in ("\n", "\r"):
            handle_output_line(line_buffer)
            line_buffer = ""
            continue
        line_buffer += char
    if line_buffer:
        handle_output_line(line_buffer)
    code = proc.wait()
    CURRENT_PROC = None
    if CANCEL_REQUESTED:
        raise RuntimeError("Gaussian splat training was cancelled")
    if code != 0:
        raise RuntimeError(
            f"Command failed ({code}): {' '.join(args)}\n"
            + "\n".join(tail[-20:])
        )


def create_nerfstudio_device_patch(patch_dir: Path) -> dict[str, str]:
    """Patch Nerfstudio Splatfacto's hard-coded CUDA calls for non-CUDA devices."""
    patch_dir.mkdir(parents=True, exist_ok=True)
    sitecustomize = patch_dir / "sitecustomize.py"
    sitecustomize.write_text(
        textwrap.dedent(
            r'''
            import importlib.abc
            import importlib.machinery
            import sys

            TARGET = "nerfstudio.models.splatfacto"


            class _SplatfactoPatchLoader(importlib.machinery.SourceFileLoader):
                def get_code(self, fullname):
                    data = self.get_data(self.path)
                    return self.source_to_code(data, self.path)

                def source_to_code(self, data, path, *, _optimize=-1):
                    source = data.decode("utf-8") if isinstance(data, bytes) else data
                    source = source.replace(
                        "shs = torch.zeros((self.seed_points[1].shape[0], dim_sh, 3)).float().cuda()",
                        "seed_colors = self.seed_points[1]\n"
                        "            shs = torch.zeros((seed_colors.shape[0], dim_sh, 3)).float()",
                    )
                    source = source.replace(
                        "RGB2SH(self.seed_points[1] / 255)",
                        "RGB2SH(seed_colors / 255)",
                    )
                    source = source.replace(
                        "torch.logit(self.seed_points[1] / 255, eps=1e-10)",
                        "torch.logit(seed_colors / 255, eps=1e-10)",
                    )
                    source = source.replace(
                        "K = camera.get_intrinsics_matrices().cuda()",
                        "K = camera.get_intrinsics_matrices().to(self.device)",
                    )
                    source = source.replace(
                        "self.lpips = LearnedPerceptualImagePatchSimilarity(normalize=True)",
                        "self.lpips = lambda gt_rgb, predicted_rgb: torch.tensor(0.0, device=predicted_rgb.device)",
                    )
                    return super().source_to_code(source, path, _optimize=_optimize)


            class _SplatfactoPatchFinder(importlib.abc.MetaPathFinder):
                def find_spec(self, fullname, path=None, target=None):
                    if fullname != TARGET:
                        return None
                    spec = importlib.machinery.PathFinder.find_spec(fullname, path)
                    if spec is None or spec.origin is None:
                        return None
                    spec.loader = _SplatfactoPatchLoader(fullname, spec.origin)
                    return spec


            sys.meta_path.insert(0, _SplatfactoPatchFinder())
            '''
        ).strip()
        + "\n",
        encoding="utf-8",
    )
    env = os.environ.copy()
    cache_root = Path(env.get("XDG_CACHE_HOME", "/private/tmp/studio3dgs-cache"))
    torch_home = cache_root / "torch"
    mpl_config = Path(env.get("MPLCONFIGDIR", "/private/tmp/studio3dgs-matplotlib"))
    torch_home.mkdir(parents=True, exist_ok=True)
    mpl_config.mkdir(parents=True, exist_ok=True)
    env.setdefault("XDG_CACHE_HOME", str(cache_root))
    env.setdefault("TORCH_HOME", str(torch_home))
    env.setdefault("MPLCONFIGDIR", str(mpl_config))
    env["PYTHONPATH"] = f"{patch_dir}{os.pathsep}{env.get('PYTHONPATH', '')}".rstrip(os.pathsep)
    return env


def find_latest_config(train_root: Path) -> Path:
    configs = sorted(train_root.rglob("config.yml"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not configs:
        configs = sorted(train_root.rglob("config.yaml"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not configs:
        raise RuntimeError(f"Nerfstudio training finished but no config.yml was found under {train_root}")
    return configs[0]


def count_ply_vertices(path: Path) -> int:
    with path.open("rb") as f:
        for raw in f:
            line = raw.decode("utf-8", errors="replace").strip()
            if line.startswith("element vertex "):
                try:
                    return int(line.split()[-1])
                except ValueError:
                    return 0
            if line == "end_header":
                break
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description="Train a true 3DGS model with Nerfstudio Splatfacto")
    parser.add_argument("--images-dir", required=True, help="Directory containing COLMAP input images")
    parser.add_argument("--sparse-dir", required=True, help="COLMAP sparse/0 directory")
    parser.add_argument("--output-dir", required=True, help="Output directory for dataset, checkpoints, and PLY")
    parser.add_argument("--max-iterations", type=int, default=1000, help="Splatfacto training iterations")
    parser.add_argument("--device", choices=("cuda", "mps", "cpu"), default="cpu", help="Nerfstudio training device")
    parser.add_argument("--ns-train", default="ns-train", help="Path to ns-train")
    parser.add_argument("--ns-export", default="ns-export", help="Path to ns-export")
    parser.add_argument("--masks-dir", default=None, help="Optional foreground mask directory matching image stems")
    args = parser.parse_args()

    images_dir = Path(args.images_dir).resolve()
    sparse_dir = Path(args.sparse_dir).resolve()
    masks_dir = Path(args.masks_dir).resolve() if args.masks_dir else None
    output_dir = Path(args.output_dir).resolve()
    dataset_dir = output_dir / "nerfstudio-data"
    train_root = output_dir / "nerfstudio-runs"
    export_dir = output_dir / "export"
    splat_path = export_dir / "gaussian_splat.ply"

    output_dir.mkdir(parents=True, exist_ok=True)
    ns_train = require_command(args.ns_train)
    ns_export = require_command(args.ns_export)
    subprocess_env = os.environ.copy()
    if args.device != "cuda":
        subprocess_env = create_nerfstudio_device_patch(output_dir / "runtime-patches")

    emit(status="progress", progress="Preparing Nerfstudio COLMAP dataset...", progressStep=5)
    registered_images = prepare_nerfstudio_dataset(images_dir, sparse_dir, dataset_dir, masks_dir)
    if registered_images < 2:
        raise RuntimeError(f"COLMAP registered only {registered_images} image(s); true 3DGS training needs multiple posed views.")

    emit(
        status="progress",
        progress=f"Training Splatfacto step 0/{args.max_iterations}...",
        progressStep=6,
        currentTrainingIteration=0,
        maxTrainingIterations=args.max_iterations,
    )
    run_command(
        [
            ns_train,
            "splatfacto",
            "--data",
            str(dataset_dir),
            "--output-dir",
            str(train_root),
            "--experiment-name",
            "studio3dgs",
            "--max-num-iterations",
            str(args.max_iterations),
            "--machine.device-type",
            args.device,
            "--steps-per-save",
            str(max(100, min(args.max_iterations, 2000))),
            "--vis",
            "tensorboard",
            "nerfstudio-data",
            "--eval-mode",
            "fraction",
            "--train-split-fraction",
            "0.9",
        ],
        cwd=output_dir,
        max_iterations=args.max_iterations,
        env=subprocess_env,
    )

    config_path = find_latest_config(train_root)
    emit(status="progress", progress="Exporting trained Gaussian splat PLY...", progressStep=7)
    run_command(
        [
            ns_export,
            "gaussian-splat",
            "--load-config",
            str(config_path),
            "--output-dir",
            str(export_dir),
            "--output-filename",
            splat_path.name,
            "--ply-color-mode",
            "sh_coeffs",
        ],
        cwd=output_dir,
        env=subprocess_env,
    )

    if not splat_path.exists():
        raise RuntimeError("Nerfstudio export completed but gaussian_splat.ply was not created")

    emit(
        status="ok",
        outputPath=str(splat_path),
        gaussianCount=count_ply_vertices(splat_path),
        format="3dgs-ply",
        trainer="nerfstudio-splatfacto",
        registeredImages=registered_images,
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        emit(status="error", error=str(exc))
        sys.exit(1)
