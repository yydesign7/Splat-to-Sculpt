#!/usr/bin/env python3
"""Regression tests for pointcloud_segment.py."""

import tempfile
from pathlib import Path

import numpy as np
import open3d as o3d

from pointcloud_segment import (
    compute_adaptive_params,
    segment_object_body_details,
)


def _axis_values(center: float, size: float, spacing: float) -> np.ndarray:
    count = max(2, int(round(size / spacing)) + 1)
    return np.linspace(center - size / 2, center + size / 2, count)


def _box_surface_points(center, size, spacing=0.04) -> np.ndarray:
    xs = _axis_values(center[0], size[0], spacing)
    ys = _axis_values(center[1], size[1], spacing)
    zs = _axis_values(center[2], size[2], spacing)
    points = []

    for x in (xs[0], xs[-1]):
        yy, zz = np.meshgrid(ys, zs, indexing="ij")
        points.append(np.column_stack([np.full(yy.size, x), yy.ravel(), zz.ravel()]))
    for y in (ys[0], ys[-1]):
        xx, zz = np.meshgrid(xs, zs, indexing="ij")
        points.append(np.column_stack([xx.ravel(), np.full(xx.size, y), zz.ravel()]))
    for z in (zs[0], zs[-1]):
        xx, yy = np.meshgrid(xs, ys, indexing="ij")
        points.append(np.column_stack([xx.ravel(), yy.ravel(), np.full(xx.size, z)]))

    merged = np.vstack(points)
    return np.unique(np.round(merged, 5), axis=0)


def _synthetic_chair_point_cloud() -> o3d.geometry.PointCloud:
    parts = [
        _box_surface_points((0.0, 0.0, 0.62), (2.0, 1.4, 0.12)),
        _box_surface_points((0.0, 0.68, 1.06), (2.0, 0.12, 0.88)),
    ]
    for x in (-0.78, 0.78):
        for y in (-0.48, 0.48):
            parts.append(_box_surface_points((x, y, 0.31), (0.16, 0.16, 0.62)))

    pcd = o3d.geometry.PointCloud()
    pcd.points = o3d.utility.Vector3dVector(np.vstack(parts))
    return pcd


def test_chair_like_point_cloud_groups_repeated_supports():
    pcd = _synthetic_chair_point_cloud()
    params = compute_adaptive_params(pcd)

    _, layer_info, _ = segment_object_body_details(
        pcd,
        object_index=0,
        params=params,
        layer_start_index=0,
    )

    layer_types = {layer["type"] for layer in layer_info}
    repeated_layers = [layer for layer in layer_info if layer["type"] == "repeated_parts"]
    body_layers = [layer for layer in layer_info if layer["type"] == "body"]

    assert "body" in layer_types
    assert "repeated_parts" in layer_types
    assert repeated_layers[0]["part_count"] >= 3
    assert repeated_layers[0]["point_count"] < body_layers[0]["point_count"]


def test_segment_all_cli_writes_repeated_layer_metadata():
    pcd = _synthetic_chair_point_cloud()
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        input_path = tmp_path / "chair.ply"
        output_path = tmp_path / "segmented.ply"
        layers_dir = tmp_path / "layers"
        o3d.io.write_point_cloud(str(input_path), pcd)

        import subprocess
        import sys

        subprocess.run(
            [
                sys.executable,
                str(Path(__file__).with_name("pointcloud_segment.py")),
                "--input",
                str(input_path),
                "--output_ply",
                str(output_path),
                "--layers_dir",
                str(layers_dir),
                "--mode",
                "segment_all",
            ],
            check=True,
        )

        meta = (layers_dir / "layers_meta.json").read_text()
        assert '"type": "repeated_parts"' in meta
        assert output_path.exists()


def test_continuous_tall_structure_does_not_fall_back_to_height_bands():
    parts = [
        _box_surface_points((0.0, 0.0, 0.22), (1.8, 1.8, 0.12)),
        _box_surface_points((0.0, 0.0, 0.68), (1.35, 1.20, 0.32)),
        _box_surface_points((0.0, 0.42, 1.22), (1.25, 0.20, 0.78)),
    ]
    pcd = o3d.geometry.PointCloud()
    pcd.points = o3d.utility.Vector3dVector(np.vstack(parts))
    params = compute_adaptive_params(pcd)

    _, layer_info, _ = segment_object_body_details(
        pcd,
        object_index=0,
        params=params,
        layer_start_index=0,
    )

    layer_types = {layer["type"] for layer in layer_info}
    assert "structural_band" not in layer_types


if __name__ == "__main__":
    test_chair_like_point_cloud_groups_repeated_supports()
    test_segment_all_cli_writes_repeated_layer_metadata()
    test_continuous_tall_structure_does_not_fall_back_to_height_bands()
    print("PASS: pointcloud segmentation layers")
