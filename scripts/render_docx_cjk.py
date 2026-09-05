from __future__ import annotations

import importlib.util
from pathlib import Path
import shutil
import sys


RENDERER = Path(
    "/Users/yuyi/.codex/plugins/cache/openai-primary-runtime/documents/"
    "26.723.12215/skills/documents/render_docx.py"
)
CJK_FONT = Path("/Library/Fonts/Arial Unicode.ttf")


def main() -> None:
    spec = importlib.util.spec_from_file_location("codex_render_docx", RENDERER)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load renderer: {RENDERER}")
    renderer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(renderer)

    original_build_env = renderer._build_lo_env

    def build_env(user_profile: str) -> dict[str, str]:
        env = original_build_env(user_profile)
        font_dir = Path(user_profile) / "Library" / "Fonts"
        font_dir.mkdir(parents=True, exist_ok=True)
        if CJK_FONT.exists():
            shutil.copyfile(CJK_FONT, font_dir / CJK_FONT.name)
        return env

    renderer._build_lo_env = build_env
    renderer.main()


if __name__ == "__main__":
    main()
