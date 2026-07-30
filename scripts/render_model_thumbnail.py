#!/usr/bin/env python3
"""Render a small static thumbnail for mesh model files such as GLB, GLTF, and OBJ."""

from __future__ import annotations

import argparse
import json
import math
import random
from pathlib import Path

import numpy as np
import trimesh


def load_as_mesh(input_path: Path) -> trimesh.Trimesh:
    loaded = trimesh.load(input_path, force="scene")
    if isinstance(loaded, trimesh.Trimesh):
        return loaded

    if not isinstance(loaded, trimesh.Scene):
        raise ValueError("Unsupported model content")

    try:
        mesh = loaded.to_geometry() if hasattr(loaded, "to_geometry") else loaded.dump(concatenate=True)
        if isinstance(mesh, trimesh.Trimesh) and len(mesh.vertices) > 0 and len(mesh.faces) > 0:
            return mesh
    except Exception:
        pass

    meshes: list[trimesh.Trimesh] = []
    for node_name in loaded.graph.nodes_geometry:
        transform, geometry_name = loaded.graph[node_name]
        geometry = loaded.geometry.get(geometry_name)
        if isinstance(geometry, trimesh.Trimesh) and len(geometry.vertices) > 0 and len(geometry.faces) > 0:
            copy = geometry.copy()
            copy.apply_transform(transform)
            meshes.append(copy)

    if not meshes:
        raise ValueError("Model has no renderable mesh geometry")

    return trimesh.util.concatenate(meshes)


def face_colors(mesh: trimesh.Trimesh, face_count: int) -> np.ndarray:
    try:
        colors = np.asarray(mesh.visual.face_colors[:face_count], dtype=np.float32) / 255.0
        if colors.ndim == 2 and colors.shape[1] >= 3:
            return np.clip(colors[:, :3], 0.0, 1.0)
    except Exception:
        pass
    return np.tile(np.asarray([[0.62, 0.56, 0.50]], dtype=np.float32), (face_count, 1))


def preview_colors(mesh: trimesh.Trimesh, face_indices: np.ndarray) -> np.ndarray:
    colors = face_colors(mesh, len(mesh.faces))[face_indices]
    bg = np.asarray([18, 18, 22], dtype=np.float32) / 255.0
    contrast = np.abs(colors - bg).mean(axis=1)
    luminance = colors @ np.asarray([0.2126, 0.7152, 0.0722], dtype=np.float32)

    if float(np.percentile(contrast, 90)) < 0.16 or float(np.percentile(luminance, 90)) < 0.28:
        return np.tile(np.asarray([[0.74, 0.69, 0.58]], dtype=np.float32), (len(face_indices), 1))

    return np.clip(colors * 0.45 + 0.55, 0.0, 1.0)


def robust_view_bounds(vertices: np.ndarray) -> tuple[np.ndarray, float]:
    if vertices.shape[0] >= 24:
        lower = np.percentile(vertices, 2, axis=0)
        upper = np.percentile(vertices, 98, axis=0)
    else:
        lower = vertices.min(axis=0)
        upper = vertices.max(axis=0)

    extents = upper - lower
    if not np.isfinite(extents).all() or float(np.max(extents)) <= 0:
        lower = vertices.min(axis=0)
        upper = vertices.max(axis=0)
        extents = upper - lower

    center = (lower + upper) / 2.0
    radius = float(np.max(extents)) * 0.62
    if not math.isfinite(radius) or radius <= 0:
        radius = float(np.max(np.abs(vertices - center))) or 1.0
    return center.astype(np.float32), radius


def render_thumbnail(input_path: Path, output_path: Path, width: int, height: int) -> dict[str, object]:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from mpl_toolkits.mplot3d.art3d import Poly3DCollection

    mesh = load_as_mesh(input_path)
    mesh.remove_unreferenced_vertices()
    if len(mesh.vertices) == 0 or len(mesh.faces) == 0:
        raise ValueError("Model has no renderable faces")

    vertices = np.asarray(mesh.vertices, dtype=np.float32)
    finite = np.isfinite(vertices).all(axis=1)
    if not finite.all():
        mesh.update_vertices(finite)
        vertices = np.asarray(mesh.vertices, dtype=np.float32)

    max_faces = 12000
    faces = mesh.faces
    if len(faces) > max_faces:
        rng = random.Random(11)
        face_indices = np.asarray(rng.sample(range(len(faces)), max_faces), dtype=np.int64)
        faces = faces[face_indices]
    else:
        face_indices = np.arange(len(faces), dtype=np.int64)

    center, radius = robust_view_bounds(vertices)
    colors = preview_colors(mesh, face_indices[: len(faces)])

    fig = plt.figure(figsize=(width / 100, height / 100), dpi=100)
    fig.patch.set_facecolor("#121216")
    ax = fig.add_subplot(111, projection="3d")
    ax.set_facecolor("#121216")
    ax.view_init(elev=24, azim=-42)

    poly = Poly3DCollection(vertices[faces], linewidths=0.08, alpha=0.98)
    poly.set_facecolor(colors)
    poly.set_edgecolor((0.95, 0.90, 0.75, 0.10))
    ax.add_collection3d(poly)

    ax.set_xlim(center[0] - radius, center[0] + radius)
    ax.set_ylim(center[1] - radius, center[1] + radius)
    ax.set_zlim(center[2] - radius, center[2] + radius)
    ax.set_axis_off()
    ax.margins(0)
    plt.subplots_adjust(0, 0, 1, 1)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_path, facecolor=fig.get_facecolor(), bbox_inches="tight", pad_inches=0)
    plt.close(fig)

    return {
        "vertex_count": int(len(mesh.vertices)),
        "face_count": int(len(mesh.faces)),
        "thumbnail_path": str(output_path),
    }


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
