#!/usr/bin/env python3
"""
Point cloud to mesh conversion pipeline using Poisson Surface Reconstruction.
Designed to be called from Node.js backend as a command-line tool.

Usage:
  python3 gs_to_mesh.py --input <ply_path> --output-dir <dir> --format <glb|obj|ply>
"""

import open3d as o3d
# Suppress Open3D log output to avoid polluting JSON stdout
o3d.utility.set_verbosity_level(o3d.utility.VerbosityLevel.Error)
import numpy as np
import argparse
import os
import sys
import json
import struct
import math
from dataclasses import dataclass
from typing import Any

# Slightly lower depth: fewer spurious high-frequency sheets on thin parts (e.g. chair legs).
POISSON_DEPTH = 8
# Denser trim: remove more low-confidence Poisson vertices (typical "flying" sheets).
DENSITY_PERCENTILE = 7.0
# A bit coarser voxels: smoother input, less noise for Poisson to overfit.
VOXEL_FRAC = 0.0065
C0 = 0.28209479177387814


@dataclass(frozen=True)
class ReconstructionProfile:
    name: str
    depth: int
    density_percentile: float | None
    voxel_frac: float
    normal_radius_mult: float
    normal_max_nn: int
    orient_k: int
    orient_mode: str
    poisson_scale: float = 1.05
    linear_fit: bool = False
    statistical_nb_neighbors: int = 20
    statistical_std_ratio: float = 2.0
    radius_outlier_enabled: bool = True
    radius_nb_points: int = 10
    radius_mult: float = 2.5
    radius_min_scale: float = 0.0008
    radius_min_retention: float = 0.45
    island_min_triangles: int = 25
    island_fraction: float = 0.0010
    smooth_iterations: int = 1
    smooth_lambda: float = 0.32


@dataclass(frozen=True)
class ProfileDecision:
    requested_profile: str
    profile: ReconstructionProfile
    scores: dict[str, float]
    features: dict[str, Any]
    reason: str


RECONSTRUCTION_PROFILES: dict[str, ReconstructionProfile] = {
    "default_general": ReconstructionProfile(
        name="default_general",
        depth=8,
        density_percentile=7.0,
        voxel_frac=0.0065,
        normal_radius_mult=3.0,
        normal_max_nn=80,
        orient_k=100,
        orient_mode="towards_camera",
    ),
    "closed_solid": ReconstructionProfile(
        name="closed_solid",
        depth=8,
        density_percentile=1.0,
        voxel_frac=0.0065,
        normal_radius_mult=5.0,
        normal_max_nn=120,
        orient_k=120,
        orient_mode="consistent_only",
        island_fraction=0.0008,
    ),
    "thin_structure": ReconstructionProfile(
        name="thin_structure",
        depth=8,
        density_percentile=2.0,
        voxel_frac=0.0055,
        normal_radius_mult=4.0,
        normal_max_nn=100,
        orient_k=120,
        orient_mode="consistent_only",
        radius_outlier_enabled=False,
        island_min_triangles=10,
        island_fraction=0.0002,
        smooth_iterations=0,
    ),
    "flat_panel": ReconstructionProfile(
        name="flat_panel",
        depth=7,
        density_percentile=2.0,
        voxel_frac=0.0075,
        normal_radius_mult=5.0,
        normal_max_nn=120,
        orient_k=120,
        orient_mode="towards_camera",
        smooth_iterations=1,
        smooth_lambda=0.22,
    ),
    "high_detail_ornamental": ReconstructionProfile(
        name="high_detail_ornamental",
        depth=8,
        density_percentile=1.0,
        voxel_frac=0.0045,
        normal_radius_mult=3.5,
        normal_max_nn=120,
        orient_k=120,
        orient_mode="consistent_only",
        radius_min_retention=0.30,
        island_min_triangles=8,
        island_fraction=0.00015,
        smooth_iterations=0,
    ),
    "noisy_scan": ReconstructionProfile(
        name="noisy_scan",
        depth=7,
        density_percentile=8.0,
        voxel_frac=0.0090,
        normal_radius_mult=4.0,
        normal_max_nn=80,
        orient_k=80,
        orient_mode="towards_camera",
        statistical_std_ratio=1.5,
        radius_nb_points=12,
        radius_mult=3.0,
        radius_min_retention=0.35,
        island_fraction=0.0015,
        smooth_iterations=2,
        smooth_lambda=0.25,
    ),
}


def get_reconstruction_profile_names() -> list[str]:
    return list(RECONSTRUCTION_PROFILES.keys())


def get_reconstruction_profile(name: str) -> ReconstructionProfile:
    if name == "default":
        name = "default_general"
    profile = RECONSTRUCTION_PROFILES.get(name)
    if profile is None:
        valid = ", ".join(["auto", *get_reconstruction_profile_names()])
        raise ValueError(f"Unknown reconstruction profile: {name}. Valid profiles: {valid}")
    return profile


def _parse_ply_header(input_path: str):
    with open(input_path, "rb") as f:
        header_lines = []
        while True:
            line = f.readline()
            if not line:
                raise RuntimeError("Invalid PLY: missing end_header")
            decoded = line.decode("utf-8", errors="replace").strip()
            header_lines.append(decoded)
            if decoded == "end_header":
                break
        payload_offset = f.tell()

    if not header_lines or header_lines[0] != "ply":
        raise RuntimeError("Input is not a PLY file")

    fmt = "ascii"
    vertex_count = 0
    properties = []
    in_vertex = False
    for line in header_lines:
        parts = line.split()
        if not parts:
            continue
        if parts[0] == "format":
            fmt = parts[1]
        elif parts[:2] == ["element", "vertex"]:
            vertex_count = int(parts[2])
            in_vertex = True
        elif parts[0] == "element" and parts[1] != "vertex":
            in_vertex = False
        elif in_vertex and parts[0] == "property" and len(parts) >= 3:
            properties.append((parts[1], parts[2]))

    return fmt, vertex_count, properties, payload_offset


def _is_gaussian_splat_ply(properties) -> bool:
    names = {name for _typ, name in properties}
    return {"x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "rot_0"}.issubset(names)


def _read_gaussian_splat_ply(input_path: str) -> o3d.geometry.PointCloud:
    fmt, vertex_count, properties, payload_offset = _parse_ply_header(input_path)
    if vertex_count <= 0:
        raise RuntimeError("PLY has no vertices")

    prop_names = [name for _typ, name in properties]
    ix, iy, iz = prop_names.index("x"), prop_names.index("y"), prop_names.index("z")
    ir, ig, ib = prop_names.index("f_dc_0"), prop_names.index("f_dc_1"), prop_names.index("f_dc_2")
    iopacity = prop_names.index("opacity") if "opacity" in prop_names else None

    points = np.zeros((vertex_count, 3), dtype=np.float64)
    colors = np.zeros((vertex_count, 3), dtype=np.float64)
    keep = np.ones(vertex_count, dtype=bool)

    def row_to_arrays(i: int, vals):
        points[i] = [float(vals[ix]), float(vals[iy]), float(vals[iz])]
        rgb = np.array([float(vals[ir]), float(vals[ig]), float(vals[ib])], dtype=np.float64) * C0 + 0.5
        colors[i] = np.clip(rgb, 0.0, 1.0)
        if iopacity is not None:
            opacity = 1.0 / (1.0 + math.exp(-float(vals[iopacity])))
            keep[i] = opacity > 0.01

    with open(input_path, "rb") as f:
        f.seek(payload_offset)
        if fmt == "ascii":
            for i in range(vertex_count):
                vals = f.readline().decode("utf-8", errors="replace").strip().split()
                if len(vals) < len(properties):
                    raise RuntimeError(f"Invalid ASCII PLY vertex row {i}")
                row_to_arrays(i, vals)
        elif fmt == "binary_little_endian":
            type_map = {
                "char": ("b", 1),
                "uchar": ("B", 1),
                "int8": ("b", 1),
                "uint8": ("B", 1),
                "short": ("h", 2),
                "ushort": ("H", 2),
                "int16": ("h", 2),
                "uint16": ("H", 2),
                "int": ("i", 4),
                "uint": ("I", 4),
                "int32": ("i", 4),
                "uint32": ("I", 4),
                "float": ("f", 4),
                "float32": ("f", 4),
                "double": ("d", 8),
                "float64": ("d", 8),
            }
            fmt_chars = []
            for typ, _name in properties:
                if typ not in type_map:
                    raise RuntimeError(f"Unsupported PLY property type: {typ}")
                fmt_chars.append(type_map[typ][0])
            row_fmt = "<" + "".join(fmt_chars)
            row_size = struct.calcsize(row_fmt)
            for i in range(vertex_count):
                row = f.read(row_size)
                if len(row) != row_size:
                    raise RuntimeError(f"Unexpected EOF in binary PLY row {i}")
                row_to_arrays(i, struct.unpack(row_fmt, row))
        else:
            raise RuntimeError(f"Unsupported PLY format: {fmt}")

    points = points[keep]
    colors = colors[keep]
    pcd = o3d.geometry.PointCloud()
    pcd.points = o3d.utility.Vector3dVector(points)
    pcd.colors = o3d.utility.Vector3dVector(colors)
    return pcd


def read_input_point_cloud(input_path: str) -> tuple[o3d.geometry.PointCloud, str]:
    fmt, vertex_count, properties, _payload_offset = _parse_ply_header(input_path)
    if vertex_count <= 0:
        pcd = o3d.geometry.PointCloud()
        return pcd, "empty"
    if _is_gaussian_splat_ply(properties):
        return _read_gaussian_splat_ply(input_path), "splat"
    return o3d.io.read_point_cloud(input_path), "pointcloud"


def _sample_points(points: np.ndarray, max_points: int = 30000) -> np.ndarray:
    if len(points) <= max_points:
        return points
    step = max(1, len(points) // max_points)
    sampled = points[::step]
    return sampled[:max_points]


def _safe_ratio(num: float, den: float, fallback: float = 0.0) -> float:
    if abs(den) < 1e-12:
        return fallback
    return float(num / den)


def analyze_pointcloud_geometry(pcd: o3d.geometry.PointCloud) -> dict[str, Any]:
    points = np.asarray(pcd.points)
    point_count = int(len(points))
    if point_count == 0:
        return {
            "point_count": 0,
            "bbox_diag": 0.0,
            "cluster_count": 0,
            "noise_ratio": 1.0,
            "plane_ratio": 0.0,
            "flatness": 0.0,
            "elongation": 0.0,
            "radial_cv": 999.0,
            "density_cv": 999.0,
        }

    sample = _sample_points(points)
    min_bound = sample.min(axis=0)
    max_bound = sample.max(axis=0)
    extents = np.maximum(max_bound - min_bound, 1e-9)
    sorted_extents = np.sort(extents)
    bbox_diag = float(np.linalg.norm(extents))
    flatness = _safe_ratio(float(sorted_extents[0]), float(sorted_extents[1]), 0.0)
    elongation = _safe_ratio(float(sorted_extents[2]), float(sorted_extents[1]), 999.0)
    thickness_ratio = _safe_ratio(float(sorted_extents[0]), float(sorted_extents[2]), 0.0)

    sample_pcd = o3d.geometry.PointCloud()
    sample_pcd.points = o3d.utility.Vector3dVector(sample)

    nn = np.asarray(sample_pcd.compute_nearest_neighbor_distance())
    density_cv = 999.0
    if len(nn) > 5 and float(np.mean(nn)) > 1e-12:
        density_cv = float(np.std(nn) / np.mean(nn))

    dbscan_eps = max(bbox_diag * 0.025, 0.003)
    labels = np.array(sample_pcd.cluster_dbscan(eps=dbscan_eps, min_points=20))
    cluster_count = int(labels.max() + 1) if labels.size and int(labels.max()) >= 0 else 0
    noise_ratio = float(np.count_nonzero(labels < 0) / len(labels)) if labels.size else 1.0

    plane_ratio = 0.0
    if len(sample) >= 80:
        try:
            _plane, inliers = sample_pcd.segment_plane(
                distance_threshold=max(bbox_diag * 0.008, 0.002),
                ransac_n=3,
                num_iterations=80,
            )
            plane_ratio = float(len(inliers) / len(sample))
        except (RuntimeError, ValueError):
            plane_ratio = 0.0

    radial_cv = 999.0
    if len(sample) >= 10:
        centered = sample - sample.mean(axis=0)
        try:
            cov = np.cov(centered, rowvar=False)
            eigvals, eigvecs = np.linalg.eigh(cov)
            axis = eigvecs[:, int(np.argmax(eigvals))]
            axial = centered @ axis
            radial_vecs = centered - np.outer(axial, axis)
            radial = np.linalg.norm(radial_vecs, axis=1)
            radial_mean = float(np.mean(radial))
            if radial_mean > 1e-9:
                radial_cv = float(np.std(radial) / radial_mean)
        except (RuntimeError, ValueError, np.linalg.LinAlgError):
            radial_cv = 999.0

    return {
        "point_count": point_count,
        "sample_count": int(len(sample)),
        "bbox_diag": bbox_diag,
        "extents": [float(v) for v in extents.tolist()],
        "flatness": flatness,
        "elongation": elongation,
        "thickness_ratio": thickness_ratio,
        "cluster_count": cluster_count,
        "noise_ratio": noise_ratio,
        "plane_ratio": plane_ratio,
        "radial_cv": radial_cv,
        "density_cv": density_cv,
        "dbscan_eps": dbscan_eps,
    }


def score_reconstruction_profiles(features: dict[str, Any], input_representation: str) -> dict[str, float]:
    cluster_count = int(features.get("cluster_count", 0))
    noise_ratio = float(features.get("noise_ratio", 1.0))
    plane_ratio = float(features.get("plane_ratio", 0.0))
    flatness = float(features.get("flatness", 0.0))
    elongation = float(features.get("elongation", 0.0))
    thickness_ratio = float(features.get("thickness_ratio", 1.0))
    radial_cv = float(features.get("radial_cv", 999.0))
    density_cv = float(features.get("density_cv", 999.0))
    point_count = int(features.get("point_count", 0))

    scores = {
        "default_general": 1.0,
        "closed_solid": 0.0,
        "thin_structure": 0.0,
        "flat_panel": 0.0,
        "high_detail_ornamental": 0.0,
        "noisy_scan": 0.0,
    }

    if input_representation == "splat":
        scores["noisy_scan"] += 1.5
        scores["default_general"] += 0.5

    if noise_ratio > 0.18:
        scores["noisy_scan"] += 5.0
    elif noise_ratio > 0.08:
        scores["noisy_scan"] += 2.0
    if cluster_count > 4:
        scores["noisy_scan"] += 4.0
    elif cluster_count > 2:
        scores["noisy_scan"] += 2.0
    if density_cv > 1.3:
        scores["noisy_scan"] += 2.0

    if plane_ratio > 0.55:
        scores["flat_panel"] += 5.0
    if flatness < 0.10:
        scores["flat_panel"] += 3.0
    if thickness_ratio < 0.06:
        scores["flat_panel"] += 2.0

    if cluster_count <= 1:
        scores["closed_solid"] += 2.0
    if noise_ratio < 0.05:
        scores["closed_solid"] += 1.0
    if radial_cv < 0.28:
        scores["closed_solid"] += 4.0
    elif radial_cv < 0.42:
        scores["closed_solid"] += 2.0
    if elongation > 1.15:
        scores["closed_solid"] += 1.0
    if plane_ratio < 0.35:
        scores["closed_solid"] += 1.0
    if flatness < 0.10:
        scores["closed_solid"] -= 4.0

    if thickness_ratio < 0.12 and plane_ratio < 0.45:
        scores["thin_structure"] += 3.0
    if elongation > 4.0:
        scores["thin_structure"] += 2.0
    if cluster_count > 1 and noise_ratio < 0.18:
        scores["thin_structure"] += 1.5
    if radial_cv < 0.28 and cluster_count <= 1:
        scores["thin_structure"] -= 2.0

    if point_count > 120000 and noise_ratio < 0.08 and plane_ratio < 0.45:
        scores["high_detail_ornamental"] += 2.0
    if cluster_count <= 2:
        scores["high_detail_ornamental"] += 1.0
    if thickness_ratio < 0.08:
        scores["high_detail_ornamental"] -= 1.0

    return scores


def choose_reconstruction_profile(
    pcd: o3d.geometry.PointCloud,
    input_representation: str,
    requested_profile: str = "auto",
) -> ProfileDecision:
    requested = requested_profile or "auto"
    if requested != "auto":
        profile = get_reconstruction_profile(requested)
        return ProfileDecision(
            requested_profile=requested,
            profile=profile,
            scores={profile.name: 999.0},
            features={},
            reason=f"forced:{profile.name}",
        )

    features = analyze_pointcloud_geometry(pcd)
    scores = score_reconstruction_profiles(features, input_representation)
    selected_name = max(scores, key=lambda name: scores[name])

    # Avoid selecting a specialized profile on weak evidence.
    if selected_name != "default_general" and scores[selected_name] < 4.0:
        selected_name = "default_general"

    profile = get_reconstruction_profile(selected_name)
    reason = (
        f"auto:{selected_name}; "
        f"clusters={features.get('cluster_count')}, "
        f"noise={features.get('noise_ratio'):.3f}, "
        f"plane={features.get('plane_ratio'):.3f}, "
        f"radial_cv={features.get('radial_cv'):.3f}"
    )
    return ProfileDecision(
        requested_profile=requested,
        profile=profile,
        scores=scores,
        features=features,
        reason=reason,
    )


def estimate_poisson_normals(
    pcd: o3d.geometry.PointCloud,
    voxel_size: float,
    scale: float,
    profile: ReconstructionProfile,
):
    """Estimate stable, consistently oriented normals for Poisson reconstruction."""
    nn_distances = np.asarray(pcd.compute_nearest_neighbor_distance())
    median_nn = float(np.median(nn_distances)) if len(nn_distances) > 0 else voxel_size

    normal_radius = max(voxel_size * profile.normal_radius_mult, median_nn * 8.0, scale * 0.005)

    pcd.estimate_normals(
        search_param=o3d.geometry.KDTreeSearchParamHybrid(
            radius=normal_radius,
            max_nn=profile.normal_max_nn,
        )
    )
    pcd.normalize_normals()

    orient_k = min(profile.orient_k, max(10, len(pcd.points) // 20))
    pcd.orient_normals_consistent_tangent_plane(orient_k)

    if profile.orient_mode == "consistent_only":
        return
    if profile.orient_mode != "towards_camera":
        raise ValueError(f"Unsupported normal orientation mode: {profile.orient_mode}")

    min_b = pcd.get_min_bound()
    max_b = pcd.get_max_bound()
    diag = max_b - min_b
    extent = float(np.linalg.norm(diag)) if float(np.linalg.norm(diag)) > 1e-9 else 1.0
    # Camera sits above + along diagonal so typical upright scans are covered.
    camera = max_b + diag * 0.75 + np.array([0.0, extent * 0.35, 0.0])
    pcd.orient_normals_towards_camera_location(camera)


def _remove_tiny_island_meshes(
    mesh: o3d.geometry.TriangleMesh,
    min_triangles: int = 25,
    fraction: float = 0.0010,
) -> o3d.geometry.TriangleMesh:
    """Remove only very small connected triangle islands (typical 'fly' patches), not main geometry."""
    ntri = int(len(mesh.triangles))
    if ntri < 4:
        return mesh
    try:
        clus, counts, _ = mesh.cluster_connected_triangles()
    except (AttributeError, RuntimeError, ValueError):
        return mesh
    clus = np.asarray(clus, dtype=np.int32)
    counts = np.asarray(counts, dtype=np.int64)
    if counts.size == 0:
        return mesh
    # Dropping only small islands removes specks while keeping substantial disjoint parts.
    thresh = max(min_triangles, int(fraction * ntri))
    to_remove = np.zeros(ntri, dtype=bool)
    for i, c in enumerate(counts):
        if c < thresh:
            to_remove |= clus == i
    if not np.any(to_remove):
        return mesh
    mesh.remove_triangles_by_mask(to_remove.tolist())
    mesh.remove_unreferenced_vertices()
    return mesh


def run_pipeline(
    input_path: str,
    output_dir: str,
    output_format: str,
    reconstruction_profile: str = "auto",
):
    os.makedirs(output_dir, exist_ok=True)

    # Read point cloud or Gaussian Splat PLY centers
    pcd, input_representation = read_input_point_cloud(input_path)
    if len(pcd.points) == 0:
        print(json.dumps({"status": "error", "error": "PLY file has no point data"}), flush=True)
        return

    point_count = len(pcd.points)
    has_colors = pcd.has_colors()
    profile_decision = choose_reconstruction_profile(
        pcd,
        input_representation=input_representation,
        requested_profile=reconstruction_profile,
    )
    profile = profile_decision.profile
    print(f"[gs_to_mesh] reconstruction profile: {profile_decision.reason}", file=sys.stderr, flush=True)

    # Adaptive voxel size
    center = pcd.get_center()
    max_bound = pcd.get_max_bound()
    scale = float(np.linalg.norm(max_bound - center))
    if scale == 0:
        scale = 1.0
    voxel_size = float(scale) * profile.voxel_frac

    # Downsample
    pcd_down = pcd.voxel_down_sample(voxel_size=voxel_size)

    # Remove outliers: tighter to drop sparse spikes before Poisson hallucinates surface.
    cl, ind = pcd_down.remove_statistical_outlier(
        nb_neighbors=profile.statistical_nb_neighbors,
        std_ratio=profile.statistical_std_ratio,
    )
    pcd_clean = pcd_down.select_by_index(ind)

    # Second pass: drop isolated clumps in radius neighborhood (mild, scale-aware)
    n_before = len(pcd_clean.points)
    r_rad = max(voxel_size * profile.radius_mult, scale * profile.radius_min_scale)
    if profile.radius_outlier_enabled and n_before >= 30:
        cl2, ind2 = pcd_clean.remove_radius_outlier(nb_points=profile.radius_nb_points, radius=r_rad)
        pcd_r = pcd_clean.select_by_index(ind2)
        # Avoid stripping thin structures: only apply if a majority of points remain
        if len(pcd_r.points) >= 10 and len(pcd_r.points) >= profile.radius_min_retention * n_before:
            pcd_clean = pcd_r

    if len(pcd_clean.points) < 10:
        print(
            json.dumps(
                {
                    "status": "error",
                    "error": "Too few points after denoising, cannot reconstruct mesh",
                }
            ),
            flush=True,
        )
        return

    # Estimate normals
    estimate_poisson_normals(pcd_clean, voxel_size, scale, profile)

    # Poisson reconstruction
    mesh, densities = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(
        pcd_clean,
        depth=profile.depth,
        scale=profile.poisson_scale,
        linear_fit=profile.linear_fit,
    )

    # Density clipping — trim low-implicit-surface confidence (fly sheets sit here)
    densities = np.asarray(densities)
    density_threshold = None
    removed_by_density = 0
    if profile.density_percentile is not None:
        density_threshold = float(np.percentile(densities, profile.density_percentile))
        density_mask = densities < density_threshold
        removed_by_density = int(np.count_nonzero(density_mask))
        mesh.remove_vertices_by_mask(density_mask)

    mesh = _remove_tiny_island_meshes(
        mesh,
        min_triangles=profile.island_min_triangles,
        fraction=profile.island_fraction,
    )
    try:
        mesh.remove_degenerate_triangles()
    except (AttributeError, RuntimeError, ValueError):
        pass
    try:
        mesh.remove_duplicated_triangles()
        mesh.remove_duplicated_vertices()
        mesh.remove_unreferenced_vertices()
    except (AttributeError, RuntimeError, ValueError):
        pass
    if len(mesh.vertices) < 3 or len(mesh.triangles) < 1:
        print(
            json.dumps(
                {
                    "status": "error",
                    "error": "Mesh was empty after trimming low-density and island regions; try a denser point cloud",
                }
            ),
            flush=True,
        )
        return

    # Mild Laplace smooth to shave needle-like spikes (not heavy blur)
    if profile.smooth_iterations > 0:
        try:
            mesh = mesh.filter_smooth_laplacian(
                number_of_iterations=profile.smooth_iterations,
                lambda_filter=profile.smooth_lambda,
            )
        except (AttributeError, RuntimeError, ValueError):
            pass

    mesh.compute_vertex_normals()

    # Transfer vertex colors from point cloud to mesh via nearest-neighbor projection
    if has_colors and pcd_clean.has_colors():
        try:
            from scipy.spatial import KDTree as SciKDTree

            pcd_points = np.asarray(pcd_clean.points)
            pcd_colors = np.asarray(pcd_clean.colors)
            mesh_vertices = np.asarray(mesh.vertices)
            n_verts = len(mesh_vertices)

            # Build KD-tree on point cloud and query nearest color for each mesh vertex
            tree = SciKDTree(pcd_points)
            _, indices = tree.query(mesh_vertices)
            mesh_colors = pcd_colors[indices]

            # Assign colors to mesh vertices
            mesh.vertex_colors = o3d.utility.Vector3dVector(mesh_colors)
        except ImportError:
            # scipy not available — skip color transfer
            print("[gs_to_mesh] scipy not available, skipping vertex color transfer", file=sys.stderr)
        except Exception as e:
            print(f"[gs_to_mesh] Vertex color transfer failed: {e}", file=sys.stderr)

    # Export based on format
    output_format = output_format.lower()
    if output_format == "glb":
        output_path = os.path.join(output_dir, "mesh.glb")
        try:
            o3d.io.write_triangle_mesh(output_path, mesh)
        except Exception as e:
            print(json.dumps({"status": "error", "error": f"GLB export failed: {str(e)}"}), flush=True)
            return
    elif output_format == "obj":
        output_path = os.path.join(output_dir, "mesh.obj")
        o3d.io.write_triangle_mesh(output_path, mesh)
    elif output_format == "ply":
        output_path = os.path.join(output_dir, "mesh.ply")
        o3d.io.write_triangle_mesh(output_path, mesh)
    else:
        print(json.dumps({"status": "error", "error": f"Unsupported format: {output_format}"}), flush=True)
        return

    # Count faces
    face_count = len(mesh.triangles)

    # Output result as JSON
    result = {
        "status": "done",
        "outputPath": output_path,
        "pointCount": point_count,
        "cleanPointCount": len(pcd_clean.points),
        "faceCount": face_count,
        "vertexCount": len(mesh.vertices),
        "inputRepresentation": input_representation,
        "requestedReconstructionProfile": reconstruction_profile,
        "reconstructionProfile": profile.name,
        "reconstructionReason": profile_decision.reason,
        "reconstructionFeatures": profile_decision.features,
        "reconstructionScores": profile_decision.scores,
        "densityThreshold": density_threshold,
        "removedByDensity": removed_by_density,
    }
    print(json.dumps(result), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Point cloud to mesh conversion")
    parser.add_argument("--input", required=True, help="Input PLY file path")
    parser.add_argument("--output-dir", required=True, help="Output directory")
    parser.add_argument("--format", required=True, choices=["glb", "obj", "ply"], help="Output format")
    parser.add_argument(
        "--reconstruction-profile",
        default="auto",
        choices=["auto", "default", *get_reconstruction_profile_names()],
        help="Poisson reconstruction profile. Use auto to choose from point-cloud geometry.",
    )
    args = parser.parse_args()

    try:
        run_pipeline(args.input, args.output_dir, args.format, args.reconstruction_profile)
    except Exception as e:  # noqa: BLE001 — always emit JSON for Node
        import traceback

        tb = traceback.format_exc()
        out = {
            "status": "error",
            "error": f"{type(e).__name__}: {e}",
            "traceback": (tb[:6000] + ("…" if len(tb) > 6000 else "")),
        }
        print(json.dumps(out), flush=True)
        # stderr for server logs; stdout last line is JSON
        print(tb, file=sys.stderr, flush=True)
        sys.exit(0)
