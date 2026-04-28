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

# Slightly lower depth: fewer spurious high-frequency sheets on thin parts (e.g. chair legs).
POISSON_DEPTH = 8
# Denser trim: remove more low-confidence Poisson vertices (typical "flying" sheets).
DENSITY_PERCENTILE = 7.0
# A bit coarser voxels: smoother input, less noise for Poisson to overfit.
VOXEL_FRAC = 0.0065


def estimate_poisson_normals(pcd: o3d.geometry.PointCloud, voxel_size: float, scale: float):
    """Estimate stable, consistently oriented normals for Poisson reconstruction."""
    nn_distances = np.asarray(pcd.compute_nearest_neighbor_distance())
    median_nn = float(np.median(nn_distances)) if len(nn_distances) > 0 else voxel_size

    normal_radius = max(voxel_size * 3.0, median_nn * 8.0, scale * 0.005)
    normal_max_nn = 80

    pcd.estimate_normals(
        search_param=o3d.geometry.KDTreeSearchParamHybrid(
            radius=normal_radius,
            max_nn=normal_max_nn,
        )
    )
    pcd.normalize_normals()

    orient_k = min(100, max(10, len(pcd.points) // 20))
    pcd.orient_normals_consistent_tangent_plane(orient_k)

    # Do NOT flip all normals to point away from a single global centroid: that breaks
    # on concave objects (chairs, table undersides) and worsens Poisson "wings".
    # Orient so normals point toward a fixed "viewer" well outside the bounding box.
    min_b = pcd.get_min_bound()
    max_b = pcd.get_max_bound()
    diag = max_b - min_b
    extent = float(np.linalg.norm(diag)) if float(np.linalg.norm(diag)) > 1e-9 else 1.0
    # Camera sits above + along diagonal so typical upright scans are covered.
    camera = max_b + diag * 0.75 + np.array([0.0, extent * 0.35, 0.0])
    pcd.orient_normals_towards_camera_location(camera)


def _remove_tiny_island_meshes(mesh: o3d.geometry.TriangleMesh) -> o3d.geometry.TriangleMesh:
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
    # Dropping the bottom ~0.1% of tri count removes specks, keeps disjoint legs if substantial.
    thresh = max(25, int(0.0010 * ntri))
    to_remove = np.zeros(ntri, dtype=bool)
    for i, c in enumerate(counts):
        if c < thresh:
            to_remove |= clus == i
    if not np.any(to_remove):
        return mesh
    mesh.remove_triangles_by_mask(to_remove.tolist())
    mesh.remove_unreferenced_vertices()
    return mesh


def run_pipeline(input_path: str, output_dir: str, output_format: str):
    os.makedirs(output_dir, exist_ok=True)

    # Read point cloud
    pcd = o3d.io.read_point_cloud(input_path)
    if len(pcd.points) == 0:
        print(json.dumps({"status": "error", "error": "PLY file has no point data"}), flush=True)
        return

    point_count = len(pcd.points)
    has_colors = pcd.has_colors()

    # Adaptive voxel size
    center = pcd.get_center()
    max_bound = pcd.get_max_bound()
    scale = float(np.linalg.norm(max_bound - center))
    if scale == 0:
        scale = 1.0
    voxel_size = float(scale) * VOXEL_FRAC

    # Downsample
    pcd_down = pcd.voxel_down_sample(voxel_size=voxel_size)

    # Remove outliers: tighter to drop sparse spikes before Poisson hallucinates surface.
    cl, ind = pcd_down.remove_statistical_outlier(nb_neighbors=20, std_ratio=2.0)
    pcd_clean = pcd_down.select_by_index(ind)

    # Second pass: drop isolated clumps in radius neighborhood (mild, scale-aware)
    n_before = len(pcd_clean.points)
    r_rad = max(voxel_size * 2.5, scale * 0.0008)
    if n_before >= 30:
        cl2, ind2 = pcd_clean.remove_radius_outlier(nb_points=10, radius=r_rad)
        pcd_r = pcd_clean.select_by_index(ind2)
        # Avoid stripping thin structures: only apply if a majority of points remain
        if len(pcd_r.points) >= 10 and len(pcd_r.points) >= 0.45 * n_before:
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
    estimate_poisson_normals(pcd_clean, voxel_size, scale)

    # Poisson reconstruction
    mesh, densities = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(
        pcd_clean, depth=POISSON_DEPTH, scale=1.05, linear_fit=False
    )

    # Density clipping — trim low-implicit-surface confidence (fly sheets sit here)
    densities = np.asarray(densities)
    density_threshold = float(np.percentile(densities, DENSITY_PERCENTILE))
    mesh.remove_vertices_by_mask(densities < density_threshold)

    mesh = _remove_tiny_island_meshes(mesh)
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
    try:
        mesh = mesh.filter_smooth_laplacian(number_of_iterations=1, lambda_filter=0.32)
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
        "faceCount": face_count,
        "vertexCount": len(mesh.vertices),
    }
    print(json.dumps(result), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Point cloud to mesh conversion")
    parser.add_argument("--input", required=True, help="Input PLY file path")
    parser.add_argument("--output-dir", required=True, help="Output directory")
    parser.add_argument("--format", required=True, choices=["glb", "obj", "ply"], help="Output format")
    args = parser.parse_args()

    try:
        run_pipeline(args.input, args.output_dir, args.format)
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
