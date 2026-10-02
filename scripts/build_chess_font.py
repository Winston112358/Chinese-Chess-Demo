"""Build the bundled chess font: pip install fonttools brotli, then run this file.

The application only needs the generated WOFF2; Python is not a runtime dependency.
"""

import argparse
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


SOURCE_URL = "https://raw.githubusercontent.com/google/fonts/main/ofl/zhimangxing/ZhiMangXing-Regular.ttf"
SOURCE_SHA256 = "644e0cae9b40f0b10ab729a01bd32032e3973bac22be3dccae01bf6ae7fde969"
CHARACTERS = "帅仕相马车炮兵将士象砲卒楚河汉界"
OUTPUT = Path(__file__).resolve().parents[1] / "web/fonts/xiangqi-xingkai.woff2"


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


def build(source):
    if sha256(source).hexdigest() != SOURCE_SHA256:
        raise ValueError("Source font changed; review its outlines before rebuilding.")
    font = TTFont(BytesIO(source), recalcTimestamp=False)
    assert font["head"].unitsPerEm == 1000
    glyf = font["glyf"]
    cmap = font.getBestCmap()
    glyph_order = list(font.getGlyphOrder())

    # The original has no 砲. Reuse its brush-written 石 from 码 and 包 from 饱.
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

    # Keep relative character sizes, but fit every outline within the chess disc.
    names = [cmap[ord(character)] for character in CHARACTERS]
    ink_bounds = {name: bounds(font, name) for name in names}
    largest = max(max(b[2] - b[0], b[3] - b[1]) for b in ink_bounds.values())
    scale = min(1, 850 / largest)
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

    for table in ["fpgm", "prep", "cvt ", "DSIG"]:
        if table in font:
            del font[table]
    font["hhea"].ascent, font["hhea"].descent, font["hhea"].lineGap = 800, -200, 0
    os2 = font["OS/2"]
    os2.sTypoAscender, os2.sTypoDescender, os2.sTypoLineGap = 800, -200, 0
    os2.usWinAscent, os2.usWinDescent = 800, 200
    os2.fsSelection |= 1 << 7  # USE_TYPO_METRICS
    for name_id, value in {
        1: "Xiangqi Xingkai", 2: "Regular", 3: "Xiangqi Xingkai 1.0",
        4: "Xiangqi Xingkai Regular", 6: "XiangqiXingkai-Regular",
        16: "Xiangqi Xingkai", 17: "Regular",
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
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    font.save(OUTPUT)
    print(f"Built {OUTPUT} ({OUTPUT.stat().st_size} bytes)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, help="Use a previously downloaded source TTF")
    args = parser.parse_args()
    build(args.source.read_bytes() if args.source else urlopen(SOURCE_URL).read())
