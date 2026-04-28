#!/usr/bin/env python3
"""
Depth alignment and point cloud fusion.

Aligns monocular depth maps to COLMAP's camera coordinate system using
the sparse point cloud as reference, then fuses them into a dense point cloud.

Usage:
    python3 depth_fusion.py \
        --sparse_dir /path/to/colmap/sparse/0 \
        --images_dir /path/to/images \
        --depth_dir /path/to/depth_maps \
        --output_ply /path/to/output.ply

Requires: COLMAP sparse model (cameras.bin, images.bin, points3D.bin),
          depth maps from depth_estimate.py
"""

import argparse
import os
import sys
import json
import struct
import numpy as np
from pathlib import Path

try:
    import cv2
    from PIL import Image
except ImportError as e:
    print(f"Missing dependency: {e}", file=sys.stderr)
    sys.exit(1)


# =============================================================================
# COLMAP binary model readers
# =============================================================================

def read_cameras_binary(path: str) -> dict:
    """Read cameras.bin from COLMAP sparse model."""
    cameras = {}
    with open(path, "rb") as f:
        num_cameras = struct.unpack("<Q", f.read(8))[0]
        for _ in range(num_cameras):
            camera_id = struct.unpack("<I", f.read(4))[0]
            model_id = struct.unpack("<I", f.read(4))[0]
            width = struct.unpack("<Q", f.read(8))[0]
            height = struct.unpack("<Q", f.read(8))[0]
            num_params = 4 if model_id == 6 else 3  # SIMPLE_RADIAL or PINHOLE
            params = struct.unpack(f"<{num_params}d", f.read(8 * num_params))
            # model_id: 0=CAMERA_PINHOLE, 1=CAMERA_SIMPLE_RADIAL, 2=CAMERA_RADIAL, 6=CAMERA_SIMPLE_RADIAL_FISHEYE
            cameras[camera_id] = {
                "model": "SIMPLE_RADIAL" if model_id != 0 else "PINHOLE",
                "width": width,
                "height": height,
                "params": params,
            }
    return cameras


def read_images_binary(path: str) -> dict:
    """Read images.bin from COLMAP sparse model."""
    images = {}
    with open(path, "rb") as f:
        num_reg_images = struct.unpack("<Q", f.read(8))[0]
        for _ in range(num_reg_images):
            image_id = struct.unpack("<I", f.read(4))[0]
            # qvec (quaternion rotation)
            qvec = np.array(struct.unpack("<4d", f.read(32)))
            # tvec (translation)
            tvec = np.array(struct.unpack("<3d", f.read(24)))
            # camera_id
            camera_id = struct.unpack("<I", f.read(4))[0]
            # Image name (null-terminated string)
            name = b""
            while True:
                c = f.read(1)
                if c == b"\x00":
                    break
                name += c
            name = name.decode("utf-8")
            # 2D points
            num_points2D = struct.unpack("<Q", f.read(8))[0]
            x_y_data = struct.unpack(f"<{num_points2D * 2}d", f.read(16 * num_points2D))
            point3D_ids = struct.unpack(f"<{num_points2D}Q", f.read(8 * num_points2D))

            # Rotation matrix from quaternion
            R = qvec2rotmat(qvec)

            images[image_id] = {
                "name": name,
                "camera_id": camera_id,
                "qvec": qvec,
                "tvec": tvec,
                "R": R,
                "t": tvec.reshape(3, 1),
            }
    return images


def read_points3D_binary(path: str) -> dict:
    """Read points3D.bin from COLMAP sparse model."""
    points3D = {}
    with open(path, "rb") as f:
        num_points = struct.unpack("<Q", f.read(8))[0]
        for _ in range(num_points):
            point_id = struct.unpack("<Q", f.read(8))[0]
            xyz = np.array(struct.unpack("<3d", f.read(24)))
            rgb = np.array(struct.unpack("<3B", f.read(3)), dtype=np.uint8)
            error = struct.unpack("<d", f.read(8))[0]
            track_len = struct.unpack("<Q", f.read(8))[0]
            track = struct.unpack(f"<{2 * track_len}I", f.read(8 * track_len))
            points3D[point_id] = {
                "xyz": xyz,
                "rgb": rgb,
                "error": error,
            }
    return points3D


def read_sparse_text(sparse_dir: str) -> tuple:
    """Try reading COLMAP text model as fallback."""
    cameras = {}
    images = {}
    points3D = {}

    cameras_file = os.path.join(sparse_dir, "cameras.txt")
    images_file = os.path.join(sparse_dir, "images.txt")
    points_file = os.path.join(sparse_dir, "points3D.txt")

    if os.path.exists(cameras_file):
        with open(cameras_file, "r") as f:
            for line in f:
                if line.startswith("#"):
                    continue
                parts = line.strip().split()
                if len(parts) >= 5:
                    cam_id = int(parts[0])
                    cameras[cam_id] = {
                        "model": parts[1],
                        "width": int(parts[2]),
                        "height": int(parts[3]),
                        "params": [float(x) for x in parts[4:]],
                    }

    if os.path.exists(images_file):
        with open(images_file, "r") as f:
            lines = [l for l in f if not l.startswith("#")]
            for i in range(0, len(lines), 2):
                parts = lines[i].strip().split()
                if len(parts) < 10:
                    continue
                image_id = int(parts[0])
                qvec = np.array([float(x) for x in parts[1:5]])
                tvec = np.array([float(x) for x in parts[5:8]])
                camera_id = int(parts[8])
                name = parts[9]
                R = qvec2rotmat(qvec)
                images[image_id] = {
                    "name": name,
                    "camera_id": camera_id,
                    "qvec": qvec,
                    "tvec": tvec,
                    "R": R,
                    "t": tvec.reshape(3, 1),
                }

    return cameras, images, points3D


def qvec2rotmat(qvec: np.ndarray) -> np.ndarray:
    """Convert quaternion to rotation matrix."""
    w, x, y, z = qvec
    R = np.array([
        [1 - 2*y*y - 2*z*z, 2*x*y - 2*z*w, 2*x*z + 2*y*w],
        [2*x*y + 2*z*w, 1 - 2*x*x - 2*z*z, 2*y*z - 2*x*w],
        [2*x*z - 2*y*w, 2*y*z + 2*x*w, 1 - 2*x*x - 2*y*y],
    ])
    return R


# =============================================================================
# Depth alignment
# =============================================================================

def get_intrinsic_matrix(camera: dict) -> np.ndarray:
    """Extract 3x3 intrinsic matrix from COLMAP camera."""
    params = camera["params"]
    if camera["model"] == "PINHOLE":
        fx, fy, cx, cy = params[:4]
    elif camera["model"] in ("SIMPLE_RADIAL", "RADIAL"):
        f, cx, cy = params[:3]
        fx = fy = f
    else:
        f, cx, cy = params[:3]
        fx = fy = f

    K = np.array([
        [fx, 0, cx],
        [0, fy, cy],
        [0, 0, 1],
    ])
    return K


def align_depth_ransac(
    mono_depth: np.ndarray,
    sparse_depth: np.ndarray,
    valid_mask: np.ndarray,
    ransac_iters: int = 1000,
    inlier_threshold: float = 0.15,
    min_inlier_ratio: float = 0.5,
) -> tuple[float, float, dict]:
    """
    Compute scale and shift to align monocular depth to sparse COLMAP depth
    using RANSAC for robustness against outliers.

    Model: sparse_depth ≈ scale × mono_depth + shift

    Returns: (scale, shift, metrics_dict)
      metrics_dict contains:
        - rmse:   root mean square error of inliers after alignment
        - mae:    mean absolute error of inliers
        - abs_rel: mean absolute relative error of inliers
        - inlier_ratio: fraction of valid points kept as inliers
        - num_inliers: count of inlier points
        - method: 'ransac' or 'median_fallback'
    """
    m = valid_mask.astype(bool)
    n_valid = int(m.sum())

    if n_valid < 10:
        return 1.0, 0.0, {
            "rmse": float("inf"), "mae": float("inf"), "abs_rel": float("inf"),
            "inlier_ratio": 0.0, "num_inliers": 0, "method": "insufficient_points",
        }

    md = mono_depth[m].flatten()
    sd = sparse_depth[m].flatten()

    # ------------------------------------------------------------------
    # Pre-filter: remove extreme outliers via IQR on depth ratios
    # ------------------------------------------------------------------
    ratios = sd / (md + 1e-8)
    q1, q3 = np.percentile(ratios, [25, 75])
    iqr = q3 - q1
    ratio_lower = q1 - 2.0 * iqr
    ratio_upper = q3 + 2.0 * iqr
    pre_filter = (ratios > ratio_lower) & (ratios < ratio_upper) & (md > 1e-6) & (sd > 1e-6)
    md_pf = md[pre_filter]
    sd_pf = sd[pre_filter]

    if len(md_pf) < 10:
        md_pf = md
        sd_pf = sd

    # ------------------------------------------------------------------
    # RANSAC: sample 2 points → fit (scale, shift) → count inliers
    # Inlier = |pred - gt| / (|gt| + ε) < inlier_threshold  (relative error)
    # ------------------------------------------------------------------
    best_inlier_count = 0
    best_inliers = None
    best_scale = 1.0
    best_shift = 0.0

    n_pf = len(md_pf)
    rng = np.random.default_rng(42)

    for _ in range(ransac_iters):
        # Pick 2 random samples
        idx = rng.choice(n_pf, size=2, replace=False)
        md_s = md_pf[idx]
        sd_s = sd_pf[idx]

        # Solve 2×2 system: sd_s = scale * md_s + shift
        denom = md_s[0] - md_s[1]
        if abs(denom) < 1e-10:
            continue
        s = (sd_s[0] - sd_s[1]) / denom
        t = sd_s[0] - s * md_s[0]

        # Scale must be positive
        if s <= 0:
            continue

        # Count inliers
        pred = s * md_pf + t
        rel_err = np.abs(pred - sd_pf) / (np.abs(sd_pf) + 1e-6)
        inliers = rel_err < inlier_threshold
        inlier_count = int(inliers.sum())

        if inlier_count > best_inlier_count:
            best_inlier_count = inlier_count
            best_inliers = inliers
            best_scale = s
            best_shift = t

    # ------------------------------------------------------------------
    # Refine with least-squares on inliers
    # ------------------------------------------------------------------
    if best_inliers is not None and best_inlier_count >= 10:
        md_in = md_pf[best_inliers]
        sd_in = sd_pf[best_inliers]
        A = np.column_stack([md_in, np.ones_like(md_in)])
        result = np.linalg.lstsq(A, sd_in, rcond=None)
        scale = float(result[0][0])
        shift = float(result[0][1])

        if scale <= 0:
            # Fall back to median ratio on inliers
            scale = float(np.median(sd_in / (md_in + 1e-8)))
            shift = 0.0

        # Compute error metrics on inliers
        pred_in = scale * md_in + shift
        residuals = pred_in - sd_in
        rmse = float(np.sqrt(np.mean(residuals ** 2)))
        mae = float(np.mean(np.abs(residuals)))
        abs_rel = float(np.mean(np.abs(residuals) / (np.abs(sd_in) + 1e-6)))
        inlier_ratio = best_inlier_count / n_pf

        metrics = {
            "rmse": rmse,
            "mae": mae,
            "abs_rel": abs_rel,
            "inlier_ratio": inlier_ratio,
            "num_inliers": best_inlier_count,
            "method": "ransac",
        }
    else:
        # Not enough inliers → fall back to median scaling
        median_ratio = float(np.median(sd_pf / (md_pf + 1e-8)))
        scale = median_ratio
        shift = 0.0
        rmse = float("inf")
        mae = float("inf")
        abs_rel = float("inf")
        inlier_ratio = 0.0
        best_inlier_count = 0

        metrics = {
            "rmse": rmse,
            "mae": mae,
            "abs_rel": abs_rel,
            "inlier_ratio": inlier_ratio,
            "num_inliers": best_inlier_count,
            "method": "median_fallback",
        }

    return scale, shift, metrics


def backproject_depth_to_pointcloud(
    depth: np.ndarray,
    K: np.ndarray,
    R: np.ndarray,
    t: np.ndarray,
    image: np.ndarray,
    max_depth: float = 100.0,
    depth_scale: float = 1.0,
) -> np.ndarray:
    """
    Back-project a depth map to 3D points in world coordinates.
    
    Returns: Nx6 array (x, y, z, r, g, b)
    """
    h, w = depth.shape
    fx, fy = K[0, 0], K[1, 1]
    cx, cy = K[0, 2], K[1, 2]

    # Create pixel coordinate grids
    u_coords, v_coords = np.meshgrid(np.arange(w), np.arange(h))

    # Pixel to camera coordinates
    z = depth.astype(np.float64) * depth_scale
    x = (u_coords - cx) * z / fx
    y = (v_coords - cy) * z / fy

    # Filter by valid depth
    valid = (z > 0) & (z < max_depth)
    x, y, z = x[valid], y[valid], z[valid]

    # Camera to world
    pts_cam = np.stack([x, y, z], axis=-1)  # Nx3
    pts_world = (R.T @ (pts_cam.T - t)).T  # Nx3

    # Get colors
    if image is not None:
        colors = image.reshape(-1, 3)[valid.flatten()]
    else:
        colors = np.ones((pts_world.shape[0], 3), dtype=np.uint8) * 128

    # Combine
    result = np.column_stack([pts_world, colors])
    return result


def read_ply(filepath: str) -> np.ndarray | None:
    """Read a PLY file (ASCII or binary) and return Nx6 array (x, y, z, r, g, b)."""
    ply_path = Path(filepath)
    if not ply_path.exists():
        return None

    points = []
    with open(filepath, "rb") as f:
        # Read header
        header_lines = []
        while True:
            line = f.readline().decode("ascii", errors="ignore").strip()
            header_lines.append(line)
            if line == "end_header":
                break

        # Parse vertex count
        num_vertices = 0
        has_color = False
        for line in header_lines:
            if line.startswith("element vertex"):
                num_vertices = int(line.split()[-1])
            if "red" in line and "green" in line and "blue" in line:
                has_color = True

        if num_vertices == 0:
            return None

        # Determine if binary
        is_binary = False
        for line in header_lines:
            if line.startswith("format binary"):
                is_binary = True
                break

        if is_binary:
            # Read binary PLY (little-endian float32 x 3 + uint8 x 3)
            for _ in range(num_vertices):
                xyz = struct.unpack("<3f", f.read(12))
                if has_color:
                    rgb = struct.unpack("<3B", f.read(3))
                    # Skip any extra properties (read remaining bytes per vertex)
                    # Standard PLY with x,y,z,red,green,blue = 15 bytes
                    points.append([xyz[0], xyz[1], xyz[2], rgb[0], rgb[1], rgb[2]])
                else:
                    points.append([xyz[0], xyz[1], xyz[2], 128, 128, 128])
                    # Skip any extra bytes - approximate
        else:
            # Read ASCII PLY
            for _ in range(num_vertices):
                line = f.readline().decode("ascii", errors="ignore").strip()
                if not line:
                    continue
                parts = line.split()
                if has_color and len(parts) >= 6:
                    x, y, z = float(parts[0]), float(parts[1]), float(parts[2])
                    r, g, b = int(float(parts[3])), int(float(parts[4])), int(float(parts[5]))
                    points.append([x, y, z, r, g, b])
                elif len(parts) >= 3:
                    x, y, z = float(parts[0]), float(parts[1]), float(parts[2])
                    points.append([x, y, z, 128, 128, 128])

    if not points:
        return None

    return np.array(points, dtype=np.float64)


def write_ply(filepath: str, points: np.ndarray):
    """Write a point cloud to PLY format."""
    n = points.shape[0]
    with open(filepath, "w") as f:
        f.write("ply\n")
        f.write("format ascii 1.0\n")
        f.write(f"element vertex {n}\n")
        f.write("property float x\n")
        f.write("property float y\n")
        f.write("property float z\n")
        f.write("property uchar red\n")
        f.write("property uchar green\n")
        f.write("property uchar blue\n")
        f.write("end_header\n")
        for i in range(n):
            f.write(f"{points[i, 0]:.6f} {points[i, 1]:.6f} {points[i, 2]:.6f} "
                    f"{int(points[i, 3])} {int(points[i, 4])} {int(points[i, 5])}\n")


# =============================================================================
# Main fusion pipeline
# =============================================================================

def main():
    parser = argparse.ArgumentParser(description="Depth alignment and point cloud fusion")
    parser.add_argument("--sparse_dir", required=True, help="COLMAP sparse model directory")
    parser.add_argument("--images_dir", required=True, help="Directory with original frame images")
    parser.add_argument("--depth_dir", required=True, help="Directory with depth .npy files from depth_estimate.py")
    parser.add_argument("--output_ply", required=True, help="Output PLY file path")
    parser.add_argument("--max_depth", type=float, default=100.0, help="Maximum depth threshold")
    parser.add_argument("--sample_step", type=int, default=4, help="Sample every Nth pixel for densification")
    parser.add_argument("--dense_ply", type=str, default=None,
                        help="Path to COLMAP dense fused PLY to merge with depth-based points")
    parser.add_argument("--fuse_with_colmap", action="store_true", default=True,
                        help="Fuse aligned depth with COLMAP sparse points")
    args = parser.parse_args()

    sparse_dir = Path(args.sparse_dir)
    images_dir = Path(args.images_dir)
    depth_dir = Path(args.depth_dir)

    # Step 1: Read COLMAP sparse model
    print(json.dumps({"status": "reading_colmap"}), flush=True)

    cameras = {}
    images_data = {}
    points3D = {}

    # Try binary format first
    cameras_bin = sparse_dir / "cameras.bin"
    images_bin = sparse_dir / "images.bin"
    points_bin = sparse_dir / "points3D.bin"

    try:
        if cameras_bin.exists() and images_bin.exists():
            cameras = read_cameras_binary(str(cameras_bin))
            images_data = read_images_binary(str(images_bin))
            if points_bin.exists():
                points3D = read_points3D_binary(str(points_bin))
    except Exception as e:
        print(json.dumps({"status": "warning", "message": f"Binary read failed: {e}"}), flush=True)

    # Fall back to text format
    if not cameras:
        try:
            cameras, images_data, points3D = read_sparse_text(str(sparse_dir))
        except Exception as e:
            print(json.dumps({"status": "error", "error": f"Failed to read COLMAP model: {e}"}))
            sys.exit(1)

    if not cameras or not images_data:
        print(json.dumps({"status": "error", "error": "Empty COLMAP model"}))
        sys.exit(1)

    print(json.dumps({
        "status": "colmap_loaded",
        "num_cameras": len(cameras),
        "num_images": len(images_data),
        "num_points3D": len(points3D),
    }), flush=True)

    # Step 2: Build sparse depth maps from COLMAP points for alignment
    # We project COLMAP 3D points back to each image to create sparse depth reference
    print(json.dumps({"status": "building_sparse_depth"}), flush=True)

    # Build projection matrix for each image
    all_fused_points = []

    # Add COLMAP sparse points first
    if points3D:
        colmap_pts = np.array([p["xyz"] for p in points3D.values()])
        colmap_colors = np.array([p["rgb"] for p in points3D.values()])
        sparse_pointcloud = np.column_stack([colmap_pts, colmap_colors])
        all_fused_points.append(sparse_pointcloud)
        print(json.dumps({"status": "colmap_points_added", "count": len(colmap_pts)}), flush=True)

    # Add COLMAP dense fused PLY if provided
    if args.dense_ply and Path(args.dense_ply).exists():
        dense_pts = read_ply(args.dense_ply)
        if dense_pts is not None and len(dense_pts) > 0:
            all_fused_points.append(dense_pts)
            print(json.dumps({"status": "dense_ply_added", "count": len(dense_pts)}), flush=True)

    # Step 3: For each image with depth map, align and back-project
    print(json.dumps({"status": "aligning_depths"}), flush=True)

    aligned_count = 0
    all_align_metrics: list[dict] = []  # Track alignment quality across all images
    for img_id, img_info in images_data.items():
        img_name = img_info["name"]
        camera_id = img_info["camera_id"]
        R = img_info["R"]
        t = img_info["t"]

        if camera_id not in cameras:
            continue

        camera = cameras[camera_id]
        K = get_intrinsic_matrix(camera)
        img_w = camera["width"]
        img_h = camera["height"]

        # Find matching depth file
        img_stem = Path(img_name).stem
        depth_npy = depth_dir / f"depth_{img_stem}.npy"

        if not depth_npy.exists():
            # Try with the frame numbering pattern
            depth_files = list(depth_dir.glob("depth_*.npy"))
            if depth_files:
                # Try to match by order
                sorted_images = sorted(images_data.items(), key=lambda x: x[1]["name"])
                img_idx = next((i for i, (k, v) in enumerate(sorted_images) if k == img_id), -1)
                if 0 <= img_idx < len(depth_files):
                    depth_npy = depth_files[img_idx]

        if not depth_npy.exists():
            continue

        # Load depth map
        mono_depth = np.load(str(depth_npy))

        # Resize depth to match image dimensions if needed
        if mono_depth.shape[0] != img_h or mono_depth.shape[1] != img_w:
            mono_depth = cv2.resize(mono_depth, (img_w, img_h), interpolation=cv2.INTER_LINEAR)

        # Build sparse depth from COLMAP for this image
        # Project 3D points to this image
        sparse_depth = np.zeros((img_h, img_w), dtype=np.float64)
        valid_mask = np.zeros((img_h, img_w), dtype=bool)

        if points3D:
            for pt_id, pt_info in points3D.items():
                xyz = pt_info["xyz"]
                # Project to image
                pts_cam = R @ xyz.reshape(3, 1) + t
                if pts_cam[2, 0] <= 0:
                    continue
                pts_img = K @ pts_cam
                u = int(round(pts_img[0, 0] / pts_img[2, 0]))
                v = int(round(pts_img[1, 0] / pts_img[2, 0]))
                if 0 <= u < img_w and 0 <= v < img_h:
                    sparse_depth[v, u] = pts_cam[2, 0]
                    valid_mask[v, u] = True

        # Step 4: Align monocular depth to COLMAP scale (RANSAC)
        scale, shift, align_metrics = align_depth_ransac(
            mono_depth, sparse_depth, valid_mask,
            ransac_iters=1000,
            inlier_threshold=0.15,
            min_inlier_ratio=0.5,
        )

        # Quality gate: if alignment is poor, fall back to median scaling
        if align_metrics["method"] == "ransac" and align_metrics["abs_rel"] > 0.5:
            # Alignment too unreliable — use per-image median ratio
            if points3D:
                colmap_depths = [p["xyz"][2] for p in points3D.values()]
                median_colmap = float(np.median(colmap_depths))
                median_mono = float(np.median(mono_depth[mono_depth > 0]))
                if median_mono > 1e-6:
                    scale = median_colmap / median_mono
                    shift = 0.0
                    align_metrics["method"] = "median_quality_fallback"
            else:
                scale = 1.0
                shift = 0.0
                align_metrics["method"] = "no_colmap_fallback"

        aligned_depth = mono_depth * scale + shift

        # Track alignment quality
        all_align_metrics.append(align_metrics)

        # Load the original image for colors
        img_path = images_dir / img_name
        image_rgb = None
        if img_path.exists():
            img = cv2.imread(str(img_path))
            if img is not None:
                image_rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)

        # Step 5: Back-project aligned depth to 3D
        pts = backproject_depth_to_pointcloud(
            depth=aligned_depth,
            K=K, R=R, t=t,
            image=image_rgb,
            max_depth=args.max_depth,
            depth_scale=1.0,  # Already aligned
        )

        # Subsample for memory efficiency
        if args.sample_step > 1:
            pts = pts[::args.sample_step]

        all_fused_points.append(pts)
        aligned_count += 1

        # Report progress with alignment quality metrics every 5 images
        if aligned_count % 5 == 0:
            print(json.dumps({
                "status": "progress",
                "aligned": aligned_count,
                "total_images": len(images_data),
                "last_alignment": {
                    "method": align_metrics["method"],
                    "abs_rel": round(align_metrics["abs_rel"], 4),
                    "rmse": round(align_metrics["rmse"], 4),
                    "inlier_ratio": round(align_metrics["inlier_ratio"], 3),
                },
            }), flush=True)

    # Step 6: Merge all points and write PLY
    print(json.dumps({"status": "merging_points"}), flush=True)

    if not all_fused_points:
        print(json.dumps({"status": "error", "error": "No point cloud data generated"}))
        sys.exit(1)

    fused = np.vstack(all_fused_points)

    # Remove NaN/Inf
    valid = np.all(np.isfinite(fused[:, :3]), axis=1)
    fused = fused[valid]

    # Write PLY
    output_path = Path(args.output_ply)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    write_ply(str(output_path), fused)

    # Compute aggregate alignment statistics
    ransac_count = sum(1 for m in all_align_metrics if m["method"] == "ransac")
    fallback_count = sum(1 for m in all_align_metrics if m["method"] != "ransac")
    avg_abs_rel = float(np.mean([m["abs_rel"] for m in all_align_metrics if m["abs_rel"] < float("inf")])) if all_align_metrics else float("inf")
    avg_inlier_ratio = float(np.mean([m["inlier_ratio"] for m in all_align_metrics])) if all_align_metrics else 0.0

    print(json.dumps({
        "status": "done",
        "total_points": len(fused),
        "colmap_sparse_points": len(points3D),
        "aligned_depth_images": aligned_count,
        "alignment_stats": {
            "ransac_aligned": ransac_count,
            "fallback_aligned": fallback_count,
            "avg_abs_rel": round(avg_abs_rel, 4),
            "avg_inlier_ratio": round(avg_inlier_ratio, 3),
        },
        "output_ply": str(output_path),
    }), flush=True)


if __name__ == "__main__":
    main()
