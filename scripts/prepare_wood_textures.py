"""Compress supplied wood scans without changing their colors or grain."""

import hashlib
import json
from pathlib import Path

from PIL import Image, ImageOps


ROOT = Path(__file__).resolve().parents[1]
TEXTURES = ROOT / "web" / "textures"
SOURCE_PNG = ROOT / "assets" / "source-png"
SOURCES = {
    "maple": "浅枫木_柔细纤维_轻浅波纹.png",
    "ash": "白蜡木_舒展山纹_细长微孔.png",
    "golden-oak": "金橡木_层叠山纹_粗细交织.png",
    "golden-nanmu": "金丝楠木_金丝流光_水波莹润.png",
    "teak": "柚木_纵向直纹_深浅条带.png",
    "cherry": "樱桃木_柔顺流纹_细密木理.png",
    "rosewood": "深玫瑰木_蜿蜒流纹_红褐交织.png",
    "hainan-huali": "海南黄花梨.png",
    "zitan": "小叶紫檀.png",
    "suan-zhi": "大红酸枝.png",
    "wenge": "鸡翅木.png",
    "black-walnut": "黑胡桃木.png",
    "ebony": "黑檀-乌木.png",
    "huali": "花梨木.png",
    "camphor": "香樟木.png",
}
GENERATED = {
    "beech": ("浅榉木.png", "beech-light.webp"),
    "walnut": ("浅胡桃木.png", "walnut-light.webp"),
    "horn-black": ("黑牛角.png", "horn-black.webp"),
    "horn-ivory": ("白牛角.png", "horn-ivory.webp"),
    "jade-white": ("白玉.png", "jade-white.webp"),
    "jade-celadon": ("青玉.png", "jade-celadon.webp"),
    "jade-green": ("碧玉.png", "jade-green.webp"),
}


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    entries = []
    for name, source_name in SOURCES.items():
        source = SOURCE_PNG / source_name
        target = TEXTURES / f"{name}.webp"
        with Image.open(source) as image:
            image = ImageOps.exif_transpose(image).convert("RGB")
            image.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
            image.save(target, "WEBP", quality=88, method=6)
            size = list(image.size)
        entries.append({
            "id": name, "source": source_name, "file": target.name,
            "size": size, "sourceSha256": sha256(source), "sha256": sha256(target),
        })
    origins = [{key: value for key, value in entry.items() if key != "size"} for entry in entries]
    for name, (source_name, asset_name) in GENERATED.items():
        source, asset = SOURCE_PNG / source_name, TEXTURES / asset_name
        if source.exists() and asset.exists():
            origins.append({"id": name, "source": source_name, "file": asset_name,
                            "sourceSha256": sha256(source), "sha256": sha256(asset)})
    manifest = {"sourceDirectory": "assets/source-png", "format": "webp", "maxDimension": 1024,
                "quality": 88, "method": 6, "textures": entries, "allImageOrigins": origins}
    (TEXTURES / "manifest.json").write_bytes((json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))


if __name__ == "__main__":
    main()
