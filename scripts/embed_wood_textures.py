"""Embed the bundled wood images in CSS, so LAN clients need no extra routes."""

import base64
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CSS = ROOT / "web" / "appearance.css"


def main():
    stylesheet = CSS.read_text(encoding="utf-8")
    for skin in ("beech", "walnut"):
        asset = ROOT / "web" / "textures" / f"{skin}-light.webp"
        encoded = base64.b64encode(asset.read_bytes()).decode("ascii")
        pattern = (
            rf'(#board\[data-skin="{skin}"\],\s*'
            rf'\.skin-swatch\[data-skin="{skin}"\]\s*\{{[^}}]*?'
            rf'--board-texture:[ \t]*)[^\r\n]+'
        )
        stylesheet, count = re.subn(
            pattern,
            lambda match: f'{match[1]}url("data:image/webp;base64,{encoded}");',
            stylesheet,
        )
        if count != 1:
            raise ValueError(f"Expected one {skin} skin, found {count}")
    CSS.write_bytes(stylesheet.encode("utf-8"))


if __name__ == "__main__":
    main()
