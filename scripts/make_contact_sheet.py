from pathlib import Path
import sys

from PIL import Image, ImageDraw, ImageFont


def main() -> None:
    output = Path(sys.argv[1])
    if sys.argv[2].isdigit():
        thumb_width = int(sys.argv[2])
        inputs = [Path(value) for value in sys.argv[3:]]
    else:
        thumb_width = 420
        inputs = [Path(value) for value in sys.argv[2:]]
    label_height = 34
    gap = 16
    columns = 3
    prepared: list[tuple[Path, Image.Image]] = []
    for path in inputs:
        image = Image.open(path).convert("RGB")
        ratio = thumb_width / image.width
        prepared.append((path, image.resize((thumb_width, round(image.height * ratio)))))
    row_heights: list[int] = []
    for start in range(0, len(prepared), columns):
        row = prepared[start : start + columns]
        row_heights.append(max(image.height for _, image in row) + label_height)
    width = gap + columns * (thumb_width + gap)
    height = gap + sum(row_heights) + len(row_heights) * gap
    sheet = Image.new("RGB", (width, height), "#e8e8e8")
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.load_default()
    y = gap
    for row_index, start in enumerate(range(0, len(prepared), columns)):
        for column, (path, image) in enumerate(prepared[start : start + columns]):
            x = gap + column * (thumb_width + gap)
            sheet.paste(image, (x, y + label_height))
            draw.text((x, y + 9), path.name, fill="black", font=font)
        y += row_heights[row_index] + gap
    output.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(output)


if __name__ == "__main__":
    main()
