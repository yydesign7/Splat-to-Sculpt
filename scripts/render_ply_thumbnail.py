#!/usr/bin/env python3
"""Render a small static thumbnail for point-cloud or Gaussian-splat PLY files."""

from __future__ import annotations

import argparse
import json
import math
import random
import struct
from pathlib import Path

import numpy as np


PLY_TYPES = {
    "char": ("b", 1),
    "int8": ("b", 1),
    "uchar": ("B", 1),
    "uint8": ("B", 1),
    "short": ("h", 2),
    "int16": ("h", 2),
    "ushort": ("H", 2),
    "uint16": ("H", 2),
    "int": ("i", 4),
    "int32": ("i", 4),
    "uint": ("I", 4),
    "uint32": ("I", 4),
    "float": ("f", 4),
    "float32": ("f", 4),
    "double": ("d", 8),
    "float64": ("d", 8),
}


def read_ply_vertices(path: Path) -> tuple[np.ndarray, np.ndarray | None]:
    with path.open("rb") as f:
        header_lines: list[str] = []
        while True:
            line = f.readline()
            if not line:
                raise ValueError("Invalid PLY: missing end_header")
            text = line.decode("ascii", errors="replace").strip()
            header_lines.append(text)
            if text == "end_header":
                break

        fmt = "ascii"
        vertex_count = 0
        vertex_props: list[tuple[str, str]] = []
        current_element: str | None = None

        for line in header_lines:
            parts = line.split()
            if not parts:
                continue
            if parts[0] == "format":
                fmt = parts[1]
            elif parts[0] == "element":
                current_element = parts[1]
                if current_element == "vertex":
                    vertex_count = int(parts[2])
            elif parts[0] == "property" and current_element == "vertex" and len(parts) >= 3:
                if parts[1] == "list":
                    continue
                vertex_props.append((parts[2], parts[1]))

        if vertex_count <= 0:
            raise ValueError("PLY has no vertices")

        names = [name for name, _ in vertex_props]
        for required in ("x", "y", "z"):
            if required not in names:
                raise ValueError(f"PLY vertex property '{required}' is missing")

        max_vertices = min(vertex_count, 200_000)
        if fmt == "ascii":
            rows: list[list[float]] = []
            for _ in range(vertex_count):
                line = f.readline().decode("utf-8", errors="replace").strip()
                if len(rows) >= max_vertices:
                    continue
                if line:
                    rows.append([float(v) for v in line.split()[: len(vertex_props)]])
            values = np.asarray(rows, dtype=np.float32)
        elif fmt == "binary_little_endian":
            dtype = []
            record_size = 0
            for name, typ in vertex_props:
                if typ not in PLY_TYPES:
                    raise ValueError(f"Unsupported PLY property type: {typ}")
                _, size = PLY_TYPES[typ]
                dtype.append((name, "<" + PLY_TYPES[typ][0]))
                record_size += size
            raw = f.read(record_size * vertex_count)
            arr = np.frombuffer(raw, dtype=np.dtype(dtype), count=vertex_count)
            if vertex_count > max_vertices:
                arr = arr[:max_vertices]
            values = np.column_stack([arr[name] for name in names]).astype(np.float32, copy=False)
        else:
            raise ValueError(f"Unsupported PLY format: {fmt}")

    if values.size == 0:
        raise ValueError("PLY contains no readable vertex rows")

    prop_index = {name: i for i, name in enumerate(names)}
    xyz = np.column_stack([values[:, prop_index["x"]], values[:, prop_index["y"]], values[:, prop_index["z"]]])
    valid = np.isfinite(xyz).all(axis=1)
    xyz = xyz[valid]
    values = values[valid]

    colors: np.ndarray | None = None
    if all(name in prop_index for name in ("red", "green", "blue")):
        colors = np.column_stack([
            values[:, prop_index["red"]],
            values[:, prop_index["green"]],
            values[:, prop_index["blue"]],
        ])
        if colors.max(initial=0) > 1.0:
            colors = colors / 255.0
    elif all(name in prop_index for name in ("f_dc_0", "f_dc_1", "f_dc_2")):
        sh0 = 0.28209479177387814
        colors = 0.5 + sh0 * np.column_stack([
            values[:, prop_index["f_dc_0"]],
            values[:, prop_index["f_dc_1"]],
            values[:, prop_index["f_dc_2"]],
        ])

    if colors is not None:
        colors = np.clip(colors, 0.0, 1.0)
        colors = colors[: xyz.shape[0]]

    return xyz.astype(np.float32, copy=False), colors.astype(np.float32, copy=False) if colors is not None else None


def render_thumbnail(input_path: Path, output_path: Path, width: int, height: int) -> dict[str, object]:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    xyz, colors = read_ply_vertices(input_path)
    if xyz.shape[0] == 0:
        raise ValueError("No valid vertices to render")

    max_points = 8000
    if xyz.shape[0] > max_points:
        rng = random.Random(7)
        idx = np.asarray(rng.sample(range(xyz.shape[0]), max_points), dtype=np.int64)
        xyz = xyz[idx]
        if colors is not None:
            colors = colors[idx]

    center = np.median(xyz, axis=0)
    xyz = xyz - center
    radius = float(np.percentile(np.linalg.norm(xyz, axis=1), 95))
    if not math.isfinite(radius) or radius <= 0:
        radius = float(np.max(np.abs(xyz))) or 1.0

    fig = plt.figure(figsize=(width / 100, height / 100), dpi=100)
    fig.patch.set_facecolor("#121216")
    ax = fig.add_subplot(111, projection="3d")
    ax.set_facecolor("#121216")
    ax.view_init(elev=22, azim=-55)
    ax.scatter(
        xyz[:, 0],
        xyz[:, 1],
        xyz[:, 2],
        c=colors if colors is not None else "#9d8df0",
        s=0.7 if xyz.shape[0] > 3000 else 1.3,
        linewidths=0,
        alpha=0.95,
        depthshade=False,
    )
    ax.set_xlim(-radius, radius)
    ax.set_ylim(-radius, radius)
    ax.set_zlim(-radius, radius)
    ax.set_axis_off()
    ax.margins(0)
    plt.subplots_adjust(0, 0, 1, 1)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_path, facecolor=fig.get_facecolor(), bbox_inches="tight", pad_inches=0)
    plt.close(fig)

    return {"vertex_count": int(xyz.shape[0]), "thumbnail_path": str(output_path)}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--width", type=int, default=144)
    parser.add_argument("--height", type=int, default=96)
    args = parser.parse_args()

    try:
        result = render_thumbnail(Path(args.input), Path(args.output), args.width, args.height)
        print(json.dumps({"status": "ok", **result}))
    except Exception as exc:
        print(json.dumps({"status": "error", "error": str(exc)}))
        raise


if __name__ == "__main__":
    main()
