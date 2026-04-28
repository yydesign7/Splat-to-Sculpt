#!/usr/bin/env python3
"""
Depth estimation using Depth Anything V2.
Estimates monocular depth maps for a set of frame images.

Usage:
    python3 depth_estimate.py --images_dir /path/to/images --output_dir /path/to/output [--model_size small]

Outputs:
    - <output_dir>/depth_<frame_id>.npy  (raw depth numpy arrays)
    - <output_dir>/depth_<frame_id>.png   (normalized depth visualization)
"""

import argparse
import os
import sys
import json
import numpy as np
from pathlib import Path

try:
    import cv2
    from PIL import Image
except ImportError as e:
    print(f"Missing dependency: {e}", file=sys.stderr)
    sys.exit(1)

# Depth Anything V2 imports (deferred to allow install during first run)
_DEPTH_MODEL = None
_DEPTH_TRANSFORM = None


def load_model(model_size: str = "small"):
    """Load Depth Anything V2 model."""
    global _DEPTH_MODEL, _DEPTH_TRANSFORM

    if _DEPTH_MODEL is not None:
        return _DEPTH_MODEL, _DEPTH_TRANSFORM

    try:
        # Try using the depth_anything_v2 package first
        from depth_anything_v2.dpt import DepthAnythingV2
    except ImportError:
        # Fall back to transformers-based loading
        try:
            from transformers import pipeline
            model_names = {
                "small": "depth-anything/Depth-Anything-V2-Small-hf",
                "base": "depth-anything/Depth-Anything-V2-Base-hf",
                "large": "depth-anything/Depth-Anything-V2-Large-hf",
            }
            model_name = model_names.get(model_size, model_names["small"])
            print(f"Loading Depth Anything V2 ({model_name}) via transformers...", flush=True)
            _DEPTH_MODEL = pipeline("depth-estimation", model=model_name, device="cpu")
            _DEPTH_TRANSFORM = "pipeline"
            return _DEPTH_MODEL, _DEPTH_TRANSFORM
        except ImportError:
            print("Neither depth_anything_v2 nor transformers is installed.", file=sys.stderr)
            sys.exit(1)

    # Use DepthAnythingV2 directly
    model_configs = {
        "small": {"encoder": "vits", "features": 64, "out_channels": [48, 96, 192, 384]},
        "base": {"encoder": "vitb", "features": 128, "out_channels": [96, 192, 384, 768]},
        "large": {"encoder": "vitl", "features": 256, "out_channels": [256, 512, 1024, 2048]},
    }

    config = model_configs.get(model_size, model_configs["small"])
    model = DepthAnythingV2(**config)

    # Try to load pretrained weights
    checkpoint_dir = os.path.expanduser("~/.cache/depth_anything_v2")
    os.makedirs(checkpoint_dir, exist_ok=True)
    checkpoint_path = os.path.join(checkpoint_dir, f"depth_anything_v2_{config['encoder']}.pth")

    if not os.path.exists(checkpoint_path):
        print(f"Downloading Depth Anything V2 ({config['encoder']}) weights...", flush=True)
        urls = {
            "vits": "https://huggingface.co/depth-anything/Depth-Anything-V2-Small/resolve/main/depth_anything_v2_vits.pth",
            "vitb": "https://huggingface.co/depth-anything/Depth-Anything-V2-Base/resolve/main/depth_anything_v2_vitb.pth",
            "vitl": "https://huggingface.co/depth-anything/Depth-Anything-V2-Large/resolve/main/depth_anything_v2_vitl.pth",
        }
        import urllib.request
        urllib.request.urlretrieve(urls[config["encoder"]], checkpoint_path)

    model.load_state_dict(torch.load(checkpoint_path, map_location="cpu"))
    model.eval()
    _DEPTH_MODEL = model
    _DEPTH_TRANSFORM = "direct"
    return _DEPTH_MODEL, _DEPTH_TRANSFORM


def estimate_depth_pipeline(model, image_path: str) -> np.ndarray:
    """Estimate depth using the transformers pipeline API."""
    image = Image.open(image_path).convert("RGB")
    result = model(image)
    depth = np.array(result["predicted_depth"])
    # Pipeline returns depth in meters (absolute) for V2; normalize to relative
    return depth


def estimate_depth_direct(model, transform, image_path: str) -> np.ndarray:
    """Estimate depth using the DepthAnythingV2 direct API."""
    import torch

    image = cv2.imread(image_path)
    if image is None:
        raise ValueError(f"Failed to read image: {image_path}")
    image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)

    # DepthAnythingV2 expects 518x518 input
    h, w = image.shape[:2]
    image_tensor = torch.from_numpy(image).permute(2, 0, 1).unsqueeze(0).float()
    image_tensor = torch.nn.functional.interpolate(
        image_tensor, size=(518, 518), mode="bilinear", align_corners=False
    )
    image_tensor = (image_tensor - torch.tensor([123.675, 116.28, 103.53]).view(1, 3, 1, 1)) / \
                   torch.tensor([58.395, 57.12, 57.375]).view(1, 3, 1, 1)

    with torch.no_grad():
        depth = model(image_tensor)

    # Resize back to original resolution
    depth = torch.nn.functional.interpolate(
        depth.unsqueeze(1), size=(h, w), mode="bilinear", align_corners=False
    ).squeeze().numpy()

    return depth


def save_depth_visualization(depth: np.ndarray, output_path: str):
    """Save a normalized depth map as a color image for visualization."""
    # Normalize to 0-255
    d_min, d_max = depth.min(), depth.max()
    if d_max - d_min > 1e-6:
        normalized = (depth - d_min) / (d_max - d_min) * 255
    else:
        normalized = np.zeros_like(depth)
    normalized = normalized.astype(np.uint8)
    # Apply a colormap for better visualization
    colored = cv2.applyColorMap(normalized, cv2.COLORMAP_INFERNO)
    cv2.imwrite(output_path, colored)


def main():
    parser = argparse.ArgumentParser(description="Depth estimation with Depth Anything V2")
    parser.add_argument("--images_dir", required=True, help="Directory containing input frame images")
    parser.add_argument("--output_dir", required=True, help="Directory to save depth maps")
    parser.add_argument("--model_size", default="small", choices=["small", "base", "large"],
                        help="Model size (small=24M, base=97M, large=335M params)")
    args = parser.parse_args()

    images_dir = Path(args.images_dir)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Find all image files
    image_extensions = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
    image_files = sorted([
        f for f in images_dir.iterdir()
        if f.suffix.lower() in image_extensions
    ])

    if not image_files:
        print(json.dumps({"error": "No images found in the input directory"}))
        sys.exit(1)

    print(json.dumps({"status": "loading_model", "num_images": len(image_files)}), flush=True)

    model, transform_type = load_model(args.model_size)

    print(json.dumps({"status": "estimating", "num_images": len(image_files)}), flush=True)

    results = []
    for i, img_path in enumerate(image_files):
        frame_id = img_path.stem

        try:
            if transform_type == "pipeline":
                depth = estimate_depth_pipeline(model, str(img_path))
            else:
                depth = estimate_depth_direct(model, transform_type, str(img_path))

            # Save raw depth as numpy array
            npy_path = output_dir / f"depth_{frame_id}.npy"
            np.save(str(npy_path), depth)

            # Save visualization
            png_path = output_dir / f"depth_{frame_id}.png"
            save_depth_visualization(depth, str(png_path))

            results.append({
                "frame": frame_id,
                "depth_npy": str(npy_path),
                "depth_png": str(png_path),
                "depth_min": float(depth.min()),
                "depth_max": float(depth.max()),
            })

            # Progress output
            if (i + 1) % 5 == 0 or i == len(image_files) - 1:
                print(json.dumps({
                    "status": "progress",
                    "completed": i + 1,
                    "total": len(image_files),
                }), flush=True)

        except Exception as e:
            print(json.dumps({
                "status": "error",
                "frame": frame_id,
                "error": str(e),
            }), flush=True)

    print(json.dumps({
        "status": "done",
        "num_depth_maps": len(results),
        "output_dir": str(output_dir),
    }), flush=True)


if __name__ == "__main__":
    main()
