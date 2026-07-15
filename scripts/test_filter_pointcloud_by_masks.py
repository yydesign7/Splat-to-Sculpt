#!/usr/bin/env python3
"""Regression test for multi-view foreground-mask point filtering."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import open3d as o3d
from PIL import Image


def write_colmap_text_model(sparse_dir: Path, masks_dir: Path) -> None:
    sparse_dir.mkdir(parents=True)
    masks_dir.mkdir(parents=True)
    (sparse_dir / "cameras.txt").write_text(
        "# CAMERA_ID, MODEL, WIDTH, HEIGHT, PARAMS[]\n"
        "1 PINHOLE 100 100 100 100 50 50\n",
        encoding="utf-8",
    )

    image_lines = ["# IMAGE_ID, QW, QX, QY, QZ, TX, TY, TZ, CAMERA_ID, NAME"]
    for image_id in range(1, 4):
        name = f"frame_{image_id:04d}.jpg"
        image_lines.extend([f"{image_id} 1 0 0 0 0 0 0 1 {name}", ""])
        mask = np.zeros((100, 100), dtype=np.uint8)
        mask[40:61, 40:61] = 255
        Image.fromarray(mask, mode="L").save(masks_dir / f"frame_{image_id:04d}.png")
    (sparse_dir / "images.txt").write_text("\n".join(image_lines) + "\n", encoding="utf-8")
    (sparse_dir / "points3D.txt").write_text("", encoding="utf-8")


def write_input_ply(path: Path) -> None:
    point_cloud = o3d.geometry.PointCloud()
    point_cloud.points = o3d.utility.Vector3dVector(
        np.array(
            [
                [0.0, 0.0, 2.0],
                [0.7, 0.0, 2.0],
            ],
            dtype=np.float64,
        )
    )
    point_cloud.colors = o3d.utility.Vector3dVector(
        np.array(
            [
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
            ],
            dtype=np.float64,
        )
    )
    assert o3d.io.write_point_cloud(str(path), point_cloud)


def main() -> int:
    script = Path(__file__).with_name("filter_pointcloud_by_masks.py")
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        sparse_dir = root / "sparse"
        masks_dir = root / "masks"
        input_ply = root / "input.ply"
        output_ply = root / "output.ply"
        write_colmap_text_model(sparse_dir, masks_dir)
        write_input_ply(input_ply)

        result = subprocess.run(
            [
                sys.executable,
                str(script),
                "--input-ply",
                str(input_ply),
                "--output-ply",
                str(output_ply),
                "--sparse-dir",
                str(sparse_dir),
                "--masks-dir",
                str(masks_dir),
                "--min-visible-views",
                "3",
                "--min-foreground-ratio",
                "0.6",
                "--min-retained-points",
                "1",
            ],
            text=True,
            capture_output=True,
        )
        assert result.returncode == 0, result.stderr or result.stdout
        payload = json.loads(result.stdout.strip().splitlines()[-1])
        assert payload["status"] == "ok"
        assert payload["inputPointCount"] == 2
        assert payload["retainedPointCount"] == 1

        filtered = o3d.io.read_point_cloud(str(output_ply))
        points = np.asarray(filtered.points)
        assert points.shape == (1, 3)
        assert np.allclose(points[0], [0.0, 0.0, 2.0])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
