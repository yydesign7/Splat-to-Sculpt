#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import open3d as o3d

from gs_to_mesh import read_input_point_cloud
from gs_to_mesh import _remove_tiny_island_meshes


PROJECT_ROOT = Path(__file__).resolve().parents[1]
GS_TO_MESH = PROJECT_ROOT / "scripts" / "gs_to_mesh.py"


@dataclass(frozen=True)
class Variant:
    suffix: str
    label: str
    depth: int
    density_percentile: float | None
    voxel_frac: float
    normal_radius_mult: float
    normal_max_nn: int
    orient_k: int
    orient_mode: str
    linear_fit: bool
    use_current_pipeline: bool = False


VARIANTS = [
    Variant(
        suffix="baseline_current",
        label="Current project pipeline",
        depth=8,
        density_percentile=7.0,
        voxel_frac=0.0065,
        normal_radius_mult=3.0,
        normal_max_nn=80,
        orient_k=100,
        orient_mode="current",
        linear_fit=False,
        use_current_pipeline=True,
    ),
    Variant(
        suffix="weak_density_clip",
        label="Weak density clipping",
        depth=8,
        density_percentile=1.0,
        voxel_frac=0.0065,
        normal_radius_mult=3.0,
        normal_max_nn=80,
        orient_k=100,
        orient_mode="current",
        linear_fit=False,
    ),
    Variant(
        suffix="depth7_smooth_weak_clip",
        label="Lower Poisson depth + smoother input + weak clipping",
        depth=7,
        density_percentile=1.0,
        voxel_frac=0.008,
        normal_radius_mult=4.0,
        normal_max_nn=80,
        orient_k=100,
        orient_mode="current",
        linear_fit=False,
    ),
    Variant(
        suffix="consistent_normals_only",
        label="Consistent tangent-plane normals only",
        depth=8,
        density_percentile=1.0,
        voxel_frac=0.0065,
        normal_radius_mult=5.0,
        normal_max_nn=120,
        orient_k=120,
        orient_mode="consistent_only",
        linear_fit=False,
    ),
]


def parse_json_from_stdout(stdout: str) -> dict[str, Any]:
    for line in reversed(stdout.splitlines()):
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            continue
    raise RuntimeError(f"Could not find JSON result in output:\n{stdout}")


def run_current_pipeline(input_path: Path, output_dir: Path) -> dict[str, Any]:
    output_dir.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        [
            sys.executable,
            str(GS_TO_MESH),
            "--input",
            str(input_path),
            "--output-dir",
            str(output_dir),
            "--format",
            "glb",
        ],
        cwd=PROJECT_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    data = parse_json_from_stdout(result.stdout)
    if result.returncode != 0 or data.get("status") in {"error", "failed"}:
        raise RuntimeError(str(data.get("error") or result.stderr or result.stdout))
    return data


def estimate_variant_normals(pcd: o3d.geometry.PointCloud, voxel_size: float, scale: float, variant: Variant) -> None:
    nn_distances = np.asarray(pcd.compute_nearest_neighbor_distance())
    median_nn = float(np.median(nn_distances)) if len(nn_distances) > 0 else voxel_size
    normal_radius = max(voxel_size * variant.normal_radius_mult, median_nn * 8.0, scale * 0.005)

    pcd.estimate_normals(
        search_param=o3d.geometry.KDTreeSearchParamHybrid(
            radius=normal_radius,
            max_nn=variant.normal_max_nn,
        )
    )
    pcd.normalize_normals()
    orient_k = min(variant.orient_k, max(10, len(pcd.points) // 20))
    pcd.orient_normals_consistent_tangent_plane(orient_k)

    if variant.orient_mode == "current":
        min_b = pcd.get_min_bound()
        max_b = pcd.get_max_bound()
        diag = max_b - min_b
        extent = float(np.linalg.norm(diag)) if float(np.linalg.norm(diag)) > 1e-9 else 1.0
        camera = max_b + diag * 0.75 + np.array([0.0, extent * 0.35, 0.0])
        pcd.orient_normals_towards_camera_location(camera)


def transfer_colors_to_mesh(
    source_pcd: o3d.geometry.PointCloud,
    mesh: o3d.geometry.TriangleMesh,
) -> None:
    if not source_pcd.has_colors():
        return
    try:
        from scipy.spatial import KDTree as SciKDTree

        pcd_points = np.asarray(source_pcd.points)
        pcd_colors = np.asarray(source_pcd.colors)
        mesh_vertices = np.asarray(mesh.vertices)
        tree = SciKDTree(pcd_points)
        _, indices = tree.query(mesh_vertices)
        mesh.vertex_colors = o3d.utility.Vector3dVector(pcd_colors[indices])
    except Exception as exc:
        print(f"[compare_poisson] color transfer skipped: {exc}", file=sys.stderr)


def run_variant_pipeline(input_path: Path, output_dir: Path, variant: Variant) -> dict[str, Any]:
    output_dir.mkdir(parents=True, exist_ok=True)
    pcd, input_representation = read_input_point_cloud(str(input_path))
    if len(pcd.points) == 0:
        raise RuntimeError("PLY file has no point data")

    point_count = len(pcd.points)
    has_colors = pcd.has_colors()
    center = pcd.get_center()
    scale = float(np.linalg.norm(pcd.get_max_bound() - center))
    if scale == 0:
        scale = 1.0
    voxel_size = scale * variant.voxel_frac

    pcd_down = pcd.voxel_down_sample(voxel_size=voxel_size)
    _, ind = pcd_down.remove_statistical_outlier(nb_neighbors=20, std_ratio=2.0)
    pcd_clean = pcd_down.select_by_index(ind)

    n_before = len(pcd_clean.points)
    radius = max(voxel_size * 2.5, scale * 0.0008)
    if n_before >= 30:
        _, ind2 = pcd_clean.remove_radius_outlier(nb_points=10, radius=radius)
        pcd_radius = pcd_clean.select_by_index(ind2)
        if len(pcd_radius.points) >= 10 and len(pcd_radius.points) >= 0.45 * n_before:
            pcd_clean = pcd_radius

    if len(pcd_clean.points) < 10:
        raise RuntimeError("Too few points after denoising")

    estimate_variant_normals(pcd_clean, voxel_size, scale, variant)
    mesh, densities = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(
        pcd_clean,
        depth=variant.depth,
        scale=1.05,
        linear_fit=variant.linear_fit,
    )

    densities_np = np.asarray(densities)
    density_threshold = None
    removed_by_density = 0
    if variant.density_percentile is not None:
        density_threshold = float(np.percentile(densities_np, variant.density_percentile))
        mask = densities_np < density_threshold
        removed_by_density = int(np.count_nonzero(mask))
        mesh.remove_vertices_by_mask(mask)

    mesh = _remove_tiny_island_meshes(mesh)
    try:
        mesh.remove_degenerate_triangles()
        mesh.remove_duplicated_triangles()
        mesh.remove_duplicated_vertices()
        mesh.remove_unreferenced_vertices()
    except (AttributeError, RuntimeError, ValueError):
        pass

    if len(mesh.vertices) < 3 or len(mesh.triangles) < 1:
        raise RuntimeError("Mesh was empty after reconstruction")

    try:
        mesh = mesh.filter_smooth_laplacian(number_of_iterations=1, lambda_filter=0.32)
    except (AttributeError, RuntimeError, ValueError):
        pass
    mesh.compute_vertex_normals()
    if has_colors:
        transfer_colors_to_mesh(pcd_clean, mesh)

    output_path = output_dir / "mesh.glb"
    ok = o3d.io.write_triangle_mesh(str(output_path), mesh)
    if not ok or not output_path.is_file():
        raise RuntimeError(f"GLB export failed: {output_path}")

    return {
        "status": "done",
        "outputPath": str(output_path),
        "inputRepresentation": input_representation,
        "pointCount": point_count,
        "cleanPointCount": len(pcd_clean.points),
        "vertexCount": len(mesh.vertices),
        "faceCount": len(mesh.triangles),
        "densityThreshold": density_threshold,
        "removedByDensity": removed_by_density,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate Poisson reconstruction comparison GLBs.")
    parser.add_argument("--input", required=True, help="Input PLY path")
    parser.add_argument("--output-dir", required=True, help="Directory for comparison GLB files")
    parser.add_argument("--prefix", default="socket_cap_screw", help="Output filename prefix")
    args = parser.parse_args()

    input_path = Path(args.input).expanduser().resolve()
    output_dir = Path(args.output_dir).expanduser().resolve()
    if not input_path.is_file():
        raise FileNotFoundError(f"Input PLY does not exist: {input_path}")
    output_dir.mkdir(parents=True, exist_ok=True)

    outputs: list[dict[str, Any]] = []
    with tempfile.TemporaryDirectory(prefix="poisson_variants_") as temp_name:
        work_root = Path(temp_name)
        for variant in VARIANTS:
            print(f"[compare_poisson] running {variant.suffix}", flush=True)
            variant_dir = work_root / variant.suffix
            if variant.use_current_pipeline:
                result = run_current_pipeline(input_path, variant_dir)
            else:
                result = run_variant_pipeline(input_path, variant_dir, variant)

            generated_path = Path(str(result["outputPath"]))
            if not generated_path.is_absolute():
                generated_path = PROJECT_ROOT / generated_path

            final_path = output_dir / f"{args.prefix}_poisson_{variant.suffix}.glb"
            shutil.copyfile(generated_path, final_path)
            outputs.append(
                {
                    "suffix": variant.suffix,
                    "label": variant.label,
                    "output": str(final_path),
                    "settings": {
                        "depth": variant.depth,
                        "density_percentile": variant.density_percentile,
                        "voxel_frac": variant.voxel_frac,
                        "normal_radius_mult": variant.normal_radius_mult,
                        "normal_max_nn": variant.normal_max_nn,
                        "orient_k": variant.orient_k,
                        "orient_mode": variant.orient_mode,
                        "linear_fit": variant.linear_fit,
                    },
                    "result": {
                        key: result.get(key)
                        for key in [
                            "pointCount",
                            "cleanPointCount",
                            "vertexCount",
                            "faceCount",
                            "densityThreshold",
                            "removedByDensity",
                        ]
                    },
                    "file_size": final_path.stat().st_size,
                }
            )

    report_path = output_dir / f"{args.prefix}_poisson_variants_report.json"
    report_path.write_text(
        json.dumps(
            {
                "input": str(input_path),
                "outputs": outputs,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    print(json.dumps({"status": "done", "report": str(report_path), "outputs": outputs}, indent=2))


if __name__ == "__main__":
    main()
