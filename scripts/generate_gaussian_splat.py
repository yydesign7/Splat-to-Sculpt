#!/usr/bin/env python3
"""
Generate a 3D Gaussian Splat PLY from a colored point cloud PLY.

This is a Mac-friendly 3DGS initialization path: it creates a splat PLY with the
field layout used by common Gaussian Splat viewers (position, normals, SH color,
opacity, scale, rotation). It does not require CUDA and is intended to make the
workflow produce a real splat asset on Apple Silicon.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import struct
import sys
from pathlib import Path

import numpy as np

C0 = 0.28209479177387814


def read_ply(path: str) -> tuple[np.ndarray, np.ndarray]:
    with open(path, "rb") as f:
        header_lines: list[str] = []
        while True:
            line = f.readline()
            if not line:
                raise RuntimeError("Invalid PLY: missing end_header")
            decoded = line.decode("utf-8", errors="replace").strip()
            header_lines.append(decoded)
            if decoded == "end_header":
                break

        if not header_lines or header_lines[0] != "ply":
            raise RuntimeError("Input is not a PLY file")

        fmt = "ascii"
        vertex_count = 0
        properties: list[tuple[str, str]] = []
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

        if vertex_count <= 0:
            raise RuntimeError("PLY has no vertices")

        prop_names = [name for _typ, name in properties]
        required = {"x", "y", "z"}
        if not required.issubset(set(prop_names)):
            raise RuntimeError("PLY must contain x/y/z vertex properties")

        def color_index(candidates: tuple[str, ...]) -> int | None:
            for c in candidates:
                if c in prop_names:
                    return prop_names.index(c)
            return None

        ix, iy, iz = prop_names.index("x"), prop_names.index("y"), prop_names.index("z")
        ir = color_index(("red", "r", "diffuse_red"))
        ig = color_index(("green", "g", "diffuse_green"))
        ib = color_index(("blue", "b", "diffuse_blue"))

        if fmt == "ascii":
            pts = np.zeros((vertex_count, 3), dtype=np.float32)
            cols = np.full((vertex_count, 3), 200, dtype=np.uint8)
            for i in range(vertex_count):
                vals = f.readline().decode("utf-8", errors="replace").strip().split()
                if len(vals) < len(properties):
                    raise RuntimeError(f"Invalid ASCII PLY vertex row {i}")
                pts[i] = [float(vals[ix]), float(vals[iy]), float(vals[iz])]
                if ir is not None and ig is not None and ib is not None:
                    cols[i] = [
                        int(float(vals[ir])),
                        int(float(vals[ig])),
                        int(float(vals[ib])),
                    ]
            return pts, cols

        if fmt != "binary_little_endian":
            raise RuntimeError(f"Unsupported PLY format: {fmt}")

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

        pts = np.zeros((vertex_count, 3), dtype=np.float32)
        cols = np.full((vertex_count, 3), 200, dtype=np.uint8)
        for i in range(vertex_count):
            row = f.read(row_size)
            if len(row) != row_size:
                raise RuntimeError(f"Unexpected EOF in binary PLY row {i}")
            vals = struct.unpack(row_fmt, row)
            pts[i] = [float(vals[ix]), float(vals[iy]), float(vals[iz])]
            if ir is not None and ig is not None and ib is not None:
                cols[i] = [
                    int(float(vals[ir])),
                    int(float(vals[ig])),
                    int(float(vals[ib])),
                ]
        return pts, cols


def resolve_device(requested: str) -> str:
    if requested == "cpu":
        return "cpu"
    try:
        import torch  # type: ignore

        if requested in ("auto", "cuda") and torch.cuda.is_available():
            return "cuda"
        if requested in ("auto", "mps") and hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return "mps"
    except Exception:
        return "cpu"
    return "cpu"


def estimate_log_scales(points: np.ndarray, max_points_for_nn: int = 12000, device: str = "cpu") -> np.ndarray:
    if len(points) <= 1:
        return np.full((len(points), 3), math.log(0.01), dtype=np.float32)

    sample = points
    if len(points) > max_points_for_nn:
        idx = np.linspace(0, len(points) - 1, max_points_for_nn, dtype=np.int64)
        sample = points[idx]

    try:
        if device in ("cuda", "mps"):
            import torch  # type: ignore

            with torch.no_grad():
                t = torch.from_numpy(sample.astype(np.float32)).to(device)
                dist = torch.cdist(t, t)
                dist.fill_diagonal_(float("inf"))
                nearest_t = torch.min(dist, dim=1).values
                nearest = nearest_t.detach().cpu().numpy()
        else:
            diff = sample[:, None, :] - sample[None, :, :]
            dist2 = np.sum(diff * diff, axis=2)
            np.fill_diagonal(dist2, np.inf)
            nearest = np.sqrt(np.min(dist2, axis=1))
        base = float(np.median(nearest[np.isfinite(nearest)]))
    except (MemoryError, RuntimeError):
        span = np.linalg.norm(points.max(axis=0) - points.min(axis=0))
        base = span / max(float(len(points)) ** (1.0 / 3.0), 1.0)

    if not np.isfinite(base) or base <= 0:
        span = np.linalg.norm(points.max(axis=0) - points.min(axis=0))
        base = max(span / max(float(len(points)) ** (1.0 / 3.0), 1.0), 1e-4)

    # Slightly broad initial splats help sparse COLMAP point clouds read as surfaces.
    scale = max(base * 0.75, 1e-5)
    return np.full((len(points), 3), math.log(scale), dtype=np.float32)


def write_gaussian_ply(path: str, points: np.ndarray, colors: np.ndarray, device: str) -> None:
    n = len(points)
    rgb = np.clip(colors.astype(np.float32) / 255.0, 0.0, 1.0)
    f_dc = (rgb - 0.5) / C0
    f_rest = np.zeros((n, 45), dtype=np.float32)
    opacity = np.full((n, 1), math.log(0.10 / 0.90), dtype=np.float32)
    scales = estimate_log_scales(points, device=device)
    rotations = np.zeros((n, 4), dtype=np.float32)
    rotations[:, 0] = 1.0
    normals = np.zeros((n, 3), dtype=np.float32)

    fields = [
        ("x", points[:, 0]),
        ("y", points[:, 1]),
        ("z", points[:, 2]),
        ("nx", normals[:, 0]),
        ("ny", normals[:, 1]),
        ("nz", normals[:, 2]),
        ("f_dc_0", f_dc[:, 0]),
        ("f_dc_1", f_dc[:, 1]),
        ("f_dc_2", f_dc[:, 2]),
    ]
    for i in range(45):
        fields.append((f"f_rest_{i}", f_rest[:, i]))
    fields.append(("opacity", opacity[:, 0]))
    for i in range(3):
        fields.append((f"scale_{i}", scales[:, i]))
    for i in range(4):
        fields.append((f"rot_{i}", rotations[:, i]))

    with open(path, "wb") as f:
        header = [
            "ply",
            "format binary_little_endian 1.0",
            f"element vertex {n}",
        ]
        header.extend(f"property float {name}" for name, _values in fields)
        header.append("end_header")
        f.write(("\n".join(header) + "\n").encode("utf-8"))

        row_fmt = "<" + "f" * len(fields)
        for i in range(n):
            f.write(struct.pack(row_fmt, *[float(values[i]) for _name, values in fields]))


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate a 3D Gaussian Splat PLY from a point cloud PLY")
    parser.add_argument("--input", required=True, help="Input colored point cloud PLY")
    parser.add_argument("--output-dir", required=True, help="Output directory")
    parser.add_argument("--device", choices=["auto", "cuda", "mps", "cpu"], default="auto", help="Compute device for Gaussian initialization")
    args = parser.parse_args()

    os.makedirs(args.output_dir, exist_ok=True)
    device = resolve_device(args.device)
    points, colors = read_ply(args.input)
    if len(points) == 0:
        raise RuntimeError("Input PLY contains no points")

    output_path = str(Path(args.output_dir) / "gaussian_splat.ply")
    write_gaussian_ply(output_path, points.astype(np.float32), colors, device)

    print(
        json.dumps(
            {
                "status": "ok",
                "outputPath": output_path,
                "gaussianCount": int(len(points)),
                "format": "3dgs-ply",
                "device": device,
            },
            ensure_ascii=False,
        ),
        flush=True,
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(
            json.dumps(
                {
                    "status": "error",
                    "error": str(exc),
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
        sys.exit(1)
