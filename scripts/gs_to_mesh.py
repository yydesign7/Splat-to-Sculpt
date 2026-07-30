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
import copy
import os
import sys
import json
import struct
import math
from dataclasses import dataclass
from typing import Any

import trimesh

# Slightly lower depth: fewer spurious high-frequency sheets on thin parts (e.g. chair legs).
POISSON_DEPTH = 8
# Denser trim: remove more low-confidence Poisson vertices (typical "flying" sheets).
DENSITY_PERCENTILE = 7.0
# A bit coarser voxels: smoother input, less noise for Poisson to overfit.
VOXEL_FRAC = 0.0065
C0 = 0.28209479177387814

GEOMETRY_GRAPH_SURFACE_PROFILE = "geometry_graph_surface"

GEOMETRY_GRAPH_SURFACE_CONFIG: dict[str, float | int] = {
    "graph_scale_deg": 1200.0,
    "max_edge_angle_deg": 55.0,
    "normal_smoothing_iterations": 3,
    "normal_smoothing_gate_deg": 45.0,
    "min_region_faces": 500,
    "min_region_face_ratio": 0.015,
    "small_region_merge_angle_deg": 180.0,
    "planar_residual_ratio": 0.008,
    "curved_internal_angle_deg": 18.0,
    "max_surface_layers": 8,
}


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
    remove_flying_sheets_enabled: bool = True
    flying_sheet_support_radius_mult: float = 6.0
    flying_sheet_support_min_scale: float = 0.004
    flying_sheet_min_unsupported_vertex_ratio: float = 0.67
    flying_sheet_max_area_ratio: float = 0.08
    flying_sheet_max_face_ratio: float = 0.08
    flying_sheet_min_boundary_ratio: float = 0.08
    postprocess_max_area_loss_ratio: float = 0.10
    fill_small_holes_enabled: bool = True
    small_hole_max_area_ratio: float = 0.002
    small_hole_max_boundary_edges: int = 80


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
        postprocess_max_area_loss_ratio=0.22,
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
        flying_sheet_max_area_ratio=0.025,
        flying_sheet_max_face_ratio=0.025,
        postprocess_max_area_loss_ratio=0.03,
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
    if plane_ratio > 0.10 and radial_cv > 0.35 and elongation < 1.65:
        # Chair-like furniture often looks like one clean object in the point cloud,
        # but it is still an open structure. Avoid Poisson's closed-solid bias there.
        scores["closed_solid"] -= 3.5
        scores["default_general"] += 3.0

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


def _triangle_areas(vertices: np.ndarray, faces: np.ndarray) -> np.ndarray:
    if len(faces) == 0:
        return np.zeros(0, dtype=np.float64)
    a = vertices[faces[:, 0]]
    b = vertices[faces[:, 1]]
    c = vertices[faces[:, 2]]
    return 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)


def _mesh_area(mesh: o3d.geometry.TriangleMesh) -> float:
    vertices = np.asarray(mesh.vertices, dtype=np.float64)
    faces = np.asarray(mesh.triangles, dtype=np.int64)
    return float(np.sum(_triangle_areas(vertices, faces)))


def count_boundary_edges(mesh: o3d.geometry.TriangleMesh) -> int:
    faces = np.asarray(mesh.triangles, dtype=np.int64)
    if len(faces) == 0:
        return 0
    edges = np.vstack(
        [
            faces[:, [0, 1]],
            faces[:, [1, 2]],
            faces[:, [2, 0]],
        ]
    )
    edges = np.sort(edges, axis=1)
    _, counts = np.unique(edges, axis=0, return_counts=True)
    return int(np.count_nonzero(counts == 1))


def _nearest_source_distances(points: np.ndarray, source_points: np.ndarray) -> np.ndarray:
    if len(points) == 0:
        return np.zeros(0, dtype=np.float64)
    if len(source_points) == 0:
        return np.full(len(points), np.inf, dtype=np.float64)
    try:
        from scipy.spatial import KDTree as SciKDTree

        tree = SciKDTree(source_points)
        distances, _ = tree.query(points)
        return np.asarray(distances, dtype=np.float64)
    except ImportError:
        source_pcd = o3d.geometry.PointCloud()
        source_pcd.points = o3d.utility.Vector3dVector(source_points)
        tree = o3d.geometry.KDTreeFlann(source_pcd)
        distances = np.zeros(len(points), dtype=np.float64)
        for i, point in enumerate(points):
            _, _, squared = tree.search_knn_vector_3d(point, 1)
            distances[i] = math.sqrt(float(squared[0])) if squared else np.inf
        return distances


def _face_components(face_count: int, adjacency: np.ndarray, mask: np.ndarray) -> list[np.ndarray]:
    remaining = set(np.flatnonzero(mask).astype(int).tolist())
    if not remaining:
        return []
    neighbors: dict[int, list[int]] = {face_id: [] for face_id in remaining}
    for first_face, second_face in adjacency:
        first = int(first_face)
        second = int(second_face)
        if first in remaining and second in remaining:
            neighbors[first].append(second)
            neighbors[second].append(first)

    components: list[np.ndarray] = []
    while remaining:
        start = remaining.pop()
        stack = [start]
        component = [start]
        while stack:
            current = stack.pop()
            for other in neighbors.get(current, []):
                if other in remaining:
                    remaining.remove(other)
                    stack.append(other)
                    component.append(other)
        components.append(np.asarray(component, dtype=np.int64))
    return components


def _selected_boundary_ratio(faces: np.ndarray) -> float:
    if len(faces) == 0:
        return 0.0
    edges = np.vstack([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]])
    edges = np.sort(edges, axis=1)
    _, counts = np.unique(edges, axis=0, return_counts=True)
    return float(np.count_nonzero(counts == 1) / max(1, len(counts)))


def remove_flying_sheets(
    mesh: o3d.geometry.TriangleMesh,
    source_pcd: o3d.geometry.PointCloud,
    voxel_size: float,
    scale: float,
    profile: ReconstructionProfile,
) -> tuple[o3d.geometry.TriangleMesh, dict[str, Any]]:
    if not profile.remove_flying_sheets_enabled:
        return mesh, {"removed_flying_sheet_faces": 0, "area_loss_ratio": 0.0, "rolled_back": False}

    vertices = np.asarray(mesh.vertices, dtype=np.float64)
    faces = np.asarray(mesh.triangles, dtype=np.int64)
    if len(vertices) < 3 or len(faces) < 1:
        return mesh, {"removed_flying_sheet_faces": 0, "area_loss_ratio": 0.0, "rolled_back": False}

    source_points = np.asarray(source_pcd.points, dtype=np.float64)
    support_radius = max(
        float(voxel_size) * profile.flying_sheet_support_radius_mult,
        float(scale) * profile.flying_sheet_support_min_scale,
    )
    vertex_distances = _nearest_source_distances(vertices, source_points)
    unsupported_vertices = vertex_distances > support_radius
    face_centroids = np.mean(vertices[faces], axis=1)
    centroid_distances = _nearest_source_distances(face_centroids, source_points)
    unsupported_centroids = centroid_distances > support_radius
    face_unsupported_ratio = np.mean(unsupported_vertices[faces], axis=1)
    candidate_faces = (
        (face_unsupported_ratio >= profile.flying_sheet_min_unsupported_vertex_ratio)
        | unsupported_centroids
    )
    if not np.any(candidate_faces):
        return mesh, {"removed_flying_sheet_faces": 0, "area_loss_ratio": 0.0, "rolled_back": False}

    tm = trimesh.Trimesh(vertices=vertices, faces=faces, process=False, validate=False)
    adjacency = np.asarray(tm.face_adjacency, dtype=np.int64)
    face_areas = _triangle_areas(vertices, faces)
    total_area = float(np.sum(face_areas))
    total_faces = int(len(faces))
    remove_mask = np.zeros(total_faces, dtype=bool)

    for component in _face_components(total_faces, adjacency, candidate_faces):
        component_faces = faces[component]
        area_ratio = float(np.sum(face_areas[component]) / max(total_area, 1e-12))
        face_ratio = float(len(component) / max(total_faces, 1))
        boundary_ratio = _selected_boundary_ratio(component_faces)
        if (
            (area_ratio <= profile.flying_sheet_max_area_ratio or face_ratio <= profile.flying_sheet_max_face_ratio)
            and boundary_ratio >= profile.flying_sheet_min_boundary_ratio
        ):
            remove_mask[component] = True

    removed_faces = int(np.count_nonzero(remove_mask))
    if removed_faces == 0:
        return mesh, {"removed_flying_sheet_faces": 0, "area_loss_ratio": 0.0, "rolled_back": False}

    removed_area = float(np.sum(face_areas[remove_mask]))
    area_loss_ratio = removed_area / max(total_area, 1e-12)
    if area_loss_ratio > profile.postprocess_max_area_loss_ratio:
        return mesh, {
            "removed_flying_sheet_faces": 0,
            "area_loss_ratio": area_loss_ratio,
            "rolled_back": True,
        }

    processed = copy.deepcopy(mesh)
    processed.remove_triangles_by_mask(remove_mask.tolist())
    processed.remove_unreferenced_vertices()
    return processed, {
        "removed_flying_sheet_faces": removed_faces,
        "area_loss_ratio": area_loss_ratio,
        "rolled_back": False,
    }


def _boundary_loops(faces: np.ndarray) -> list[list[int]]:
    if len(faces) == 0:
        return []
    edge_counts: dict[tuple[int, int], int] = {}
    for tri in faces:
        for a, b in ((int(tri[0]), int(tri[1])), (int(tri[1]), int(tri[2])), (int(tri[2]), int(tri[0]))):
            edge = tuple(sorted((a, b)))
            edge_counts[edge] = edge_counts.get(edge, 0) + 1
    boundary_edges = [edge for edge, count in edge_counts.items() if count == 1]
    adjacency: dict[int, list[int]] = {}
    for a, b in boundary_edges:
        adjacency.setdefault(a, []).append(b)
        adjacency.setdefault(b, []).append(a)

    loops: list[list[int]] = []
    seen_edges: set[tuple[int, int]] = set()
    for edge in boundary_edges:
        if edge in seen_edges:
            continue
        start, current = edge
        previous = start
        loop = [start]
        seen_edges.add(edge)
        while True:
            loop.append(current)
            next_candidates = [
                vertex
                for vertex in adjacency.get(current, [])
                if vertex != previous and tuple(sorted((current, vertex))) not in seen_edges
            ]
            if not next_candidates:
                if start in adjacency.get(current, []):
                    closing = tuple(sorted((current, start)))
                    seen_edges.add(closing)
                    break
                loop = []
                break
            next_vertex = next_candidates[0]
            seen_edges.add(tuple(sorted((current, next_vertex))))
            previous, current = current, next_vertex
            if current == start:
                break
        if len(loop) >= 3 and loop[0] != loop[-1]:
            loops.append(loop)
    return loops


def _loop_area(points: np.ndarray) -> float:
    if len(points) < 3:
        return 0.0
    centroid = points.mean(axis=0)
    centered = points - centroid
    try:
        _, _, vh = np.linalg.svd(centered, full_matrices=False)
        basis_x = vh[0]
        basis_y = vh[1]
    except np.linalg.LinAlgError:
        return 0.0
    projected = np.column_stack([centered @ basis_x, centered @ basis_y])
    x = projected[:, 0]
    y = projected[:, 1]
    return float(0.5 * abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))))


def fill_small_holes(
    mesh: o3d.geometry.TriangleMesh,
    profile: ReconstructionProfile,
) -> tuple[o3d.geometry.TriangleMesh, dict[str, Any]]:
    if not profile.fill_small_holes_enabled:
        return mesh, {"filled_hole_count": 0, "added_hole_faces": 0}

    vertices = np.asarray(mesh.vertices, dtype=np.float64)
    faces = np.asarray(mesh.triangles, dtype=np.int64)
    if len(vertices) < 3 or len(faces) < 1:
        return mesh, {"filled_hole_count": 0, "added_hole_faces": 0}

    total_area = float(np.sum(_triangle_areas(vertices, faces)))
    new_vertices = vertices.tolist()
    new_faces = faces.tolist()
    filled_count = 0
    added_faces = 0

    for loop in _boundary_loops(faces):
        if len(loop) > profile.small_hole_max_boundary_edges:
            continue
        loop_points = vertices[np.asarray(loop, dtype=np.int64)]
        area = _loop_area(loop_points)
        if area <= 1e-12 or area / max(total_area, 1e-12) > profile.small_hole_max_area_ratio:
            continue
        center_index = len(new_vertices)
        new_vertices.append(loop_points.mean(axis=0).tolist())
        for i, current in enumerate(loop):
            nxt = loop[(i + 1) % len(loop)]
            new_faces.append([int(current), int(nxt), center_index])
            added_faces += 1
        filled_count += 1

    if filled_count == 0:
        return mesh, {"filled_hole_count": 0, "added_hole_faces": 0}

    processed = o3d.geometry.TriangleMesh()
    processed.vertices = o3d.utility.Vector3dVector(np.asarray(new_vertices, dtype=np.float64))
    processed.triangles = o3d.utility.Vector3iVector(np.asarray(new_faces, dtype=np.int32))
    processed.remove_degenerate_triangles()
    processed.remove_duplicated_triangles()
    processed.remove_duplicated_vertices()
    processed.remove_unreferenced_vertices()
    processed.compute_vertex_normals()
    return processed, {"filled_hole_count": filled_count, "added_hole_faces": added_faces}


def postprocess_mesh_defects(
    mesh: o3d.geometry.TriangleMesh,
    source_pcd: o3d.geometry.PointCloud,
    voxel_size: float,
    scale: float,
    profile: ReconstructionProfile,
) -> tuple[o3d.geometry.TriangleMesh, dict[str, Any]]:
    processed, flying_stats = remove_flying_sheets(mesh, source_pcd, voxel_size, scale, profile)
    processed, hole_stats = fill_small_holes(processed, profile)
    try:
        processed.remove_degenerate_triangles()
        processed.remove_duplicated_triangles()
        processed.remove_duplicated_vertices()
        processed.remove_unreferenced_vertices()
    except (AttributeError, RuntimeError, ValueError):
        pass
    processed.compute_vertex_normals()
    return processed, {
        "removed_flying_sheet_faces": int(flying_stats["removed_flying_sheet_faces"]),
        "filled_hole_count": int(hole_stats["filled_hole_count"]),
        "added_hole_faces": int(hole_stats["added_hole_faces"]),
        "area_loss_ratio": float(flying_stats["area_loss_ratio"]),
        "rolled_back": bool(flying_stats["rolled_back"]),
        "boundary_edges_after": count_boundary_edges(processed),
    }


class DisjointSet:
    """Union-find with component size and Felzenszwalb-style internal difference."""

    def __init__(self, count: int) -> None:
        self.parent = np.arange(count, dtype=np.int32)
        self.size = np.ones(count, dtype=np.int32)
        self.internal = np.zeros(count, dtype=np.float64)

    def find(self, item: int) -> int:
        root = item
        while int(self.parent[root]) != root:
            root = int(self.parent[root])
        while int(self.parent[item]) != item:
            parent = int(self.parent[item])
            self.parent[item] = root
            item = parent
        return root

    def union(self, first: int, second: int, edge_weight: float) -> int:
        first = self.find(first)
        second = self.find(second)
        if first == second:
            return first
        if int(self.size[first]) < int(self.size[second]):
            first, second = second, first
        self.parent[second] = first
        self.size[first] += self.size[second]
        self.internal[first] = max(
            float(edge_weight),
            float(self.internal[first]),
            float(self.internal[second]),
        )
        return first


def _json_ready(value: Any) -> Any:
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, dict):
        return {str(k): _json_ready(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_ready(v) for v in value]
    return value


def smooth_face_normals(
    normals: np.ndarray,
    adjacency: np.ndarray,
    iterations: int,
    gate_angle_deg: float,
) -> np.ndarray:
    """Denoise face normals without averaging across likely geometric creases."""

    smoothed = np.asarray(normals, dtype=np.float64).copy()
    if iterations <= 0 or len(adjacency) == 0:
        return smoothed
    gate_cosine = float(np.cos(np.deg2rad(gate_angle_deg)))
    for _ in range(iterations):
        first = adjacency[:, 0]
        second = adjacency[:, 1]
        similarity = np.einsum("ij,ij->i", smoothed[first], smoothed[second])
        accepted = similarity >= gate_cosine
        accum = smoothed.copy()
        weights = np.ones(len(smoothed), dtype=np.float64)
        np.add.at(accum, first[accepted], smoothed[second[accepted]])
        np.add.at(accum, second[accepted], smoothed[first[accepted]])
        np.add.at(weights, first[accepted], 1.0)
        np.add.at(weights, second[accepted], 1.0)
        smoothed = accum / weights[:, None]
        lengths = np.linalg.norm(smoothed, axis=1)
        smoothed /= np.maximum(lengths[:, None], 1e-12)
    return smoothed


def classify_surface_region(
    vertices: np.ndarray,
    faces: np.ndarray,
    face_normals: np.ndarray,
    face_areas: np.ndarray,
    adjacency: np.ndarray,
    adjacency_angles_deg: np.ndarray,
    region_faces: np.ndarray,
    object_diagonal: float,
    total_area: float,
    seg_cfg: dict[str, float | int],
) -> dict[str, Any]:
    """Describe a connected mesh-face region using geometry only."""

    region_vertex_ids = np.unique(faces[region_faces].reshape(-1))
    points = vertices[region_vertex_ids]
    centroid = points.mean(axis=0)
    centered = points - centroid
    covariance = centered.T @ centered / max(len(points), 1)
    eigenvalues, eigenvectors = np.linalg.eigh(covariance)
    del eigenvalues
    plane_normal = eigenvectors[:, 0]
    plane_distances = centered @ plane_normal
    plane_rms = float(np.sqrt(np.mean(plane_distances**2)))
    normalized_plane_rms = plane_rms / max(object_diagonal, 1e-12)

    weighted_normal = np.sum(
        face_normals[region_faces] * face_areas[region_faces, None],
        axis=0,
    )
    weighted_normal_length = float(np.linalg.norm(weighted_normal))
    if weighted_normal_length > 1e-12:
        weighted_normal /= weighted_normal_length
        cosines = np.clip(face_normals[region_faces] @ weighted_normal, -1.0, 1.0)
        normal_spread_deg = float(np.percentile(np.rad2deg(np.arccos(cosines)), 90.0))
    else:
        normal_spread_deg = 180.0

    in_region = np.zeros(len(faces), dtype=bool)
    in_region[region_faces] = True
    internal_edges = in_region[adjacency[:, 0]] & in_region[adjacency[:, 1]]
    internal_angle_p90 = (
        float(np.percentile(adjacency_angles_deg[internal_edges], 90.0))
        if np.any(internal_edges)
        else 0.0
    )

    if normalized_plane_rms <= float(seg_cfg["planar_residual_ratio"]):
        surface_type = "planar"
    elif internal_angle_p90 <= float(seg_cfg["curved_internal_angle_deg"]):
        surface_type = "smooth_curved"
    else:
        surface_type = "freeform"

    region_area = float(np.sum(face_areas[region_faces]))
    return {
        "surface_type": surface_type,
        "area": region_area,
        "area_ratio": region_area / max(total_area, 1e-12),
        "centroid": centroid,
        "plane_fit": {
            "normal": plane_normal,
            "offset": -float(np.dot(plane_normal, centroid)),
            "rms": plane_rms,
            "normalized_rms": normalized_plane_rms,
        },
        "normal_spread_p90_deg": normal_spread_deg,
        "internal_edge_angle_p90_deg": internal_angle_p90,
    }


def remap_face_labels_by_area(face_labels: np.ndarray, face_areas: np.ndarray) -> np.ndarray:
    unique_labels, inverse = np.unique(face_labels, return_inverse=True)
    if len(unique_labels) == 0:
        return np.zeros(len(face_labels), dtype=np.int32)
    label_areas = np.bincount(inverse, weights=face_areas, minlength=len(unique_labels))
    area_order = np.argsort(-label_areas, kind="stable")
    remap = np.empty(len(area_order), dtype=np.int32)
    remap[area_order] = np.arange(len(area_order), dtype=np.int32)
    return remap[inverse].astype(np.int32)


def limit_surface_region_count(
    face_labels: np.ndarray,
    adjacency: np.ndarray,
    face_areas: np.ndarray,
    face_centroids: np.ndarray,
    max_regions: int,
) -> np.ndarray:
    """Merge the smallest patches until the layer list stays usable in the UI."""

    labels = remap_face_labels_by_area(face_labels, face_areas)
    max_regions = max(1, int(max_regions))
    if len(np.unique(labels)) <= max_regions:
        return labels

    while len(np.unique(labels)) > max_regions:
        unique_labels, inverse = np.unique(labels, return_inverse=True)
        label_areas = np.bincount(inverse, weights=face_areas, minlength=len(unique_labels))
        label_counts = np.bincount(inverse, minlength=len(unique_labels))
        label_ids = unique_labels.astype(np.int32)
        area_by_label = {int(label): float(label_areas[i]) for i, label in enumerate(label_ids)}
        count_by_label = {int(label): int(label_counts[i]) for i, label in enumerate(label_ids)}

        weighted_centroids = np.zeros((len(label_ids), 3), dtype=np.float64)
        np.add.at(weighted_centroids, inverse, face_centroids * face_areas[:, None])
        weighted_centroids /= np.maximum(label_areas[:, None], 1e-12)
        centroid_by_label = {int(label): weighted_centroids[i] for i, label in enumerate(label_ids)}

        boundary_scores: dict[int, dict[int, float]] = {}
        for first_face, second_face in adjacency:
            first_label = int(labels[int(first_face)])
            second_label = int(labels[int(second_face)])
            if first_label == second_label:
                continue
            shared_score = float(face_areas[int(first_face)] + face_areas[int(second_face)])
            boundary_scores.setdefault(first_label, {})[second_label] = (
                boundary_scores.setdefault(first_label, {}).get(second_label, 0.0) + shared_score
            )
            boundary_scores.setdefault(second_label, {})[first_label] = (
                boundary_scores.setdefault(second_label, {}).get(first_label, 0.0) + shared_score
            )

        source_label = min(
            (int(label) for label in label_ids),
            key=lambda label: (area_by_label[label], count_by_label[label], label),
        )
        neighbors = boundary_scores.get(source_label, {})
        if neighbors:
            target_label = max(
                neighbors,
                key=lambda label: (neighbors[label], area_by_label.get(label, 0.0), -label),
            )
        else:
            source_centroid = centroid_by_label[source_label]
            target_label = min(
                (int(label) for label in label_ids if int(label) != source_label),
                key=lambda label: (
                    float(np.linalg.norm(centroid_by_label[label] - source_centroid)),
                    -area_by_label[label],
                    label,
                ),
            )
        labels[labels == source_label] = target_label
        labels = remap_face_labels_by_area(labels, face_areas)

    return labels


def graph_geometry_segmentation(
    vertices: np.ndarray,
    faces: np.ndarray,
    seg_cfg: dict[str, float | int] | None = None,
) -> dict[str, Any]:
    """Segment connected face patches with an adaptive normal-angle graph."""

    cfg = dict(GEOMETRY_GRAPH_SURFACE_CONFIG)
    if seg_cfg:
        cfg.update(seg_cfg)
    tm = trimesh.Trimesh(vertices=vertices, faces=faces, process=False, validate=False)
    adjacency = np.asarray(tm.face_adjacency, dtype=np.int64)
    if len(faces) == 0:
        raise RuntimeError("The reconstructed mesh has no faces.")
    if len(adjacency) == 0:
        face_labels = np.zeros(len(faces), dtype=np.int32)
        face_normals = np.asarray(tm.face_normals, dtype=np.float64)
        face_areas = np.asarray(tm.area_faces, dtype=np.float64)
        labels_metadata = [
            {
                "id": 0,
                "name": "layer_000_freeform",
                "surface_type": "freeform",
                "face_count": int(len(faces)),
                "area": float(np.sum(face_areas)),
                "area_ratio": 1.0,
                "centroid": vertices.mean(axis=0),
                "plane_fit": {"normal": [0.0, 0.0, 1.0], "offset": 0.0, "rms": 0.0, "normalized_rms": 0.0},
                "normal_spread_p90_deg": 0.0,
                "internal_edge_angle_p90_deg": 0.0,
            }
        ]
        return {
            "profile": GEOMETRY_GRAPH_SURFACE_PROFILE,
            "config": cfg,
            "face_labels": face_labels,
            "label_count": 1,
            "labels_metadata": labels_metadata,
            "details": {
                "algorithm": "adaptive_face_adjacency_graph",
                "adjacency_edge_count": 0,
                "region_boundary_edge_count": 0,
                "surface_type_counts": {"freeform": 1},
            },
        }

    face_normals = np.asarray(tm.face_normals, dtype=np.float64)
    face_areas = np.asarray(tm.area_faces, dtype=np.float64)
    smoothed_normals = smooth_face_normals(
        face_normals,
        adjacency,
        iterations=int(cfg["normal_smoothing_iterations"]),
        gate_angle_deg=float(cfg["normal_smoothing_gate_deg"]),
    )
    cosines = np.clip(
        np.einsum(
            "ij,ij->i",
            smoothed_normals[adjacency[:, 0]],
            smoothed_normals[adjacency[:, 1]],
        ),
        -1.0,
        1.0,
    )
    edge_angles = np.arccos(cosines)
    edge_order = np.argsort(edge_angles, kind="stable")

    graph_scale = float(np.deg2rad(cfg["graph_scale_deg"]))
    hard_angle = float(np.deg2rad(cfg["max_edge_angle_deg"]))
    components = DisjointSet(len(faces))

    for edge_index in edge_order:
        weight = float(edge_angles[edge_index])
        if weight > hard_angle:
            break
        first_face, second_face = adjacency[edge_index]
        first_root = components.find(int(first_face))
        second_root = components.find(int(second_face))
        if first_root == second_root:
            continue
        first_threshold = float(components.internal[first_root]) + graph_scale / float(components.size[first_root])
        second_threshold = float(components.internal[second_root]) + graph_scale / float(components.size[second_root])
        if weight <= min(first_threshold, second_threshold):
            components.union(first_root, second_root, weight)

    min_faces_absolute = int(cfg["min_region_faces"])
    min_faces_fraction = int(np.ceil(len(faces) * float(cfg["min_region_face_ratio"])))
    requested_min_region_faces = max(1, min_faces_absolute, min_faces_fraction)
    min_region_cap = max(1, int(np.ceil(len(faces) * 0.08)))
    min_region_faces = min(requested_min_region_faces, min_region_cap)
    merge_angle = float(np.deg2rad(cfg["small_region_merge_angle_deg"]))

    for edge_index in edge_order:
        weight = float(edge_angles[edge_index])
        if weight > merge_angle:
            break
        first_face, second_face = adjacency[edge_index]
        first_root = components.find(int(first_face))
        second_root = components.find(int(second_face))
        if first_root == second_root:
            continue
        if int(components.size[first_root]) < min_region_faces or int(components.size[second_root]) < min_region_faces:
            components.union(first_root, second_root, weight)

    roots = np.fromiter(
        (components.find(face_id) for face_id in range(len(faces))),
        dtype=np.int32,
        count=len(faces),
    )
    unique_roots, inverse = np.unique(roots, return_inverse=True)
    component_areas = np.bincount(inverse, weights=face_areas, minlength=len(unique_roots))
    area_order = np.argsort(-component_areas, kind="stable")
    remap = np.empty(len(area_order), dtype=np.int32)
    remap[area_order] = np.arange(len(area_order), dtype=np.int32)
    face_labels = remap[inverse].astype(np.int32)
    pre_cap_label_count = int(face_labels.max()) + 1
    face_centroids = np.mean(vertices[faces], axis=1)
    face_labels = limit_surface_region_count(
        face_labels,
        adjacency,
        face_areas,
        face_centroids,
        max_regions=int(cfg["max_surface_layers"]),
    )
    label_count = int(face_labels.max()) + 1

    actual_angles_deg = np.rad2deg(
        np.arccos(
            np.clip(
                np.einsum(
                    "ij,ij->i",
                    face_normals[adjacency[:, 0]],
                    face_normals[adjacency[:, 1]],
                ),
                -1.0,
                1.0,
            )
        )
    )
    boundary_edges = face_labels[adjacency[:, 0]] != face_labels[adjacency[:, 1]]
    object_diagonal = float(np.linalg.norm(np.ptp(vertices, axis=0)))
    total_area = float(np.sum(face_areas))
    labels_metadata: list[dict[str, Any]] = []
    surface_types: list[str] = []
    for label_id in range(label_count):
        region_faces = np.flatnonzero(face_labels == label_id)
        descriptor = classify_surface_region(
            vertices,
            faces,
            face_normals,
            face_areas,
            adjacency,
            actual_angles_deg,
            region_faces,
            object_diagonal,
            total_area,
            cfg,
        )
        surface_type = str(descriptor["surface_type"])
        surface_types.append(surface_type)
        labels_metadata.append(
            {
                "id": label_id,
                "name": f"layer_{label_id:03d}_{surface_type}",
                "surface_type": surface_type,
                "face_count": int(len(region_faces)),
                "area": descriptor["area"],
                "area_ratio": descriptor["area_ratio"],
                "centroid": descriptor["centroid"],
                "plane_fit": descriptor["plane_fit"],
                "normal_spread_p90_deg": descriptor["normal_spread_p90_deg"],
                "internal_edge_angle_p90_deg": descriptor["internal_edge_angle_p90_deg"],
            }
        )

    unique_types, type_counts = np.unique(surface_types, return_counts=True)
    return {
        "profile": GEOMETRY_GRAPH_SURFACE_PROFILE,
        "config": cfg,
        "face_labels": face_labels,
        "label_count": label_count,
        "labels_metadata": labels_metadata,
        "details": {
            "algorithm": "adaptive_face_adjacency_graph",
            "edge_feature": "denoised adjacent-face normal angle",
            "min_region_faces_effective": int(min_region_faces),
            "pre_cap_label_count": pre_cap_label_count,
            "max_surface_layers": int(cfg["max_surface_layers"]),
            "adjacency_edge_count": int(len(adjacency)),
            "region_boundary_edge_count": int(np.count_nonzero(boundary_edges)),
            "surface_type_counts": {str(k): int(v) for k, v in zip(unique_types, type_counts)},
        },
    }


def label_palette(count: int) -> np.ndarray:
    palette = np.zeros((max(count, 1), 3), dtype=np.uint8)
    golden_ratio = 0.6180339887498949
    for i in range(max(count, 1)):
        hue = (0.08 + i * golden_ratio) % 1.0
        saturation = 0.62 + 0.18 * ((i % 3) / 2.0)
        value = 0.78 + 0.18 * (i % 2)
        rgb = np.asarray(colorsys_hsv_to_rgb(hue, saturation, value))
        palette[i] = np.round(rgb * 255).astype(np.uint8)
    return palette


def colorsys_hsv_to_rgb(hue: float, saturation: float, value: float) -> tuple[float, float, float]:
    c = value * saturation
    x = c * (1 - abs((hue * 6) % 2 - 1))
    m = value - c
    if hue < 1 / 6:
        rgb = (c, x, 0)
    elif hue < 2 / 6:
        rgb = (x, c, 0)
    elif hue < 3 / 6:
        rgb = (0, c, x)
    elif hue < 4 / 6:
        rgb = (0, x, c)
    elif hue < 5 / 6:
        rgb = (x, 0, c)
    else:
        rgb = (c, 0, x)
    return (rgb[0] + m, rgb[1] + m, rgb[2] + m)


def export_geometry_graph_surface_layers(
    mesh: o3d.geometry.TriangleMesh,
    output_dir: str,
) -> dict[str, Any]:
    vertices = np.asarray(mesh.vertices, dtype=np.float64)
    faces = np.asarray(mesh.triangles, dtype=np.int64)
    if len(vertices) < 3 or len(faces) < 1:
        raise RuntimeError("geometry_graph_surface requires a non-empty triangle mesh.")

    if not mesh.has_vertex_normals():
        mesh.compute_vertex_normals()
    vertex_normals = np.asarray(mesh.vertex_normals, dtype=np.float64)
    segmentation = graph_geometry_segmentation(vertices, faces)
    face_labels = np.asarray(segmentation["face_labels"], dtype=np.int32)
    palette = label_palette(int(segmentation["label_count"]))
    layers_dir = os.path.join(output_dir, "layers")
    os.makedirs(layers_dir, exist_ok=True)

    layer_paths: list[str] = []
    layer_names: list[str] = []
    for region in segmentation["labels_metadata"]:
        label_id = int(region["id"])
        region_name = str(region["name"])
        selected_faces = faces[face_labels == label_id]
        if len(selected_faces) == 0:
            continue
        used_vertices, inverse = np.unique(selected_faces.reshape(-1), return_inverse=True)
        local_faces = inverse.reshape(-1, 3)
        color = palette[label_id % len(palette)]
        vertex_rgba = np.tile(np.array([color[0], color[1], color[2], 255], dtype=np.uint8), (len(used_vertices), 1))
        region_mesh = trimesh.Trimesh(
            vertices=vertices[used_vertices],
            faces=local_faces,
            vertex_normals=vertex_normals[used_vertices] if len(vertex_normals) == len(vertices) else None,
            process=False,
            validate=False,
            metadata={
                "name": region_name,
                "region_id": label_id,
                "surface_type": region["surface_type"],
                "segmentation_profile": GEOMETRY_GRAPH_SURFACE_PROFILE,
            },
        )
        region_mesh.visual.vertex_colors = vertex_rgba
        scene = trimesh.Scene()
        scene.add_geometry(region_mesh, node_name=region_name, geom_name=region_name)
        layer_path = os.path.join(layers_dir, f"{region_name}.glb")
        scene.export(layer_path, file_type="glb")
        layer_paths.append(layer_path)
        layer_names.append(region_name)

    metadata = {
        "schema_version": "1.0",
        "segmentation_profile": GEOMETRY_GRAPH_SURFACE_PROFILE,
        "label_count": int(segmentation["label_count"]),
        "config": segmentation["config"],
        "details": segmentation["details"],
        "layers": segmentation["labels_metadata"],
        "layer_glb_paths": layer_paths,
        "layer_names": layer_names,
    }
    metadata_path = os.path.join(output_dir, "layers_meta.json")
    with open(metadata_path, "w", encoding="utf-8") as f:
        json.dump(_json_ready(metadata), f, ensure_ascii=False, indent=2)

    return {
        "segmentationProfile": GEOMETRY_GRAPH_SURFACE_PROFILE,
        "segmentationLabelCount": int(segmentation["label_count"]),
        "segmentationMetadataPath": metadata_path,
        "layerGlbPaths": layer_paths,
        "layerNames": layer_names,
        "faceLabels": face_labels,
        "labelsMetadata": segmentation["labels_metadata"],
    }


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
    mesh, postprocess_stats = postprocess_mesh_defects(mesh, pcd_clean, voxel_size, scale, profile)
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

    segmentation_result = export_geometry_graph_surface_layers(mesh, output_dir)

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
        "postprocessRemovedSheetFaces": postprocess_stats["removed_flying_sheet_faces"],
        "postprocessFilledHoleCount": postprocess_stats["filled_hole_count"],
        "postprocessAddedHoleFaces": postprocess_stats["added_hole_faces"],
        "postprocessAreaLossRatio": postprocess_stats["area_loss_ratio"],
        "postprocessRolledBack": postprocess_stats["rolled_back"],
        "postprocessBoundaryEdgesAfter": postprocess_stats["boundary_edges_after"],
        "segmentationProfile": segmentation_result["segmentationProfile"],
        "segmentationLabelCount": segmentation_result["segmentationLabelCount"],
        "segmentationMetadataPath": segmentation_result["segmentationMetadataPath"],
        "layerGlbPaths": segmentation_result["layerGlbPaths"],
        "layerNames": segmentation_result["layerNames"],
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
