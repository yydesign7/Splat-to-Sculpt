#!/usr/bin/env python3
"""Small regression test for local foreground mask generation."""

from __future__ import annotations

import subprocess
import sys
import tempfile
import json
import os
from pathlib import Path

import numpy as np
from PIL import Image


def write_frame(path: Path, x_offset: int) -> None:
    image = np.full((96, 128, 3), 34, dtype=np.uint8)
    image[30:70, 44 + x_offset : 84 + x_offset] = (220, 220, 220)
    Image.fromarray(image).save(path)


def main() -> int:
    script = Path(__file__).with_name("generate_foreground_masks.py")
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        images_dir = root / "images"
        masks_dir = root / "masks"
        masked_images_dir = root / "masked_images"
        images_dir.mkdir()
        for idx, offset in enumerate((-6, -2, 2, 6), start=1):
            write_frame(images_dir / f"frame_{idx:04d}.jpg", offset)

        result = subprocess.run(
            [
                sys.executable,
                str(script),
                "--images-dir",
                str(images_dir),
                "--masks-dir",
                str(masks_dir),
                "--masked-images-dir",
                str(masked_images_dir),
            ],
            text=True,
            capture_output=True,
        )
        if result.returncode != 0:
            print(result.stdout)
            print(result.stderr, file=sys.stderr)
            return result.returncode

        mask_files = sorted(masks_dir.glob("*.png"))
        assert [p.name for p in mask_files] == [f"frame_{idx:04d}.png" for idx in range(1, 5)]

        foreground_ratios = []
        for mask_path in mask_files:
            mask = np.array(Image.open(mask_path).convert("L"))
            foreground_ratios.append(float((mask > 127).mean()))
            assert mask[48, 64] > 127, f"center foreground missing in {mask_path.name}"

        mean_ratio = float(np.mean(foreground_ratios))
        assert 0.08 <= mean_ratio <= 0.45, f"unexpected foreground ratio {mean_ratio:.3f}"

        masked_frame = np.array(Image.open(masked_images_dir / "frame_0001.jpg").convert("RGB"))
        assert np.all(masked_frame[5, 5] == 0), "masked RGB background should be black"
        assert float(masked_frame[48, 64].mean()) > 150, "masked RGB foreground should preserve source pixels"

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        images_dir = root / "images"
        masks_dir = root / "masks"
        fake_module_dir = root / "fake_modules"
        rembg_dir = fake_module_dir / "rembg"
        images_dir.mkdir()
        rembg_dir.mkdir(parents=True)
        write_frame(images_dir / "frame_0001.jpg", 0)
        (rembg_dir / "__init__.py").write_text(
            "\n".join(
                [
                    "from PIL import Image",
                    "def new_session(model_name=None):",
                    "    return {'model_name': model_name}",
                    "def remove(image, session=None, only_mask=False, force_return_bytes=False):",
                    "    size = image.size",
                    "    mask = Image.new('L', size, 0)",
                    "    for y in range(size[1] // 4, size[1] * 3 // 4):",
                    "        for x in range(size[0] // 4, size[0] * 3 // 4):",
                    "            mask.putpixel((x, y), 255)",
                    "    return mask if only_mask else mask.convert('RGBA')",
                    "",
                ]
            ),
            encoding="utf-8",
        )
        env = os.environ.copy()
        env["PYTHONPATH"] = f"{fake_module_dir}{os.pathsep}{env.get('PYTHONPATH', '')}"
        result = subprocess.run(
            [
                sys.executable,
                str(script),
                "--images-dir",
                str(images_dir),
                "--masks-dir",
                str(masks_dir),
                "--method",
                "rembg",
            ],
            text=True,
            capture_output=True,
            env=env,
        )
        if result.returncode != 0:
            print(result.stdout)
            print(result.stderr, file=sys.stderr)
            return result.returncode
        payload = json.loads(result.stdout)
        assert payload["method"] == "rembg"
        mask = np.array(Image.open(masks_dir / "frame_0001.png").convert("L"))
        assert mask[48, 64] > 127
        assert mask[5, 5] == 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
