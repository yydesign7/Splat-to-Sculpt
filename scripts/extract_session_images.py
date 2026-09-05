import base64
import hashlib
import json
from pathlib import Path
import sys

from PIL import Image


def walk(value: object):
    if isinstance(value, dict):
        for item in value.values():
            yield from walk(item)
    elif isinstance(value, list):
        for item in value:
            yield from walk(item)
    elif isinstance(value, str) and value.startswith("data:image/"):
        yield value


def text_snippets(value: object):
    if isinstance(value, dict):
        for key, item in value.items():
            if key in {"text", "title"} and isinstance(item, str) and not item.startswith("data:image/"):
                yield " ".join(item.split())
            else:
                yield from text_snippets(item)
    elif isinstance(value, list):
        for item in value:
            yield from text_snippets(item)


def main() -> None:
    root = Path(sys.argv[1])
    phrase = sys.argv[2]
    output = Path(sys.argv[3])
    output.mkdir(parents=True, exist_ok=True)
    seen: set[str] = set()
    for path in root.rglob("*.jsonl"):
        try:
            lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
        except OSError:
            continue
        for line in lines:
            if phrase not in line:
                continue
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
            for data_url in walk(payload):
                header, encoded = data_url.split(",", 1)
                digest = hashlib.sha256(encoded.encode("ascii")).hexdigest()[:12]
                if digest in seen:
                    continue
                seen.add(digest)
                extension = "jpg" if "jpeg" in header else "png"
                destination = output / f"session-{digest}.{extension}"
                destination.write_bytes(base64.b64decode(encoded))
                with Image.open(destination) as image:
                    snippets = " | ".join(text_snippets(payload))[:500]
                    print(
                        f"{destination}\t{image.width}x{image.height}\t{snippets}"
                    )


if __name__ == "__main__":
    main()
