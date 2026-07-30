#!/usr/bin/env python3
from __future__ import annotations

import tempfile
from pathlib import Path
import sys

import numpy as np
import open3d as o3d
import trimesh

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from gs_to_mesh import (  # noqa: E402
    export_geometry_graph_surface_layers,
    graph_geometry_segmentation,
)


def _assert_connected_regions(faces: np.ndarray, face_labels: np.ndarray) -> None:
    tm = trimesh.Trimesh(vertices=np.zeros((int(faces.max()) + 1, 3)), faces=faces, process=False, validate=False)
    adjacency = np.asarray(tm.face_adjacency, dtype=np.int64)
    for label_id in np.unique(face_labels):
      region_faces = set(np.flatnonzero(face_labels == label_id).tolist())
      if len(region_faces) <= 1:
          continue
      start = next(iter(region_faces))
      seen = {start}
      stack = [start]
      while stack:
          current = stack.pop()
          touching = adjacency[(adjacency[:, 0] == current) | (adjacency[:, 1] == current)]
          for a, b in touching:
              other = int(b if int(a) == current else a)
              if other in region_faces and other not in seen:
                  seen.add(other)
                  stack.append(other)
      if seen != region_faces:
          raise AssertionError(f"Region {label_id} is not connected")


def test_cube_segments_into_planar_regions() -> None:
    mesh = o3d.geometry.TriangleMesh.create_box(width=1.0, height=1.0, depth=1.0)
    mesh.compute_vertex_normals()
    vertices = np.asarray(mesh.vertices, dtype=np.float64)
    faces = np.asarray(mesh.triangles, dtype=np.int64)
    segmentation = graph_geometry_segmentation(vertices, faces)

    face_labels = np.asarray(segmentation["face_labels"])
    if len(face_labels) != len(faces):
        raise AssertionError("Every face should receive a geometry_graph_surface region id")
    if int(segmentation["label_count"]) < 3:
        raise AssertionError("Cube should split into multiple planar regions")
    surface_types = {region["surface_type"] for region in segmentation["labels_metadata"]}
    if "planar" not in surface_types:
        raise AssertionError("Cube segmentation should include planar regions")
    _assert_connected_regions(faces, face_labels)


def test_cylinder_exports_smooth_curved_layer_glbs() -> None:
    mesh = o3d.geometry.TriangleMesh.create_cylinder(radius=0.5, height=1.5, resolution=48)
    mesh.compute_vertex_normals()
    with tempfile.TemporaryDirectory() as tmp:
        result = export_geometry_graph_surface_layers(mesh, tmp)
        surface_types = {region["surface_type"] for region in result["labelsMetadata"]}
        if "smooth_curved" not in surface_types:
            raise AssertionError("Cylinder side should produce a smooth_curved region")
        if int(result["segmentationLabelCount"]) != len(result["layerGlbPaths"]):
            raise AssertionError("Each geometry region should export one layer GLB")
        for layer_path in result["layerGlbPaths"]:
            if not Path(layer_path).exists():
                raise AssertionError(f"Missing layer GLB: {layer_path}")
        if not Path(result["segmentationMetadataPath"]).exists():
            raise AssertionError("Missing layers_meta.json")


def test_oversegmented_mesh_exports_at_most_eight_layer_glbs() -> None:
    mesh = o3d.geometry.TriangleMesh()
    for i in range(12):
        box = o3d.geometry.TriangleMesh.create_box(width=0.6, height=0.6, depth=0.6)
        box.translate((float(i) * 1.2, 0.0, 0.0))
        mesh += box
    mesh.compute_vertex_normals()

    with tempfile.TemporaryDirectory() as tmp:
        result = export_geometry_graph_surface_layers(mesh, tmp)
        if int(result["segmentationLabelCount"]) > 8:
            raise AssertionError("geometry_graph_surface should cap exported layers at 8")
        if len(result["layerGlbPaths"]) > 8:
            raise AssertionError("geometry_graph_surface should export at most 8 layer GLBs")
        if len(result["layerNames"]) != len(result["layerGlbPaths"]):
            raise AssertionError("Layer names and GLB paths should stay aligned after capping")


if __name__ == "__main__":
    test_cube_segments_into_planar_regions()
    test_cylinder_exports_smooth_curved_layer_glbs()
    test_oversegmented_mesh_exports_at_most_eight_layer_glbs()
    print("PASS: geometry_graph_surface segmentation")
