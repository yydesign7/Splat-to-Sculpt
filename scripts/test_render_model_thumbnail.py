#!/usr/bin/env python3
"""Tests for the model asset thumbnail renderer."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image

from render_model_thumbnail import render_thumbnail


BACKGROUND_RGB = np.asarray([18, 18, 22], dtype=np.int16)


def high_contrast_ratio(image_path: Path) -> float:
    pixels = np.asarray(Image.open(image_path).convert("RGB"), dtype=np.int16)
    contrast = np.abs(pixels - BACKGROUND_RGB).mean(axis=2)
    return float((contrast > 28).mean())


class RenderModelThumbnailTests(unittest.TestCase):
    def test_dark_models_still_render_as_visible_asset_thumbnails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            model_path = tmp_dir / "dark_box.glb"
            output_path = tmp_dir / "thumbnail.png"

            mesh = trimesh.creation.box(extents=(1.0, 1.0, 1.0))
            mesh.visual.face_colors = np.tile(
                np.asarray([[0, 0, 0, 255]], dtype=np.uint8),
                (len(mesh.faces), 1),
            )
            mesh.export(model_path)

            render_thumbnail(model_path, output_path, 144, 96)

            self.assertGreater(
                high_contrast_ratio(output_path),
                0.04,
                "thumbnail should show the model clearly even when the source material is dark",
            )


if __name__ == "__main__":
    unittest.main()
