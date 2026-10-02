"""Build the bundled chess fonts: pip install fonttools==4.62.1 brotli==1.0.9.

The application only needs the generated WOFF2; Python is not a runtime dependency.
"""

import argparse
import json
from math import hypot
from array import array
from copy import deepcopy
from hashlib import sha256
from io import BytesIO
from pathlib import Path
from urllib.request import urlopen

from fontTools import subset
from fontTools.pens.boundsPen import BoundsPen
from fontTools.ttLib import TTFont
from fontTools.ttLib.tables._g_l_y_f import Glyph, GlyphCoordinates
from fontTools.ttLib.tables.ttProgram import Program


CHARACTERS = "帅仕相马车炮兵将士象砲卒楚河汉界"
FONT_DIR = Path(__file__).resolve().parents[1] / "web/fonts"
GOOGLE_REVISION = "9710da1eacb3be272583c3224dcb70f9da6eadbb"
SPECS = {
    "xingkai": {
        "family": "Xiangqi Xingkai",
        "source_name": "Zhi Mang Xing",
        "source_url": f"https://raw.githubusercontent.com/google/fonts/{GOOGLE_REVISION}/ofl/zhimangxing/ZhiMangXing-Regular.ttf",
        "source_sha256": "644e0cae9b40f0b10ab729a01bd32032e3973bac22be3dccae01bf6ae7fde969",
        "license": "OFL.txt",
        "fallback_characters": "",
    },
    "running": {
        "family": "Xiangqi Running",
        "source_name": "Long Cang",
        "source_url": f"https://raw.githubusercontent.com/google/fonts/{GOOGLE_REVISION}/ofl/longcang/LongCang-Regular.ttf",
        "source_sha256": "e5bf2c3f24ef2327c6f136d8f73e2f9dfdf44896fdbeb35a9515f44777bb91bc",
        "license": "OFL-longcang.txt",
        # Do not invent the missing glyph: the bundled Kai family supplies it.
        "fallback_characters": "砲",
    },
    "kai": {
        "family": "Xiangqi Kai",
        "source_name": "LXGW WenKai Regular v1.522",
        "source_url": "https://github.com/lxgw/LxgwWenKai/releases/download/v1.522/LXGWWenKai-Regular.ttf",
        "source_sha256": "39ad71264b588165b469e35e6afb162a378dacd1f95348160240ba9038ac3009",
        "license": "OFL-wenkai.txt",
        "fallback_characters": "",
    },
}


def empty_glyph():
    glyph = Glyph()
    glyph.numberOfContours = 0
    glyph.coordinates = GlyphCoordinates()
    glyph.endPtsOfContours = []
    glyph.flags = array("B")
    glyph.program = Program()
    glyph.program.fromBytecode([])
    return glyph


def add_contours(target, source, glyf, indices, scale_x=1, offset_x=0):
    coordinates, endpoints, flags = source.getCoordinates(glyf)
    for index in indices:
        start = endpoints[index - 1] + 1 if index else 0
        end = endpoints[index] + 1
        target.coordinates.extend(
            (round(x * scale_x + offset_x), y) for x, y in coordinates[start:end]
        )
        target.flags.extend(flags[start:end])
        target.endPtsOfContours.append(len(target.coordinates) - 1)
        target.numberOfContours += 1


def bounds(font, name):
    glyphs = font.getGlyphSet()
    pen = BoundsPen(glyphs)
    glyphs[name].draw(pen)
    return pen.bounds


def build(source, key="xingkai"):
    spec = SPECS[key]
    if sha256(source).hexdigest() != spec["source_sha256"]:
        raise ValueError("Source font changed; review its outlines before rebuilding.")
    font = TTFont(BytesIO(source), recalcTimestamp=False)
    assert font["head"].unitsPerEm == 1000
    glyf = font["glyf"]
    cmap = font.getBestCmap()
    glyph_order = list(font.getGlyphOrder())

    if key == "xingkai":
        # Preserve the earlier derivative's brush-written 砲. Its 石 comes from
        # 码 and 包 from 饱; both components belong to the same OFL font.
        cannon = empty_glyph()
        add_contours(cannon, glyf[cmap[ord("码")]], glyf, [2, 3], .78, 8)
        add_contours(cannon, glyf[cmap[ord("饱")]], glyf, [0, 1])
        cannon.recalcBounds(glyf)
        glyf["stoneCannon"] = cannon
        font.setGlyphOrder(glyph_order + ["stoneCannon"])
        font["hmtx"]["stoneCannon"] = (1000, cannon.xMin)
        for table in font["cmap"].tables:
            if table.isUnicode():
                table.cmap[ord("砲")] = "stoneCannon"
    cmap = font.getBestCmap()
    missing = "".join(c for c in CHARACTERS if ord(c) not in cmap)
    if missing != spec["fallback_characters"]:
        raise ValueError(f"Unexpected coverage in {spec['source_name']}: {missing!r}")

    # Use a single scale per family so relative glyph sizes remain consistent.
    # A square bbox alone cannot keep diagonal strokes inside a round chess disc.
    names = list(dict.fromkeys(cmap[ord(c)] for c in CHARACTERS if ord(c) in cmap))
    ink_bounds = {name: bounds(font, name) for name in names}
    if any(b is None for b in ink_bounds.values()):
        raise ValueError("A mapped chess character has no visible outline.")
    largest = max(max(b[2] - b[0], b[3] - b[1]) for b in ink_bounds.values())
    largest_control_radius = 0
    for name in names:
        x_min, y_min, x_max, y_max = ink_bounds[name]
        center_x, center_y = (x_min + x_max) / 2, (y_min + y_max) / 2
        coordinates, _, _ = glyf[name].getCoordinates(glyf)
        largest_control_radius = max(largest_control_radius, max(
            hypot(x - center_x, y - center_y) for x, y in coordinates
        ))
    # Every Bezier point is a convex combination of its on/off-curve points.
    # Thus their disk bounds the entire real contour, without another dependency.
    # Rounding both coordinates adds at most sqrt(.5**2 + .5**2) < .71 units.
    scale = min(1, 850 / largest, 474 / largest_control_radius)
    for name in names:
        glyph = empty_glyph()
        source_glyph = deepcopy(glyf[name])
        coordinates, endpoints, flags = source_glyph.getCoordinates(glyf)
        x_min, y_min, x_max, y_max = ink_bounds[name]
        # With ascent 800 / descent -200, ink center y=300 is the line-box center.
        glyph.coordinates = GlyphCoordinates([
            (round((x - (x_min + x_max) / 2) * scale + 500),
             round((y - (y_min + y_max) / 2) * scale + 300))
            for x, y in coordinates
        ])
        glyph.endPtsOfContours = list(endpoints)
        glyph.flags = array("B", flags)
        glyph.numberOfContours = len(endpoints)
        glyph.recalcBounds(glyf)
        glyf[name] = glyph
        font["hmtx"][name] = (1000, glyph.xMin)
    font["hmtx"][cmap[ord(" ")]] = (1000, 0)

    for table in ["fpgm", "prep", "cvt ", "DSIG"]:
        if table in font:
            del font[table]
    font["hhea"].ascent, font["hhea"].descent, font["hhea"].lineGap = 800, -200, 0
    os2 = font["OS/2"]
    os2.sTypoAscender, os2.sTypoDescender, os2.sTypoLineGap = 800, -200, 0
    os2.usWinAscent, os2.usWinDescent = 800, 200
    os2.fsSelection |= 1 << 7  # USE_TYPO_METRICS
    family = spec["family"]
    for name_id, value in {
        1: family, 2: "Regular", 3: f"{family} 1.0",
        4: f"{family} Regular", 6: family.replace(" ", "") + "-Regular",
        16: family, 17: "Regular",
    }.items():
        font["name"].removeNames(nameID=name_id)
        font["name"].setName(value, name_id, 3, 1, 0x409)
    options = subset.Options()
    options.hinting = False
    options.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14, 16, 17]
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(text=CHARACTERS + " ")
    subsetter.subset(font)
    font["head"].created = font["head"].modified = 2082844800
    font.flavor = "woff2"
    output = FONT_DIR / f"xiangqi-{key}.woff2"
    output.parent.mkdir(parents=True, exist_ok=True)
    font.save(output)
    print(f"Built {output.name} ({output.stat().st_size} bytes)")


def font_record(key):
    spec = SPECS[key]
    output = FONT_DIR / f"xiangqi-{key}.woff2"
    font = TTFont(output, recalcTimestamp=False)
    cmap = font.getBestCmap()
    return {
        **spec,
        "file": output.name,
        "characters": "".join(c for c in CHARACTERS + " " if ord(c) in cmap),
        "sha256": sha256(output.read_bytes()).hexdigest(),
        "license_sha256": sha256((FONT_DIR / spec["license"]).read_bytes()).hexdigest(),
    }


def write_manifest():
    manifest = {
        "required_characters": CHARACTERS + " ",
        "outline_limits": {
            "center": [500, 300], "max_axis_units": 850,
            "pre_round_control_radius_units": 474, "final_control_radius_units": 475,
        },
        "builder_dependencies": {"fonttools": "4.62.1", "brotli": "1.0.9"},
        "fonts": [font_record(key) for key in SPECS],
    }
    (FONT_DIR / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def verify():
    manifest = json.loads((FONT_DIR / "manifest.json").read_text(encoding="utf-8"))
    records = {item["file"]: item for item in manifest["fonts"]}
    for key, spec in SPECS.items():
        record = font_record(key)
        if record != records[record["file"]]:
            raise ValueError(f"Font or license changed: {record['file']}")
        font = TTFont(FONT_DIR / record["file"], recalcTimestamp=False)
        cmap = font.getBestCmap()
        expected = set(CHARACTERS + " ") - set(spec["fallback_characters"])
        if set(map(chr, cmap)) != expected:
            raise ValueError(f"Unexpected cmap: {record['file']}")
        assert font["head"].unitsPerEm == 1000
        assert (font["hhea"].ascent, font["hhea"].descent, font["hhea"].lineGap) == (800, -200, 0)
        for character in expected:
            name = cmap[ord(character)]
            assert font["hmtx"][name][0] == 1000, character
            ink = bounds(font, name)
            if character == " ":
                assert ink is None
                continue
            assert ink is not None, character
            x_min, y_min, x_max, y_max = ink
            assert x_max > x_min and y_max > y_min, character
            assert 0 <= x_min < x_max <= 1000, character
            assert -200 <= y_min < y_max <= 800, character
            assert abs((x_min + x_max) / 2 - 500) <= .5, character
            assert abs((y_min + y_max) / 2 - 300) <= .5, character
            coordinates, _, _ = font["glyf"][name].getCoordinates(font["glyf"])
            assert max(hypot(x - 500, y - 300) for x, y in coordinates) <= 475, character
        print(f"Verified {record['file']}: {record['characters']} ({record['sha256']})")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--font", choices=SPECS, help="Build only one font")
    parser.add_argument("--source", type=Path, help="Use a previously downloaded source TTF")
    parser.add_argument("--source-dir", type=Path, help="Directory of {font}.source.ttf files")
    parser.add_argument("--verify", action="store_true", help="Check shipped hashes, coverage, metrics and outlines offline")
    args = parser.parse_args()
    if args.verify:
        verify()
    else:
        if args.source and not args.font:
            # Retain the original --source behavior for the existing derivative.
            args.font = "xingkai"
        for key in [args.font] if args.font else SPECS:
            source_path = args.source or (args.source_dir / f"{key}.source.ttf" if args.source_dir else None)
            source = source_path.read_bytes() if source_path else urlopen(SPECS[key]["source_url"], timeout=120).read()
            build(source, key)
        if all((FONT_DIR / f"xiangqi-{key}.woff2").exists() for key in SPECS):
            write_manifest()
            verify()
