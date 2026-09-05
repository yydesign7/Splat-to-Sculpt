from pathlib import Path
import sys

from PIL import Image, ImageStat


def main() -> None:
    root = Path(sys.argv[1])
    candidates: list[tuple[float, Path, int, int]] = []
    for path in root.rglob("*.png"):
        try:
            with Image.open(path) as source:
                width, height = source.size
                if width < 700 or height < 500 or width / height < 1.05:
                    continue
                image = source.convert("RGB")
                image.thumbnail((160, 160))
                grayscale = image.convert("L")
                mean = ImageStat.Stat(grayscale).mean[0]
                dark_ratio = sum(1 for value in grayscale.getdata() if value < 70) / (
                    grayscale.width * grayscale.height
                )
                threshold = float(sys.argv[2]) if len(sys.argv) > 2 else 0.45
                if dark_ratio >= threshold:
                    score = dark_ratio - mean / 1000
                    candidates.append((score, path, width, height))
        except OSError:
            continue
    for score, path, width, height in sorted(candidates, reverse=True)[:160]:
        print(f"{score:.3f}\t{width}x{height}\t{path}")


if __name__ == "__main__":
    main()
