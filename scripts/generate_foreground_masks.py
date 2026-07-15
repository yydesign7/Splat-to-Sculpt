#!/usr/bin/env python3
"""Generate foreground masks for COLMAP feature extraction.

This is a lightweight local path for object-centric videos. It assumes the
background is more stable than the target object across the selected frames.
The masks are intentionally generous: keeping a little background is usually
better for COLMAP than cutting away object edges.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}


def load_rgb(path: Path) -> np.ndarray:
    return np.array(Image.open(path).convert("RGB"), dtype=np.float32)


def normalize_gray(values: np.ndarray) -> np.ndarray:
    lo, hi = np.percentile(values, [2, 98])
    if hi - lo < 1e-6:
        return np.zeros_like(values, dtype=np.float32)
    return np.clip((values - lo) / (hi - lo), 0.0, 1.0)


def largest_component(mask: np.ndarray) -> np.ndarray:
    height, width = mask.shape
    visited = np.zeros_like(mask, dtype=bool)
    best_pixels: list[tuple[int, int]] = []

    for y in range(height):
        for x in range(width):
            if not mask[y, x] or visited[y, x]:
                continue
            stack = [(y, x)]
            visited[y, x] = True
            pixels: list[tuple[int, int]] = []
            while stack:
                cy, cx = stack.pop()
                pixels.append((cy, cx))
                for ny, nx in ((cy - 1, cx), (cy + 1, cx), (cy, cx - 1), (cy, cx + 1)):
                    if 0 <= ny < height and 0 <= nx < width and mask[ny, nx] and not visited[ny, nx]:
                        visited[ny, nx] = True
                        stack.append((ny, nx))
            if len(pixels) > len(best_pixels):
                best_pixels = pixels

    output = np.zeros_like(mask, dtype=bool)
    for y, x in best_pixels:
        output[y, x] = True
    return output


def refine_mask(mask: np.ndarray, min_ratio: float, max_ratio: float) -> np.ndarray:
    ratio = float(mask.mean())
    if ratio < min_ratio:
        return fallback_center_mask(mask.shape)
    if ratio > max_ratio:
        thresholded = largest_component(mask)
        if min_ratio <= float(thresholded.mean()) <= max_ratio:
            mask = thresholded

    image = Image.fromarray((mask.astype(np.uint8) * 255), mode="L")
    # Close tiny holes, then dilate the result so features near the object
    # boundary survive compression and small segmentation errors.
    image = image.filter(ImageFilter.MaxFilter(9))
    image = image.filter(ImageFilter.MinFilter(5))
    image = image.filter(ImageFilter.MaxFilter(15))
    refined = np.array(image, dtype=np.uint8) > 127
    if float(refined.mean()) < min_ratio:
        return fallback_center_mask(mask.shape)
    return refined


def mask_ratios(masks: list[tuple[Path, np.ndarray]]) -> list[float]:
    return [float(mask.mean()) for _, mask in masks]


def ratios_are_valid(ratios: list[float], min_ratio: float, max_ratio: float) -> bool:
    if not ratios:
        return False
    return min(ratios) >= min_ratio and max(ratios) <= max_ratio


def fallback_center_mask(shape: tuple[int, int]) -> np.ndarray:
    height, width = shape
    mask = np.zeros((height, width), dtype=bool)
    y0, y1 = int(height * 0.12), int(height * 0.88)
    x0, x1 = int(width * 0.12), int(width * 0.88)
    mask[y0:y1, x0:x1] = True
    return mask


def filled_component_box(mask: np.ndarray, padding_ratio: float = 0.04) -> np.ndarray:
    component = largest_component(mask)
    ys, xs = np.where(component)
    if len(xs) == 0 or len(ys) == 0:
        return component
    height, width = mask.shape
    pad_x = max(2, int(width * padding_ratio))
    pad_y = max(2, int(height * padding_ratio))
    x0 = max(0, int(xs.min()) - pad_x)
    x1 = min(width, int(xs.max()) + pad_x + 1)
    y0 = max(0, int(ys.min()) - pad_y)
    y1 = min(height, int(ys.max()) + pad_y + 1)
    boxed = np.zeros_like(mask, dtype=bool)
    boxed[y0:y1, x0:x1] = True
    return boxed


def filled_foreground_box(mask: np.ndarray, padding_ratio: float = 0.04) -> np.ndarray:
    ys, xs = np.where(mask)
    if len(xs) == 0 or len(ys) == 0:
        return mask
    height, width = mask.shape
    pad_x = max(2, int(width * padding_ratio))
    pad_y = max(2, int(height * padding_ratio))
    x0 = max(0, int(xs.min()) - pad_x)
    x1 = min(width, int(xs.max()) + pad_x + 1)
    y0 = max(0, int(ys.min()) - pad_y)
    y1 = min(height, int(ys.max()) + pad_y + 1)
    boxed = np.zeros_like(mask, dtype=bool)
    boxed[y0:y1, x0:x1] = True
    return boxed


def compute_masks(image_paths: list[Path], min_ratio: float, max_ratio: float) -> list[tuple[Path, np.ndarray]]:
    frames = [load_rgb(path) for path in image_paths]
    background = np.median(np.stack(frames, axis=0), axis=0)
    raw_masks: list[tuple[Path, np.ndarray]] = []

    for path, frame in zip(image_paths, frames):
        color_diff = np.linalg.norm(frame - background, axis=2)
        gray_frame = frame.mean(axis=2)
        gray_bg = background.mean(axis=2)
        luma_diff = np.abs(gray_frame - gray_bg)
        score = 0.7 * normalize_gray(color_diff) + 0.3 * normalize_gray(luma_diff)

        threshold = max(0.18, float(np.percentile(score, 82)))
        raw_mask = score >= threshold
        raw_masks.append((path, raw_mask))

    temporal_prior = np.zeros_like(raw_masks[0][1], dtype=bool)
    for _, raw_mask in raw_masks:
        temporal_prior |= raw_mask
    temporal_prior = temporal_prior | filled_component_box(temporal_prior) | filled_foreground_box(temporal_prior)

    masks: list[tuple[Path, np.ndarray]] = []
    for path, raw_mask in raw_masks:
        masks.append((path, refine_mask(raw_mask | temporal_prior, min_ratio, max_ratio)))
    return masks


def coerce_rembg_output_to_mask(value: object, source_image: Image.Image) -> np.ndarray:
    if isinstance(value, Image.Image):
        output = value
    elif isinstance(value, bytes):
        from io import BytesIO

        output = Image.open(BytesIO(value))
    else:
        output = Image.fromarray(np.asarray(value))

    if output.mode == "RGBA":
        gray = np.array(output.getchannel("A"), dtype=np.uint8)
    else:
        gray = np.array(output.convert("L"), dtype=np.uint8)

    if gray.shape != (source_image.height, source_image.width):
        gray = np.array(Image.fromarray(gray).resize(source_image.size), dtype=np.uint8)
    return gray > 127


def compute_rembg_masks(image_paths: list[Path], model_name: str, min_ratio: float, max_ratio: float) -> list[tuple[Path, np.ndarray]]:
    os.environ.setdefault("NUMBA_CACHE_DIR", "/private/tmp/studio3dgs-numba-cache")
    try:
        from rembg import new_session, remove
    except Exception as exc:
        raise RuntimeError(f"rembg is not available: {exc}") from exc

    session = new_session(model_name)
    masks: list[tuple[Path, np.ndarray]] = []
    for path in image_paths:
        image = Image.open(path).convert("RGB")
        try:
            raw = remove(image, session=session, only_mask=True)
        except TypeError:
            raw = remove(image, session=session)
        mask = coerce_rembg_output_to_mask(raw, image)
        masks.append((path, refine_mask(mask, min_ratio, max_ratio)))
    return masks


def write_masked_rgb(image_path: Path, mask: np.ndarray, output_path: Path) -> None:
    source = np.array(Image.open(image_path).convert("RGB"), dtype=np.uint8)
    if mask.shape != source.shape[:2]:
        resized = Image.fromarray((mask.astype(np.uint8) * 255), mode="L").resize(
            (source.shape[1], source.shape[0]),
            resample=Image.Resampling.NEAREST,
        )
        mask = np.array(resized, dtype=np.uint8) > 127
    masked = np.where(mask[:, :, None], source, 0).astype(np.uint8)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    save_options = {"quality": 95} if output_path.suffix.lower() in {".jpg", ".jpeg"} else {}
    Image.fromarray(masked, mode="RGB").save(output_path, **save_options)


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate local foreground masks for COLMAP")
    parser.add_argument("--images-dir", required=True, help="Directory containing copied COLMAP input frames")
    parser.add_argument("--masks-dir", required=True, help="Directory where .png masks should be written")
    parser.add_argument(
        "--masked-images-dir",
        default=None,
        help="Optional directory for same-named RGB frames with background pixels set to black",
    )
    parser.add_argument("--method", choices=["auto", "rembg", "heuristic"], default="auto")
    parser.add_argument("--rembg-model", default="u2net", help="rembg model name, e.g. u2net or u2netp")
    parser.add_argument("--min-foreground-ratio", type=float, default=0.02)
    parser.add_argument("--max-foreground-ratio", type=float, default=0.85)
    args = parser.parse_args()

    images_dir = Path(args.images_dir)
    masks_dir = Path(args.masks_dir)
    masked_images_dir = Path(args.masked_images_dir) if args.masked_images_dir else None
    image_paths = sorted(path for path in images_dir.iterdir() if path.suffix.lower() in IMAGE_EXTENSIONS)
    if not image_paths:
        print(json.dumps({"status": "error", "error": "No images found"}))
        return 1

    masks_dir.mkdir(parents=True, exist_ok=True)
    method_used = "heuristic"
    warnings: list[str] = []
    masks: list[tuple[Path, np.ndarray]]

    if args.method in ("auto", "rembg"):
        try:
            masks = compute_rembg_masks(image_paths, args.rembg_model, args.min_foreground_ratio, args.max_foreground_ratio)
            ratios = mask_ratios(masks)
            if args.method == "auto" and not ratios_are_valid(ratios, args.min_foreground_ratio, args.max_foreground_ratio):
                warnings.append("rembg mask ratios were outside quality bounds; using heuristic fallback")
                masks = compute_masks(image_paths, args.min_foreground_ratio, args.max_foreground_ratio)
            else:
                method_used = "rembg"
        except Exception as exc:
            if args.method == "rembg":
                print(json.dumps({"status": "error", "error": str(exc)}))
                return 1
            warnings.append(str(exc))
            masks = compute_masks(image_paths, args.min_foreground_ratio, args.max_foreground_ratio)
    else:
        masks = compute_masks(image_paths, args.min_foreground_ratio, args.max_foreground_ratio)

    ratios = mask_ratios(masks)
    valid = ratios_are_valid(ratios, args.min_foreground_ratio, args.max_foreground_ratio)
    for image_path, mask in masks:
        out_path = masks_dir / f"{image_path.stem}.png"
        Image.fromarray((mask.astype(np.uint8) * 255), mode="L").save(out_path)
        if masked_images_dir is not None:
            write_masked_rgb(image_path, mask, masked_images_dir / image_path.name)

    print(
        json.dumps(
            {
                "status": "ok",
                "method": method_used,
                "valid": valid,
                "count": len(masks),
                "meanForegroundRatio": float(np.mean(ratios)),
                "minForegroundRatio": float(np.min(ratios)),
                "maxForegroundRatio": float(np.max(ratios)),
                "warnings": warnings,
                "maskedImagesGenerated": masked_images_dir is not None,
            }
        ),
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
