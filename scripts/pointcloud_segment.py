#!/usr/bin/env python3
"""
Point cloud segmentation script for 3DGS Studio.

Segments a point cloud into layers:
  - Mode "remove_background": removes the largest horizontal plane(s) (table/floor),
    then DBSCAN clusters the remaining foreground into individual objects.
    Each foreground object becomes a separate layer with its own vertex color.
  - Mode "segment_all": full segmentation into individual objects with
    sub-segmentation of labels/details on curved surfaces.

Output:
  - Main PLY (all foreground layers merged, each with unique vertex color)
    written to --output_ply
  - Individual layer PLY files written to --layers_dir
  - Metadata JSON with layer info written to --layers_dir/layers_meta.json

All distance/threshold parameters are auto-scaled based on the point cloud's
bounding box, so the script works for different scene scales without manual tuning.
"""

import argparse
from collections import deque
import json
import os
import sys

import numpy as np

try:
    import open3d as o3d
except ImportError:
    print("[ERROR] open3d is required: pip install open3d", file=sys.stderr)
    sys.exit(1)


# ── Color palette for layer encoding ─────────────────────────────────────────
# Distinct colors that are easy to tell apart in a 3D viewer.
# Each layer gets a unique RGB so that downstream nodes (surface processing)
# can recover layer membership from vertex colors even after format conversions
# (PLY → 3DGS → GLB/OBJ → Blender → OBJ).
LAYER_COLORS = [
    (0.10, 0.60, 0.90),  # layer 0 — blue
    (0.90, 0.30, 0.20),  # layer 1 — red
    (0.20, 0.80, 0.30),  # layer 2 — green
    (0.95, 0.75, 0.10),  # layer 3 — yellow
    (0.70, 0.30, 0.85),  # layer 4 — purple
    (0.10, 0.80, 0.75),  # layer 5 — teal
    (0.95, 0.50, 0.10),  # layer 6 — orange
    (0.60, 0.90, 0.30),  # layer 7 — lime
    (0.85, 0.45, 0.65),  # layer 8 — pink
    (0.40, 0.50, 0.60),  # layer 9 — slate
    (0.80, 0.70, 0.50),  # layer 10 — tan
    (0.30, 0.40, 0.80),  # layer 11 — indigo
]

# Reserved color for "background" layer (removed from main output, kept in meta)
BACKGROUND_COLOR = (0.50, 0.50, 0.50)  # gray

# Default color for points that don't belong to any identified layer
DEFAULT_COLOR = (0.10, 0.60, 0.90)  # same as layer 0

# Tolerance for matching vertex colors to layer indices (0-255 integer space)
COLOR_MATCH_TOLERANCE = 10


def get_layer_color(layer_index: int) -> tuple:
    """Return the RGB color tuple for a given layer index."""
    if layer_index < len(LAYER_COLORS):
        return LAYER_COLORS[layer_index]
    # Cycle through the palette for layers beyond the predefined colors
    return LAYER_COLORS[layer_index % len(LAYER_COLORS)]


def color_index_to_layer(r: float, g: float, b: float) -> int:
    """
    Given vertex color RGB (0-1 range), find the matching layer index.
    Returns -1 if no match is found within COLOR_MATCH_TOLERANCE.
    """
    r255, g255, b255 = int(r * 255), int(g * 255), int(b * 255)
    for i, (lr, lg, lb) in enumerate(LAYER_COLORS):
        lr255, lg255, lb255 = int(lr * 255), int(lg * 255), int(lb * 255)
        if (abs(r255 - lr255) <= COLOR_MATCH_TOLERANCE and
            abs(g255 - lg255) <= COLOR_MATCH_TOLERANCE and
            abs(b255 - lb255) <= COLOR_MATCH_TOLERANCE):
            return i
    return -1


# ── Adaptive parameter computation ──────────────────────────────────────────

def compute_adaptive_params(pcd: o3d.geometry.PointCloud) -> dict:
    """Compute segmentation parameters scaled to the point cloud's bounding box."""
    points = np.asarray(pcd.points)
    if len(points) == 0:
        return {
            "plane_distance_threshold": 0.01,
            "dbscan_eps": 0.02,
            "detail_dbscan_eps": 0.015,
            "detail_plane_distance_threshold": 0.01,
            "detail_min_points": 20,
            "repeat_grid_cell": 0.02,
            "color_mapping_distance": 0.01,
            "bbox_scale": 1.0,
        }

    # Bounding box diagonal = characteristic scale of the scene
    min_bound = points.min(axis=0)
    max_bound = points.max(axis=0)
    bbox_diag = np.linalg.norm(max_bound - min_bound)
    scale = max(bbox_diag, 0.01)

    # All thresholds as fractions of the bounding box diagonal
    return {
        # RANSAC plane distance: 1% of bbox diagonal
        "plane_distance_threshold": max(scale * 0.01, 0.002),
        # DBSCAN clustering radius for foreground objects.
        "dbscan_eps": max(scale * 0.012, 0.003),
        # Finer DBSCAN radius for details separated from each object body.
        "detail_dbscan_eps": max(scale * 0.012, 0.003),
        # Tighter plane fit for extracting the main body from an object.
        "detail_plane_distance_threshold": max(scale * 0.006, 0.0015),
        "detail_min_points": 20,
        # XY grid used to find repeated vertical/elongated appendages.
        "repeat_grid_cell": max(scale * 0.018, 0.003),
        # Color mapping max distance: 3% of bbox diagonal
        "color_mapping_distance": max(scale * 0.03, 0.005),
        "bbox_scale": scale,
    }


# ── Core segmentation logic ─────────────────────────────────────────────────

def remove_background_planes(
    pcd: o3d.geometry.PointCloud,
    params: dict,
    progress_cb=None,
) -> tuple:
    """
    Remove the largest horizontal plane(s) (table/floor/ground).
    Returns (foreground_pcd, background_pcd).
    """
    rest_pcd = pcd
    background_pcd = o3d.geometry.PointCloud()
    iterations = 0
    max_plane_iters = 5

    while iterations < max_plane_iters:
        if len(rest_pcd.points) < 100:
            break

        plane_model, inliers = rest_pcd.segment_plane(
            distance_threshold=params["plane_distance_threshold"],
            ransac_n=3,
            num_iterations=1000,
        )

        if len(inliers) < 100:
            break

        [a, b, c, d] = plane_model
        # Normal pointing roughly up or down (|c| > 0.5)
        if abs(c) > 0.5:
            part = rest_pcd.select_by_index(inliers)
            background_pcd += part
            rest_pcd = rest_pcd.select_by_index(inliers, invert=True)
            iterations += 1
            if progress_cb:
                progress_cb(f"Removing background plane {iterations} ({len(part.points)} pts)")
        else:
            # Hit a vertical plane — stop removing
            break

    # Color background with its reserved color
    if len(background_pcd.points) > 0:
        background_pcd.colors = o3d.utility.Vector3dVector(
            [BACKGROUND_COLOR] * len(background_pcd.points)
        )

    return rest_pcd, background_pcd


def paint_layer(pcd: o3d.geometry.PointCloud, layer_index: int):
    """Paint a layer with the shared project palette."""
    pcd.colors = o3d.utility.Vector3dVector(
        [get_layer_color(layer_index)] * len(pcd.points)
    )


def _relative_difference(a: float, b: float) -> float:
    """Return a scale-safe relative difference for two positive values."""
    denom = max(abs(a), abs(b), 1e-9)
    return abs(a - b) / denom


def _candidate_point_cloud(source_pcd: o3d.geometry.PointCloud, indices: np.ndarray):
    """Select points by numpy indices while keeping the implementation readable."""
    return source_pcd.select_by_index(indices.astype(int).tolist())


def _connected_cell_components(cells: set) -> list:
    """Group occupied 2D grid cells using 8-connected neighborhoods."""
    remaining = set(cells)
    components = []
    neighbors = [
        (-1, -1), (-1, 0), (-1, 1),
        (0, -1),           (0, 1),
        (1, -1),  (1, 0),  (1, 1),
    ]

    while remaining:
        start = remaining.pop()
        queue = deque([start])
        component = {start}

        while queue:
            cell = queue.popleft()
            for dx, dy in neighbors:
                next_cell = (cell[0] + dx, cell[1] + dy)
                if next_cell in remaining:
                    remaining.remove(next_cell)
                    component.add(next_cell)
                    queue.append(next_cell)

        components.append(component)

    return components


def _describe_candidate(points: np.ndarray, total_points: int) -> dict:
    """Build a compact shape descriptor for comparing repeated parts."""
    min_bound = points.min(axis=0)
    max_bound = points.max(axis=0)
    extents = np.maximum(max_bound - min_bound, 1e-9)
    xy_area = max(extents[0] * extents[1], 1e-9)
    xy_diag = float(np.linalg.norm(extents[:2]))
    return {
        "point_count": int(len(points)),
        "point_ratio": float(len(points) / max(total_points, 1)),
        "height": float(extents[2]),
        "width": float(extents[0]),
        "depth": float(extents[1]),
        "xy_area": float(xy_area),
        "xy_diag": xy_diag,
        "center": points.mean(axis=0),
        "min_bound": min_bound,
        "max_bound": max_bound,
    }


def _are_repeat_candidates_similar(a: dict, b: dict) -> bool:
    """Compare simple geometry descriptors for repeat-family grouping."""
    return (
        _relative_difference(a["height"], b["height"]) <= 0.45 and
        _relative_difference(a["xy_area"], b["xy_area"]) <= 0.80 and
        _relative_difference(a["point_count"], b["point_count"]) <= 0.85
    )


def _group_similar_candidates(candidates: list) -> list:
    """Greedily group candidates that look like copies of the same local part."""
    groups = []
    for candidate in sorted(candidates, key=lambda item: item["desc"]["point_count"], reverse=True):
        placed = False
        for group in groups:
            if all(_are_repeat_candidates_similar(candidate["desc"], existing["desc"]) for existing in group):
                group.append(candidate)
                placed = True
                break
        if not placed:
            groups.append([candidate])
    return groups


def extract_repeated_vertical_parts(
    object_pcd: o3d.geometry.PointCloud,
    object_index: int,
    params: dict,
    layer_start_index: int,
    progress_cb=None,
) -> tuple:
    """
    Split a single connected object into a main body and repeated elongated parts.

    This is intentionally simple and conservative. It looks for several small
    XY-footprint regions with large vertical span, then groups similar regions
    into one repeated-parts layer. If there is not enough repeated evidence,
    it returns no result and the older body/detail fallback continues.
    """
    points = np.asarray(object_pcd.points)
    point_count = len(points)
    min_detail_points = max(int(params["detail_min_points"]), int(point_count * 0.015))

    if point_count < max(120, min_detail_points * 4):
        return [], [], layer_start_index

    min_bound = points.min(axis=0)
    max_bound = points.max(axis=0)
    extents = max_bound - min_bound
    z_extent = float(extents[2])
    xy_extent = np.maximum(extents[:2], 1e-9)
    max_xy_extent = float(max(xy_extent))

    if z_extent < params["bbox_scale"] * 0.12 or max_xy_extent <= 0:
        return [], [], layer_start_index

    # Use an adaptive XY grid so connected posts or repeated small parts become
    # candidates even when they touch a larger surface at their top.
    cell_size = max(float(params["repeat_grid_cell"]), max_xy_extent / 48.0, 0.003)
    xy_cells = np.floor((points[:, :2] - min_bound[:2]) / cell_size).astype(int)

    cell_to_indices = {}
    for idx, cell in enumerate(map(tuple, xy_cells)):
        cell_to_indices.setdefault(cell, []).append(idx)

    bottom_seed_cells = set()
    min_cell_points = max(3, int(point_count * 0.0004))
    min_vertical_span = max(z_extent * 0.28, params["bbox_scale"] * 0.04)
    bottom_seed_limit = min_bound[2] + z_extent * 0.32

    for cell, indices in cell_to_indices.items():
        if len(indices) < min_cell_points:
            continue
        cell_points = points[np.asarray(indices, dtype=int)]
        z_span = float(cell_points[:, 2].max() - cell_points[:, 2].min())
        if z_span >= min_vertical_span:
            if float(cell_points[:, 2].min()) <= bottom_seed_limit:
                bottom_seed_cells.add(cell)

    if len(bottom_seed_cells) < 2:
        return [], [], layer_start_index

    components = _connected_cell_components(bottom_seed_cells)
    candidates = []
    for component in components:
        candidate_indices = np.asarray(
            sorted({
                point_index
                for cell in component
                for point_index in cell_to_indices.get(cell, [])
            }),
            dtype=int,
        )
        if len(candidate_indices) < min_detail_points:
            continue

        candidate_points = points[candidate_indices]
        desc = _describe_candidate(candidate_points, point_count)
        if desc["height"] < min_vertical_span:
            continue
        if desc["xy_diag"] > max_xy_extent * 0.38:
            continue
        if desc["width"] > xy_extent[0] * 0.42 or desc["depth"] > xy_extent[1] * 0.42:
            continue
        if desc["point_ratio"] > 0.35:
            continue

        # Keep the first pass conservative: this mainly captures repeated
        # supports/appendages below or through the lower half of the object.
        bottom_limit = min_bound[2] + z_extent * 0.32
        center_limit = min_bound[2] + z_extent * 0.62
        if desc["min_bound"][2] > bottom_limit and desc["center"][2] > center_limit:
            continue

        candidates.append({
            "indices": candidate_indices,
            "desc": desc,
        })

    if len(candidates) < 2:
        return [], [], layer_start_index

    groups = _group_similar_candidates(candidates)
    groups = [group for group in groups if len(group) >= 2]
    if not groups:
        return [], [], layer_start_index

    best_group = max(
        groups,
        key=lambda group: (len(group), sum(item["desc"]["point_count"] for item in group)),
    )
    repeated_indices = np.unique(np.concatenate([item["indices"] for item in best_group]))
    repeated_ratio = len(repeated_indices) / point_count

    if repeated_ratio < 0.03 or repeated_ratio > 0.55:
        return [], [], layer_start_index

    body_mask = np.ones(point_count, dtype=bool)
    body_mask[repeated_indices] = False
    body_indices = np.where(body_mask)[0]
    if len(body_indices) < max(min_detail_points, point_count * 0.25):
        return [], [], layer_start_index

    body_pcd = _candidate_point_cloud(object_pcd, body_indices)
    repeated_pcd = _candidate_point_cloud(object_pcd, repeated_indices)

    colored_parts = []
    layer_info = []
    color_idx = layer_start_index

    body_name = f"object_{object_index}_body"
    paint_layer(body_pcd, color_idx)
    colored_parts.append((body_name, body_pcd))
    layer_info.append({
        "name": body_name,
        "type": "body",
        "subtype": "remaining_main_structure",
        "point_count": len(body_pcd.points),
    })
    color_idx += 1

    repeated_name = f"object_{object_index}_repeated_parts"
    paint_layer(repeated_pcd, color_idx)
    colored_parts.append((repeated_name, repeated_pcd))
    layer_info.append({
        "name": repeated_name,
        "type": "repeated_parts",
        "subtype": "elongated_similar_parts",
        "part_count": len(best_group),
        "point_count": len(repeated_pcd.points),
    })
    color_idx += 1

    if progress_cb:
        progress_cb(
            f"Object {object_index}: grouped {len(best_group)} repeated part(s) "
            f"({len(repeated_pcd.points)} pts)"
        )

    return colored_parts, layer_info, color_idx


def segment_object_body_details(
    object_pcd: o3d.geometry.PointCloud,
    object_index: int,
    params: dict,
    layer_start_index: int,
    progress_cb=None,
) -> tuple:
    """
    Split one foreground object into a main body plus detail clusters.

    This ports the useful idea from seg_detail.py: fit the dominant structure
    first, then cluster the remaining points as detail layers.
    """
    point_count = len(object_pcd.points)
    min_detail_points = int(params["detail_min_points"])

    if point_count < max(50, min_detail_points * 2):
        return [], [], layer_start_index

    repeated_parts, repeated_info, next_layer_index = extract_repeated_vertical_parts(
        object_pcd,
        object_index,
        params,
        layer_start_index,
        progress_cb,
    )
    if repeated_parts:
        return repeated_parts, repeated_info, next_layer_index

    body_indices = []
    body_type = ""

    # Prefer a cylinder when the local Open3D build supports it, otherwise use
    # the dominant plane. segment_cylinder is not available in many releases.
    try:
        if hasattr(object_pcd, "segment_cylinder"):
            _, cyl_inliers = object_pcd.segment_cylinder(
                radius_min=params["bbox_scale"] * 0.002,
                radius_max=params["bbox_scale"] * 0.5,
                split=4,
            )
            if len(cyl_inliers) > len(body_indices):
                body_indices = cyl_inliers
                body_type = "cylinder"
    except Exception:
        pass

    try:
        _, plane_inliers = object_pcd.segment_plane(
            distance_threshold=params["detail_plane_distance_threshold"],
            ransac_n=3,
            num_iterations=800,
        )
        if len(plane_inliers) > len(body_indices):
            body_indices = plane_inliers
            body_type = "plane"
    except Exception:
        pass

    body_ratio = len(body_indices) / point_count if point_count else 0
    detail_count = point_count - len(body_indices)

    # Require a substantial fitted body and enough remaining detail points.
    if body_ratio < 0.25 or detail_count < min_detail_points:
        return [], [], layer_start_index

    body_pcd = object_pcd.select_by_index(body_indices)
    details_pcd = object_pcd.select_by_index(body_indices, invert=True)

    colored_parts = []
    layer_info = []
    color_idx = layer_start_index

    body_name = f"object_{object_index}_body"
    paint_layer(body_pcd, color_idx)
    colored_parts.append((body_name, body_pcd))
    layer_info.append({
        "name": body_name,
        "type": "body",
        "subtype": body_type or "dominant_structure",
        "point_count": len(body_pcd.points),
    })
    color_idx += 1

    if progress_cb:
        progress_cb(
            f"Object {object_index}: extracted {body_name} "
            f"({body_type or 'body'}, {len(body_pcd.points)} pts)"
        )

    detail_labels = np.array(details_pcd.cluster_dbscan(
        eps=params["detail_dbscan_eps"],
        min_points=min_detail_points,
    ))
    max_detail_label = detail_labels.max()

    if max_detail_label < 0:
        detail_name = f"object_{object_index}_detail"
        paint_layer(details_pcd, color_idx)
        colored_parts.append((detail_name, details_pcd))
        layer_info.append({
            "name": detail_name,
            "type": "detail",
            "point_count": len(details_pcd.points),
        })
        return colored_parts, layer_info, color_idx + 1

    for detail_index in range(max_detail_label + 1):
        detail_indices = np.where(detail_labels == detail_index)[0]
        if len(detail_indices) < min_detail_points:
            continue

        detail_pcd = details_pcd.select_by_index(detail_indices)
        detail_name = f"object_{object_index}_detail_{detail_index}"
        paint_layer(detail_pcd, color_idx)
        colored_parts.append((detail_name, detail_pcd))
        layer_info.append({
            "name": detail_name,
            "type": "detail",
            "point_count": len(detail_pcd.points),
        })
        color_idx += 1

    if len(colored_parts) == 1 and len(details_pcd.points) >= min_detail_points:
        detail_name = f"object_{object_index}_detail"
        paint_layer(details_pcd, color_idx)
        colored_parts.append((detail_name, details_pcd))
        layer_info.append({
            "name": detail_name,
            "type": "detail",
            "point_count": len(details_pcd.points),
        })
        color_idx += 1

    return colored_parts, layer_info, color_idx


def cluster_foreground(
    foreground_pcd: o3d.geometry.PointCloud,
    params: dict,
    layer_start_index: int,
    do_subsegment: bool,
    progress_cb=None,
) -> tuple:
    """
    DBSCAN-cluster the foreground into individual objects.
    Each object gets a unique layer color (starting from layer_start_index).

    Returns (colored_parts, layer_info) where:
      - colored_parts: list of (layer_name, colored_pcd) tuples
      - layer_info: list of dicts with name/type/point_count
    """
    if len(foreground_pcd.points) < 10:
        # No foreground — return empty
        if progress_cb:
            progress_cb("No foreground objects remaining after background removal")
        return [], []

    if progress_cb:
        progress_cb("Clustering foreground objects...")

    labels = np.array(foreground_pcd.cluster_dbscan(
        eps=params["dbscan_eps"],
        min_points=20,
    ))
    max_label = labels.max()

    if max_label < 0:
        if do_subsegment:
            colored_parts, layer_info, _ = segment_object_body_details(
                foreground_pcd, 0, params, layer_start_index, progress_cb
            )
            if colored_parts:
                return colored_parts, layer_info

        # No clusters found — treat entire foreground as one object
        color = get_layer_color(layer_start_index)
        foreground_pcd.colors = o3d.utility.Vector3dVector(
            [color] * len(foreground_pcd.points)
        )
        layer_info = [{
            "name": "foreground",
            "type": "body",
            "point_count": len(foreground_pcd.points),
        }]
        return [("foreground", foreground_pcd)], layer_info

    num_objects = max_label + 1
    if progress_cb:
        progress_cb(f"Found {num_objects} foreground object(s)")

    colored_parts = []
    layer_info = []
    color_idx = layer_start_index

    for i in range(num_objects):
        obj_indices = np.where(labels == i)[0]
        current_obj = foreground_pcd.select_by_index(obj_indices)

        if do_subsegment:
            detail_parts, detail_info, next_color_idx = segment_object_body_details(
                current_obj, i, params, color_idx, progress_cb
            )
            if detail_parts:
                colored_parts.extend(detail_parts)
                layer_info.extend(detail_info)
                color_idx = next_color_idx
                continue

        # Regular object — keep as-is
        color = get_layer_color(color_idx)
        current_obj.colors = o3d.utility.Vector3dVector(
            [color] * len(current_obj.points)
        )

        obj_name = f"object_{i}"
        layer_info.append({
            "name": obj_name,
            "type": "detail",
            "point_count": len(current_obj.points),
        })
        colored_parts.append((obj_name, current_obj))
        color_idx += 1

    return colored_parts, layer_info


# ── Main entry point ────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Point cloud segmentation for 3DGS Studio")
    parser.add_argument("--input", required=True, help="Input PLY file path")
    parser.add_argument("--output_ply", required=True, help="Output main PLY (background removed)")
    parser.add_argument("--layers_dir", required=True, help="Directory for individual layer PLY files + metadata")
    parser.add_argument(
        "--mode",
        choices=["remove_background", "segment_all"],
        default="remove_background",
        help="Segmentation mode (default: remove_background)",
    )
    args = parser.parse_args()

    # Progress callback — prints to stdout for the Node.js process to capture
    def progress(msg):
        print(f"[PROGRESS] {msg}", flush=True)

    # ── Load input ───────────────────────────────────────────────────────
    progress(f"Loading point cloud: {args.input}")
    if not os.path.exists(args.input):
        print(f"[ERROR] Input file not found: {args.input}", file=sys.stderr)
        sys.exit(1)

    pcd = o3d.io.read_point_cloud(args.input)
    if len(pcd.points) == 0:
        print("[ERROR] Input point cloud is empty", file=sys.stderr)
        sys.exit(1)

    progress(f"Loaded {len(pcd.points)} points")

    # ── Compute adaptive parameters ──────────────────────────────────────
    params = compute_adaptive_params(pcd)
    progress(f"Scene scale: {params['bbox_scale']:.3f}m, "
             f"plane_thresh: {params['plane_distance_threshold']:.4f}, "
             f"dbscan_eps: {params['dbscan_eps']:.4f}")

    # ── Step 1: Remove background planes ─────────────────────────────────
    foreground_pcd, background_pcd = remove_background_planes(pcd, params, progress)

    layer_info = []
    all_parts = []  # list of (name, pcd) for all layers to save

    if len(background_pcd.points) > 0:
        layer_info.append({
            "name": "background",
            "type": "background",
            "point_count": len(background_pcd.points),
        })
        all_parts.append(("background", background_pcd))

    # ── Step 2: Cluster foreground into objects ──────────────────────────
    do_subsegment = (args.mode == "segment_all")
    colored_parts, fg_layer_info = cluster_foreground(
        foreground_pcd, params,
        layer_start_index=1 if len(background_pcd.points) > 0 else 0,
        do_subsegment=do_subsegment,
        progress_cb=progress,
    )

    layer_info.extend(fg_layer_info)
    all_parts.extend(colored_parts)

    # ── Build the main output PLY (foreground only, each part with its color) ──
    if colored_parts:
        merged = o3d.geometry.PointCloud()
        for _, part_pcd in colored_parts:
            merged += part_pcd
        main_pcd = merged
    elif len(foreground_pcd.points) > 0:
        # Fallback: no clusters found but foreground exists
        main_pcd = foreground_pcd
    else:
        # Nothing left after background removal — keep original
        main_pcd = pcd

    # ── Save main output PLY ─────────────────────────────────────────────
    os.makedirs(os.path.dirname(args.output_ply) or ".", exist_ok=True)
    o3d.io.write_point_cloud(args.output_ply, main_pcd)
    progress(f"Saved main PLY: {len(main_pcd.points)} points -> {args.output_ply}")

    # ── Save individual layer files ──────────────────────────────────────
    os.makedirs(args.layers_dir, exist_ok=True)

    for idx, (layer_name, layer_pcd) in enumerate(all_parts):
        # Sanitize layer name for filename
        safe_name = layer_name.replace(" ", "_").replace("/", "_")
        layer_path = os.path.join(args.layers_dir, f"layer_{idx}_{safe_name}.ply")
        o3d.io.write_point_cloud(layer_path, layer_pcd)
        progress(f"Saved layer: {layer_name} ({len(layer_pcd.points)} pts) -> {layer_path}")

    # ── Save metadata JSON ───────────────────────────────────────────────
    meta = {
        "mode": args.mode,
        "total_input_points": len(pcd.points),
        "output_points": len(main_pcd.points),
        "num_layers": len(layer_info),
        "layers": layer_info,
        "adaptive_params": {k: float(v) if isinstance(v, (int, float)) else v for k, v in params.items()},
    }

    meta_path = os.path.join(args.layers_dir, "layers_meta.json")
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2)
    progress(f"Saved metadata: {meta_path}")

    # ── Summary ──────────────────────────────────────────────────────────
    progress(f"Done! Output: {len(main_pcd.points)} pts, {len(layer_info)} layers")


if __name__ == "__main__":
    main()
