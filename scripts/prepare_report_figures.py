from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path("report_assets")
THREAD = ROOT / "thread_images"
OUTPUT = ROOT / "final_figures"


def font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for path in (
        Path("/System/Library/Fonts/Supplemental/Arial Bold.ttf"),
        Path("/System/Library/Fonts/Supplemental/Arial.ttf"),
    ):
        if path.exists():
            return ImageFont.truetype(str(path), size)
    return ImageFont.load_default()


def open_rgb(path: Path) -> Image.Image:
    return Image.open(path).convert("RGB")


def fit_height(image: Image.Image, height: int) -> Image.Image:
    width = round(image.width * height / image.height)
    return image.resize((width, height), Image.Resampling.LANCZOS)


def labelled_pair(
    left: Image.Image,
    right: Image.Image,
    left_label: str,
    right_label: str,
    panel_height: int,
) -> Image.Image:
    label_height = 62
    gap = 20
    left = fit_height(left, panel_height)
    right = fit_height(right, panel_height)
    canvas = Image.new(
        "RGB",
        (left.width + right.width + gap, panel_height + label_height),
        "#111216",
    )
    canvas.paste(left, (0, label_height))
    canvas.paste(right, (left.width + gap, label_height))
    draw = ImageDraw.Draw(canvas)
    label_font = font(28)
    draw.text((18, 16), left_label, fill="#f4f4f5", font=label_font)
    draw.text(
        (left.width + gap + 18, 16), right_label, fill="#f4f4f5", font=label_font
    )
    return canvas


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)

    current_detail = open_rgb(THREAD / "session-1cc9783b18d9.png")
    current_workflow = open_rgb(THREAD / "session-0cb26f8ee2a1.jpg")
    assets_view = open_rgb(THREAD / "session-0e7f887f913b.jpg")
    early_workflow = open_rgb(THREAD / "session-df0929760832.jpg")
    node_cards = open_rgb(THREAD / "session-2891143f287a.png")
    ui_kit = open_rgb(THREAD / "session-856182d4a456.png")

    current_detail.crop((0, 0, 1280, 1120)).save(OUTPUT / "fig_1_1_editor.png")
    current_workflow.save(OUTPUT / "fig_4_1_workflow.png")

    nodes_panel = current_detail.crop((0, 105, 420, 1145))
    assets_panel = assets_view.crop((0, 105, 530, 1455))
    labelled_pair(
        nodes_panel,
        assets_panel,
        "Nodes library",
        "Assets library",
        920,
    ).save(OUTPUT / "fig_5_1_sidebar_assets.png")

    node_cards.save(OUTPUT / "fig_6_1_node_cards.png")
    ui_kit.save(OUTPUT / "fig_6_2_ui_kit.png")

    current_detail.crop((430, 80, 1070, 1138)).save(
        OUTPUT / "fig_7_1_gaussian_controls.png"
    )

    labelled_pair(
        early_workflow,
        current_workflow,
        "Earlier interface",
        "Current interface",
        820,
    ).save(OUTPUT / "fig_8_1_before_after.png")


if __name__ == "__main__":
    main()
