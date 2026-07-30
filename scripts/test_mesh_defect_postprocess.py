#!/usr/bin/env python3
from __future__ import annotations

from dataclasses import replace
from pathlib import Path
import sys

import numpy as np
import open3d as o3d

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from gs_to_mesh import (  # noqa: E402
    count_boundary_edges,
    get_reconstruction_profile,
    postprocess_mesh_defects,
)


def _sheet_mesh(width: float, height: float, z: float, nx: int, ny: int, x0: float = 0.0) -> o3d.geometry.TriangleMesh:
    vertices = []
    for iy in range(ny + 1):
        for ix in range(nx + 1):
            x = x0 + width * (ix / nx - 0.5)
            y = height * (iy / ny - 0.5)
            vertices.append([x, y, z])
    faces = []
    row = nx + 1
    for iy in range(ny):
        for ix in range(nx):
            a = iy * row + ix
            b = a + 1
            c = a + row
            d = c + 1
            faces.append([a, b, d])
            faces.append([a, d, c])
    mesh = o3d.geometry.TriangleMesh()
    mesh.vertices = o3d.utility.Vector3dVector(np.asarray(vertices, dtype=np.float64))
    mesh.triangles = o3d.utility.Vector3iVector(np.asarray(faces, dtype=np.int32))
    mesh.compute_vertex_normals()
    return mesh


def _point_cloud_from_vertices(mesh: o3d.geometry.TriangleMesh) -> o3d.geometry.PointCloud:
    pcd = o3d.geometry.PointCloud()
    pcd.points = o3d.utility.Vector3dVector(np.asarray(mesh.vertices, dtype=np.float64))
    return pcd


def _mesh_with_one_small_hole() -> o3d.geometry.TriangleMesh:
    nx = 6
    ny = 6
    vertices = []
    for iy in range(ny + 1):
        for ix in range(nx + 1):
            vertices.append([ix / nx - 0.5, iy / ny - 0.5, 0.0])
    faces = []
    row = nx + 1
    for iy in range(ny):
        for ix in range(nx):
            if ix == 2 and iy == 2:
                continue
            a = iy * row + ix
            b = a + 1
            c = a + row
            d = c + 1
            faces.append([a, b, d])
            faces.append([a, d, c])
    mesh = o3d.geometry.TriangleMesh()
    mesh.vertices = o3d.utility.Vector3dVector(np.asarray(vertices, dtype=np.float64))
    mesh.triangles = o3d.utility.Vector3iVector(np.asarray(faces, dtype=np.int32))
    mesh.compute_vertex_normals()
    return mesh


def test_postprocess_removes_unsupported_flying_sheet_but_keeps_supported_seat() -> None:
    seat = _sheet_mesh(width=2.0, height=2.0, z=0.0, nx=16, ny=16)
    flying_sheet = _sheet_mesh(width=0.8, height=0.8, z=0.65, nx=10, ny=10, x0=0.2)
    mesh = seat + flying_sheet
    source_pcd = _point_cloud_from_vertices(seat)
    profile = replace(
        get_reconstruction_profile("default_general"),
        flying_sheet_max_area_ratio=0.20,
        postprocess_max_area_loss_ratio=0.20,
    )

    processed, stats = postprocess_mesh_defects(mesh, source_pcd, voxel_size=0.02, scale=1.0, profile=profile)

    processed_triangles = int(len(processed.triangles))
    seat_triangles = int(len(seat.triangles))
    flying_triangles = int(len(flying_sheet.triangles))
    if stats["removed_flying_sheet_faces"] < flying_triangles:
        raise AssertionError("Unsupported flying sheet should be removed")
    if processed_triangles < seat_triangles:
        raise AssertionError("Supported broad seat surface should not be deleted")


def test_postprocess_fills_small_hole_without_filling_large_open_boundary() -> None:
    mesh = _mesh_with_one_small_hole()
    source_pcd = _point_cloud_from_vertices(mesh)
    profile = replace(
        get_reconstruction_profile("flat_panel"),
        small_hole_max_area_ratio=0.10,
        small_hole_max_boundary_edges=12,
    )
    boundary_before = count_boundary_edges(mesh)

    processed, stats = postprocess_mesh_defects(mesh, source_pcd, voxel_size=0.02, scale=1.0, profile=profile)

    boundary_after = count_boundary_edges(processed)
    if stats["filled_hole_count"] < 1:
        raise AssertionError("Small interior hole should be filled")
    if boundary_after >= boundary_before:
        raise AssertionError("Small hole filling should reduce boundary edges")
    if boundary_after == 0:
        raise AssertionError("Large outer boundary should remain open")


if __name__ == "__main__":
    test_postprocess_removes_unsupported_flying_sheet_but_keeps_supported_seat()
    test_postprocess_fills_small_hole_without_filling_large_open_boundary()
    print("PASS: mesh defect postprocess")
