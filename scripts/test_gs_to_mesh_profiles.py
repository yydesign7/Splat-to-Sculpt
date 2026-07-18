#!/usr/bin/env python3
from __future__ import annotations

import math
from pathlib import Path
import sys

import numpy as np
import open3d as o3d

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from gs_to_mesh import (  # noqa: E402
    choose_reconstruction_profile,
    get_reconstruction_profile,
    get_reconstruction_profile_names,
)


def make_pcd(points: np.ndarray) -> o3d.geometry.PointCloud:
    pcd = o3d.geometry.PointCloud()
    pcd.points = o3d.utility.Vector3dVector(points.astype(np.float64))
    return pcd


def cylinder_points(radius: float = 1.0, height: float = 5.0, rings: int = 80, sides: int = 64) -> np.ndarray:
    pts = []
    for iz in range(rings):
        z = -height / 2 + height * iz / max(1, rings - 1)
        for ia in range(sides):
            a = 2 * math.pi * ia / sides
            pts.append([radius * math.cos(a), radius * math.sin(a), z])
    return np.asarray(pts, dtype=np.float64)


def flat_panel_points(size: float = 4.0, grid: int = 80) -> np.ndarray:
    xs = np.linspace(-size / 2, size / 2, grid)
    ys = np.linspace(-size / 2, size / 2, grid)
    xx, yy = np.meshgrid(xs, ys)
    zz = np.zeros_like(xx)
    return np.column_stack([xx.ravel(), yy.ravel(), zz.ravel()])


def noisy_multi_cluster_points(seed: int = 7) -> np.ndarray:
    rng = np.random.default_rng(seed)
    clusters = []
    for center in [(-3, 0, 0), (3, 0, 0), (0, 3, 0), (0, -3, 0), (0, 0, 3)]:
        clusters.append(rng.normal(loc=np.asarray(center), scale=0.12, size=(180, 3)))
    noise = rng.uniform(-5, 5, size=(500, 3))
    return np.vstack([*clusters, noise])


def assert_equal(actual: object, expected: object, message: str) -> None:
    if actual != expected:
        raise AssertionError(f"{message}: expected {expected!r}, got {actual!r}")


def test_profile_registry() -> None:
    names = get_reconstruction_profile_names()
    for expected in [
        "default_general",
        "closed_solid",
        "thin_structure",
        "flat_panel",
        "high_detail_ornamental",
        "noisy_scan",
    ]:
        if expected not in names:
            raise AssertionError(f"Missing reconstruction profile: {expected}")

    closed = get_reconstruction_profile("closed_solid")
    assert_equal(closed.orient_mode, "consistent_only", "closed_solid should avoid camera-facing normal flips")
    assert_equal(closed.density_percentile, 1.0, "closed_solid should use weak density clipping")


def test_auto_profile_for_closed_cylinder() -> None:
    decision = choose_reconstruction_profile(make_pcd(cylinder_points()), input_representation="pointcloud")
    assert_equal(decision.profile.name, "closed_solid", "cylindrical solid should select closed_solid")


def test_auto_profile_for_flat_panel() -> None:
    decision = choose_reconstruction_profile(make_pcd(flat_panel_points()), input_representation="pointcloud")
    assert_equal(decision.profile.name, "flat_panel", "dominant flat panel should select flat_panel")


def test_auto_profile_for_noisy_multi_cluster_scan() -> None:
    decision = choose_reconstruction_profile(make_pcd(noisy_multi_cluster_points()), input_representation="pointcloud")
    assert_equal(decision.profile.name, "noisy_scan", "many clusters plus noise should select noisy_scan")


if __name__ == "__main__":
    test_profile_registry()
    test_auto_profile_for_closed_cylinder()
    test_auto_profile_for_flat_panel()
    test_auto_profile_for_noisy_multi_cluster_scan()
    print("PASS: gs_to_mesh reconstruction profiles")
