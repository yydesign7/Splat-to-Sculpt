#!/usr/bin/env python3
"""Filter a reconstructed point cloud by multi-view foreground-mask support."""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import open3d as o3d
from PIL import Image


@dataclass(frozen=True)
class Camera:
    model: str
    width: int
    height: int
    params: tuple[float, ...]


@dataclass(frozen=True)
class RegisteredImage:
    name: str
    camera_id: int
    rotation: np.ndarray
    translation: np.ndarray


def qvec_to_rotation(qvec: np.ndarray) -> np.ndarray:
    w, x, y, z = qvec
    return np.array(
        [
            [1 - 2 * y * y - 2 * z * z, 2 * x * y - 2 * z * w, 2 * x * z + 2 * y * w],
            [2 * x * y + 2 * z * w, 1 - 2 * x * x - 2 * z * z, 2 * y * z - 2 * x * w],
            [2 * x * z - 2 * y * w, 2 * y * z + 2 * x * w, 1 - 2 * x * x - 2 * y * y],
        ],
        dtype=np.float64,
    )


def read_cameras_text(path: Path) -> dict[int, Camera]:
    cameras: dict[int, Camera] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        parts = stripped.split()
        if len(parts) < 5:
            continue
        camera_id = int(parts[0])
        cameras[camera_id] = Camera(
            model=parts[1],
            width=int(parts[2]),
            height=int(parts[3]),
            params=tuple(float(value) for value in parts[4:]),
        )
    return cameras


def read_images_text(path: Path) -> list[RegisteredImage]:
    lines = path.read_text(encoding="utf-8").splitlines()
    images: list[RegisteredImage] = []
    index = 0
    while index < len(lines):
        stripped = lines[index].strip()
        if not stripped or stripped.startswith("#"):
            index += 1
            continue
        parts = stripped.split(maxsplit=9)
        if len(parts) < 10:
            index += 1
            continue
        qvec = np.array([float(value) for value in parts[1:5]], dtype=np.float64)
        translation = np.array([float(value) for value in parts[5:8]], dtype=np.float64)
        images.append(
            RegisteredImage(
                name=parts[9],
                camera_id=int(parts[8]),
                rotation=qvec_to_rotation(qvec),
                translation=translation,
            )
        )
        index += 2
    return images


def project_normalized(camera: Camera, x: np.ndarray, y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    model = camera.model.upper()
    params = camera.params
    if model == "SIMPLE_PINHOLE":
        focal, cx, cy = params[:3]
        return focal * x + cx, focal * y + cy
    if model == "PINHOLE":
        fx, fy, cx, cy = params[:4]
        return fx * x + cx, fy * y + cy

    if model in {"SIMPLE_RADIAL", "RADIAL"}:
        focal, cx, cy = params[:3]
        radial_sq = x * x + y * y
        distortion = 1.0 + params[3] * radial_sq
        if model == "RADIAL" and len(params) >= 5:
            distortion += params[4] * radial_sq * radial_sq
        return focal * x * distortion + cx, focal * y * distortion + cy

    if model in {"OPENCV", "FULL_OPENCV"}:
        fx, fy, cx, cy = params[:4]
        k1 = params[4] if len(params) > 4 else 0.0
        k2 = params[5] if len(params) > 5 else 0.0
        p1 = params[6] if len(params) > 6 else 0.0
        p2 = params[7] if len(params) > 7 else 0.0
        radial_sq = x * x + y * y
        distortion = 1.0 + k1 * radial_sq + k2 * radial_sq * radial_sq
        distorted_x = x * distortion + 2.0 * p1 * x * y + p2 * (radial_sq + 2.0 * x * x)
        distorted_y = y * distortion + p1 * (radial_sq + 2.0 * y * y) + 2.0 * p2 * x * y
        return fx * distorted_x + cx, fy * distorted_y + cy

    raise ValueError(f"Unsupported COLMAP camera model: {camera.model}")


def evenly_sample_images(images: list[RegisteredImage], max_views: int) -> list[RegisteredImage]:
    ordered = sorted(images, key=lambda item: item.name)
    if len(ordered) <= max_views:
        return ordered
    indices = np.linspace(0, len(ordered) - 1, max_views, dtype=np.int64)
    return [ordered[int(index)] for index in np.unique(indices)]


def load_mask(path: Path) -> np.ndarray:
    return np.array(Image.open(path).convert("L"), dtype=np.uint8) > 127


def filter_points(
    points: np.ndarray,
    cameras: dict[int, Camera],
    images: list[RegisteredImage],
    masks_dir: Path,
    min_visible_views: int,
    min_foreground_ratio: float,
    max_views: int,
) -> tuple[np.ndarray, dict[str, int | float]]:
    candidate_views: list[tuple[RegisteredImage, Camera, np.ndarray]] = []
    for registered in evenly_sample_images(images, max_views):
        camera = cameras.get(registered.camera_id)
        mask_path = masks_dir / f"{Path(registered.name).stem}.png"
        if camera is None or not mask_path.exists():
            continue
        candidate_views.append((registered, camera, load_mask(mask_path)))

    if not candidate_views:
        raise ValueError("No registered COLMAP images have matching foreground masks")

    visible_counts = np.zeros(points.shape[0], dtype=np.uint16)
    foreground_counts = np.zeros(points.shape[0], dtype=np.uint16)
    chunk_size = 200_000

    for registered, camera, mask in candidate_views:
        mask_height, mask_width = mask.shape
        for start in range(0, points.shape[0], chunk_size):
            end = min(start + chunk_size, points.shape[0])
            world = points[start:end]
            camera_points = (registered.rotation @ world.T).T + registered.translation
            depth = camera_points[:, 2]
            in_front = depth > 1e-8
            safe_depth = np.where(in_front, depth, 1.0)
            norm_x = camera_points[:, 0] / safe_depth
            norm_y = camera_points[:, 1] / safe_depth
            pixel_x, pixel_y = project_normalized(camera, norm_x, norm_y)
            pixel_x *= mask_width / camera.width
            pixel_y *= mask_height / camera.height
            ix = np.rint(pixel_x).astype(np.int64)
            iy = np.rint(pixel_y).astype(np.int64)
            visible = in_front & (ix >= 0) & (ix < mask_width) & (iy >= 0) & (iy < mask_height)
            local_visible = np.flatnonzero(visible)
            visible_counts[start + local_visible] += 1
            if local_visible.size > 0:
                local_foreground = local_visible[mask[iy[local_visible], ix[local_visible]]]
                foreground_counts[start + local_foreground] += 1

    required_views = min(max(1, min_visible_views), len(candidate_views))
    foreground_ratios = np.divide(
        foreground_counts,
        visible_counts,
        out=np.zeros(points.shape[0], dtype=np.float64),
        where=visible_counts > 0,
    )
    keep = (foreground_counts >= required_views) & (foreground_ratios >= min_foreground_ratio)
    metrics: dict[str, int | float] = {
        "viewCount": len(candidate_views),
        "requiredViews": required_views,
        "visiblePointCount": int(np.count_nonzero(visible_counts)),
        "foregroundEvidencePointCount": int(np.count_nonzero(foreground_counts)),
    }
    return keep, metrics


def main() -> int:
    parser = argparse.ArgumentParser(description="Filter PLY points using registered COLMAP foreground masks")
    parser.add_argument("--input-ply", required=True)
    parser.add_argument("--output-ply", required=True)
    parser.add_argument("--sparse-dir", required=True, help="COLMAP text model containing cameras.txt and images.txt")
    parser.add_argument("--masks-dir", required=True)
    parser.add_argument("--min-visible-views", type=int, default=3)
    parser.add_argument("--min-foreground-ratio", type=float, default=0.6)
    parser.add_argument("--max-views", type=int, default=24)
    parser.add_argument("--min-retained-points", type=int, default=100)
    parser.add_argument("--min-retained-ratio", type=float, default=0.01)
    args = parser.parse_args()

    input_ply = Path(args.input_ply)
    output_ply = Path(args.output_ply)
    sparse_dir = Path(args.sparse_dir)
    masks_dir = Path(args.masks_dir)

    try:
        cameras = read_cameras_text(sparse_dir / "cameras.txt")
        images = read_images_text(sparse_dir / "images.txt")
        point_cloud = o3d.io.read_point_cloud(str(input_ply))
        points = np.asarray(point_cloud.points)
        if points.shape[0] == 0:
            raise ValueError("Input PLY contains no points")

        keep, metrics = filter_points(
            points,
            cameras,
            images,
            masks_dir,
            args.min_visible_views,
            args.min_foreground_ratio,
            args.max_views,
        )
        retained_count = int(np.count_nonzero(keep))
        retained_ratio = retained_count / points.shape[0]
        if retained_count < args.min_retained_points or retained_ratio < args.min_retained_ratio:
            raise ValueError(
                f"Mask filter retained only {retained_count}/{points.shape[0]} points "
                f"({retained_ratio:.4f}); keeping the unfiltered reconstruction"
            )

        filtered = o3d.geometry.PointCloud()
        filtered.points = o3d.utility.Vector3dVector(points[keep])
        if point_cloud.has_colors():
            filtered.colors = o3d.utility.Vector3dVector(np.asarray(point_cloud.colors)[keep])
        if point_cloud.has_normals():
            filtered.normals = o3d.utility.Vector3dVector(np.asarray(point_cloud.normals)[keep])
        output_ply.parent.mkdir(parents=True, exist_ok=True)
        if not o3d.io.write_point_cloud(str(output_ply), filtered):
            raise RuntimeError(f"Failed to write filtered point cloud: {output_ply}")

        print(
            json.dumps(
                {
                    "status": "ok",
                    "inputPointCount": int(points.shape[0]),
                    "retainedPointCount": retained_count,
                    "retainedRatio": retained_ratio,
                    **metrics,
                }
            ),
            flush=True,
        )
        return 0
    except Exception as exc:
        print(json.dumps({"status": "error", "error": str(exc)}), flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
