#!/usr/bin/env python3
"""
Merge multiple glTF/GLB files into one GLB (one scene, multiple named nodes).
Vertices are not transformed; world coordinates are preserved.

Output: last line JSON { "status": "ok", "output_path": "..." } or error.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

import trimesh


def merge_glbs(file_paths: list[str], names: list[str] | None, output_path: str) -> str:
    if len(file_paths) < 1:
        raise ValueError("Need at least one input path")

    if not names or len(names) < len(file_paths):
        base = list(names) if names else []
        for i in range(len(base), len(file_paths)):
            base.append(f"layer_{i}")
        names = base

    scene = trimesh.Scene()
    for i, path in enumerate(file_paths):
        if not os.path.isfile(path):
            raise FileNotFoundError(f"File not found: {path}")
        name = str(names[i]).replace("/", "_")
        ext = os.path.splitext(path)[1].lower()
        if ext in (".glb", ".gltf"):
            loaded = trimesh.load(path, file_type="glb" if ext == ".glb" else "gltf")
        else:
            loaded = trimesh.load(path)

        if isinstance(loaded, trimesh.Trimesh):
            scene.add_geometry(loaded, node_name=f"{name}_mesh")
        elif isinstance(loaded, trimesh.Scene):
            for j, (gkey, geom) in enumerate(loaded.geometry.items()):
                node_nm = f"{name}_{gkey}" if (j > 0 or len(loaded.geometry) > 1) else name
                scene.add_geometry(geom, node_name=node_nm)
        else:
            m = trimesh.util.concatenate(list(loaded.geometry.values()))
            scene.add_geometry(m, node_name=f"{name}_mesh")

    outdir = os.path.dirname(os.path.abspath(output_path))
    if outdir:
        os.makedirs(outdir, exist_ok=True)
    scene.export(output_path, file_type="glb")
    if not os.path.isfile(output_path):
        raise RuntimeError("Export did not create output file")
    return output_path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True, help="Output merged .glb path")
    parser.add_argument("--input-json", required=True, help='JSON with paths and optional names')
    args = parser.parse_args()
    with open(args.input_json, "r", encoding="utf-8") as f:
        spec = json.load(f)
    paths = spec.get("paths") or spec.get("glbPaths")
    if not paths:
        print(json.dumps({"status": "error", "error": "Missing paths"}))
        sys.exit(1)
    nms = spec.get("names") or spec.get("layerNames")
    try:
        out = merge_glbs(paths, nms, args.out)
        print(json.dumps({"status": "ok", "output_path": out}, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"status": "error", "error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
