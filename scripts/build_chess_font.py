"""Build the bundled chess fonts: pip install fonttools==4.62.1 brotli==1.0.9.

The application uses the bundled font outputs and SVG metrics; Python is not a runtime dependency.
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
from zipfile import ZipFile

from fontTools import subset
from fontTools.pens.boundsPen import BoundsPen
from fontTools.ttLib import TTFont
from fontTools.ttLib.tables._g_l_y_f import Glyph, GlyphCoordinates
from fontTools.ttLib.tables.ttProgram import Program


CHARACTERS = "帅仕相马车炮兵将士象砲卒楚河汉界"
TRADITIONAL_CHARACTERS = "帥仕相傌馬俥車炮兵將士象砲卒楚河漢界"
KAI_LEGACY_CHARACTERS = CHARACTERS + "帥馬俥車將漢"
KAI_CHARACTERS = KAI_LEGACY_CHARACTERS + "傌"
# Fingerprint of each v0.5.5 Kai glyph's raw glyf bytes and hmtx pair, in this
# fixed character order. Adding 傌 must not resize or rewrite any earlier glyph.
KAI_LEGACY_GLYPHS_SHA256 = "e9a041b097397d86d2f88ca06d0965129fb7ebacd546a4357df879597fed8ee6"
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
        "required_characters": KAI_CHARACTERS,
        "preserved_characters": KAI_LEGACY_CHARACTERS,
        "preserved_glyphs_sha256": KAI_LEGACY_GLYPHS_SHA256,
    },
    "regular": {
        "family": "Xiangqi Regular",
        "source_name": "Ma Shan Zheng",
        "source_url": f"https://raw.githubusercontent.com/google/fonts/{GOOGLE_REVISION}/ofl/mashanzheng/MaShanZheng-Regular.ttf",
        "source_sha256": "6d2546bb189c732a8ca29af9e22457b152387d158aa459e4ac2ce1e51788b7fb",
        "license": "OFL-mashanzheng.txt",
        "fallback_characters": "砲",
    },
    "clerical": {
        "family": "Xiangqi Clerical",
        "source_name": "Aoyagi Reisho Shimo v2.01 / 青柳隷書しも",
        "source_url": "https://opentype.jp/bin/aoyagireisyosimo_ttf_2_01.zip",
        "source_sha256": "a4c55ad5f72e65a482931d967725e97ff206eb3019c87281d9e5514a63bb8db9",
        "license": "LICENSE-aoyagi.txt",
        "license_type": "Original author permission: free use and free redistribution with original documentation; font unmodified",
        "fallback_characters": "傌",
        "required_characters": TRADITIONAL_CHARACTERS,
        "file": "xiangqi-clerical.ttf",
        "source_archive": "aoyagi-original.zip",
        "source_archive_sha256": "3c4d62d669949dc2d5a9cd1cf0203b4c79d67c3a0760729af5163a0b0b58b1e7",
        "render_metrics": "clerical-metrics.json",
        "unmodified_original": True,
    },
    "clerical-square": {
        "family": "Xiangqi Clerical Square",
        "source_name": "教育部隸書 / TW-MOE-Li v3.00",
        "source_url": "https://language.moe.gov.tw/uploads/files/17694976091079.zip",
        "source_page": "https://language.moe.gov.tw/material/info?m=9fe3fb11-c3d5-41f2-b029-6d18a2c2fd0d",
        "source_sha256": "f0ba5eda31727ad89cc0b1f6b9a7dfda02f061fa101c18548b6f8ea0145c108b",
        "license": "LICENSE-moe-clerical.md",
        "license_documents": ["CC-BY-ND-3.0-TW.html"],
        "license_type": "CC BY-ND 3.0 Taiwan; complete original font, no subsetting or outline modification",
        "attribution": "中華民國教育部",
        "fallback_characters": "傌俥砲",
        "required_characters": TRADITIONAL_CHARACTERS,
        "file": "xiangqi-clerical-square.ttf",
        "source_archive": "moe-clerical-original.zip",
        "source_archive_sha256": "fd7e633ed8cebc94d46e2295e6bd9d58814be5fb7489e99dc23f99b7e435dce0",
        "render_metrics": "clerical-square-metrics.json",
        "unmodified_original": True,
    },
}

ORIGINAL_FONT_METRICS = {
    "clerical": {"units": 1024, "hhea": (880, -144, 0), "entries": 4, "export": "clericalMetrics"},
    "clerical-square": {"units": 2048, "hhea": (2007, -451, 0), "entries": 1, "export": "clericalSquareMetrics"},
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


def kai_legacy_fingerprint(font):
    """Check byte-level preservation independently of glyph names or IDs."""
    raw = font.reader["glyf"]
    offsets = font["loca"].locations
    glyph_ids = {name: index for index, name in enumerate(font.getGlyphOrder())}
    cmap = font.getBestCmap()
    rows = []
    for character in KAI_LEGACY_CHARACTERS:
        name = cmap[ord(character)]
        index = glyph_ids[name]
        glyph_hash = sha256(raw[offsets[index]:offsets[index + 1]]).hexdigest()
        advance, lsb = font["hmtx"][name]
        rows.append([character, glyph_hash, advance, lsb])
    return sha256(json.dumps(rows, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()


def build(source, key="xingkai"):
    spec = SPECS[key]
    characters = spec.get("required_characters", CHARACTERS)
    if spec.get("unmodified_original") and source[:2] == b"PK":
        assert sha256(source).hexdigest() == spec["source_archive_sha256"]
        FONT_DIR.mkdir(parents=True, exist_ok=True)
        (FONT_DIR / spec["source_archive"]).write_bytes(source)
        with ZipFile(BytesIO(source)) as archive:
            source = original_ttf_bytes(archive)
    if sha256(source).hexdigest() != spec["source_sha256"]:
        raise ValueError("Source font changed; review its outlines before rebuilding.")
    font = TTFont(BytesIO(source), recalcTimestamp=False)
    if spec.get("unmodified_original"):
        build_clerical_original(source, font, key)
        return
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
    missing = "".join(c for c in characters if ord(c) not in cmap)
    if missing != spec["fallback_characters"]:
        raise ValueError(f"Unexpected coverage in {spec['source_name']}: {missing!r}")

    # Use a single scale per family so relative glyph sizes remain consistent.
    # A square bbox alone cannot keep diagonal strokes inside a round chess disc.
    names = list(dict.fromkeys(cmap[ord(c)] for c in characters if ord(c) in cmap))
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

    for table in ["fpgm", "prep", "cvt ", "DSIG", "FFTM"]:
        if table in font:
            del font[table]
    font["hhea"].ascent, font["hhea"].descent, font["hhea"].lineGap = 800, -200, 0
    os2 = font["OS/2"]
    os2.sTypoAscender, os2.sTypoDescender, os2.sTypoLineGap = 800, -200, 0
    os2.usWinAscent, os2.usWinDescent = 800, 200
    if os2.version < 4:
        # USE_TYPO_METRICS is only valid from OS/2 v4 onwards.
        os2.version = 4
        os2.sxHeight = getattr(os2, "sxHeight", 500)
        os2.sCapHeight = getattr(os2, "sCapHeight", 800)
        os2.usDefaultChar, os2.usBreakChar, os2.usMaxContext = 0, 32, 0
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
    subsetter.populate(text=characters + " ")
    subsetter.subset(font)
    font["head"].created = font["head"].modified = 2082844800
    font.flavor = "woff2"
    output = FONT_DIR / f"xiangqi-{key}.woff2"
    output.parent.mkdir(parents=True, exist_ok=True)
    font.save(output)
    print(f"Built {output.name} ({output.stat().st_size} bytes)")


def clerical_metrics(font, key="clerical"):
    """Normalize only SVG presentation; never alter the original font bytes."""
    spec = SPECS[key]
    units = font["head"].unitsPerEm
    em_scale = 1000 / units
    cmap = font.getBestCmap()
    missing = "".join(c for c in spec["required_characters"] if ord(c) not in cmap)
    if missing != spec["fallback_characters"]:
        raise ValueError(f"Unexpected original-font coverage: {key}: {missing!r}")
    glyphs = {}
    largest_axis = largest_radius = 0
    for character in spec["required_characters"]:
        # Missing characters use the bundled Kai metrics, not this native font's transform.
        if ord(character) not in cmap:
            continue
        name = cmap[ord(character)]
        x_min, y_min, x_max, y_max = bounds(font, name)
        center_x, center_y = (x_min + x_max) / 2, (y_min + y_max) / 2
        points, _, _ = font["glyf"][name].getCoordinates(font["glyf"])
        radius = max(hypot(x - center_x, y - center_y) for x, y in points)
        advance, lsb = font["hmtx"][name]
        largest_axis = max(largest_axis, x_max - x_min, y_max - y_min)
        largest_radius = max(largest_radius, radius)
        glyphs[character] = {
            "renderCenterX": 500 + (center_x - advance / 2) * em_scale,
            "renderCenterY": 800 - center_y * em_scale,
            "advanceUnits": advance, "lsbUnits": lsb,
            "boundsUnits": [x_min, y_min, x_max, y_max],
            "controlRadiusUnits": radius,
        }
    common_scale = min(1, 850 / (largest_axis * em_scale), 474 / (largest_radius * em_scale))
    return {
        "sourceSha256": spec["source_sha256"],
        "unitsPerEm": units, "commonScale": common_scale,
        "maxControlRadiusUnits": 474, "glyphs": glyphs,
    }


def original_ttf_bytes(archive):
    members = [name for name in archive.namelist() if name.lower().endswith(".ttf")]
    assert len(members) == 1
    return archive.read(members[0])


def metrics_module(metrics, key):
    return ("// Original font stays byte-identical; these values normalize SVG presentation only.\n"
            + "export const " + ORIGINAL_FONT_METRICS[key]["export"] + " = "
            + json.dumps(metrics, ensure_ascii=False, indent=2) + ";\n")


def build_clerical_original(source, font, key="clerical"):
    spec = SPECS[key]
    archive_path = FONT_DIR / spec["source_archive"]
    if not archive_path.exists():
        archive_path.write_bytes(urlopen(spec["source_url"], timeout=120).read())
    assert sha256(archive_path.read_bytes()).hexdigest() == spec["source_archive_sha256"]
    with ZipFile(archive_path) as archive:
        assert archive.testzip() is None
        assert original_ttf_bytes(archive) == source
        if key == "clerical":
            notice = next(archive.read(name) for name in archive.namelist() if name.endswith(".txt"))
            (FONT_DIR / spec["license"]).write_bytes(notice)
    # Education ministry's ZIP contains the unmodified font only; its official
    # web notice and complete CC license are supplied beside it in this repository.
    for document in [spec["license"], *spec.get("license_documents", [])]:
        assert (FONT_DIR / document).is_file(), document
    output = FONT_DIR / spec["file"]
    output.write_bytes(source)
    metrics = clerical_metrics(font, key)
    serialized = json.dumps(metrics, ensure_ascii=False, indent=2)
    # Hash the same UTF-8/LF bytes on Windows and Linux, including after checkout.
    (FONT_DIR / spec["render_metrics"]).write_bytes((serialized + "\n").encode("utf-8"))
    (FONT_DIR / spec["render_metrics"]).with_suffix(".js").write_bytes(metrics_module(metrics, key).encode("utf-8"))
    print(f"Copied original {output.name} ({len(source)} bytes); generated SVG metrics for {len(metrics['glyphs'])} native traditional glyphs")


def font_record(key):
    spec = SPECS[key]
    output = FONT_DIR / spec.get("file", f"xiangqi-{key}.woff2")
    font = TTFont(output, recalcTimestamp=False)
    cmap = font.getBestCmap()
    return {
        **spec,
        "file": output.name,
        "characters": "".join(c for c in spec.get("required_characters", CHARACTERS) + " " if ord(c) in cmap),
        "sha256": sha256(output.read_bytes()).hexdigest(),
        "license_sha256": sha256((FONT_DIR / spec["license"]).read_bytes()).hexdigest(),
        **({"source_archive_sha256": sha256((FONT_DIR / spec["source_archive"]).read_bytes()).hexdigest()}
           if "source_archive" in spec else {}),
        **({"render_metrics_sha256": sha256((FONT_DIR / spec["render_metrics"]).read_bytes()).hexdigest()}
           if "render_metrics" in spec else {}),
        **({"render_metrics_module_sha256": sha256((FONT_DIR / spec["render_metrics"]).with_suffix(".js").read_bytes()).hexdigest()}
           if "render_metrics" in spec else {}),
        **({"license_document_sha256": {document: sha256((FONT_DIR / document).read_bytes()).hexdigest()
                                        for document in spec["license_documents"]}}
           if "license_documents" in spec else {}),
    }


def write_manifest():
    manifest = {
        "required_characters": KAI_CHARACTERS + " ",
        "simplified_characters": CHARACTERS + " ",
        "clerical_characters": TRADITIONAL_CHARACTERS + " ",
        "outline_limits": {
            "center": [500, 300], "max_axis_units": 850,
            "pre_round_control_radius_units": 474, "final_control_radius_units": 475,
        },
        "builder_dependencies": {"fonttools": "4.62.1", "brotli": "1.0.9"},
        "fonts": [font_record(key) for key in SPECS],
    }
    (FONT_DIR / "manifest.json").write_bytes(
        (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
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
        if spec.get("unmodified_original"):
            verify_clerical_original(font, record, key)
            continue
        expected = set(spec.get("required_characters", CHARACTERS) + " ") - set(spec["fallback_characters"])
        if set(map(chr, cmap)) != expected:
            raise ValueError(f"Unexpected cmap: {record['file']}")
        assert font["head"].unitsPerEm == 1000
        assert (font["hhea"].ascent, font["hhea"].descent, font["hhea"].lineGap) == (800, -200, 0)
        os2 = font["OS/2"]
        assert (os2.sTypoAscender, os2.sTypoDescender, os2.sTypoLineGap) == (800, -200, 0)
        assert (os2.usWinAscent, os2.usWinDescent) == (800, 200)
        assert os2.version >= 4 and os2.fsSelection & (1 << 7)
        if key == "kai":
            assert kai_legacy_fingerprint(font) == KAI_LEGACY_GLYPHS_SHA256, "Earlier Kai outlines or hmtx changed"
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
            assert max(x_max - x_min, y_max - y_min) <= 851, character
            assert 0 <= x_min < x_max <= 1000, character
            assert -200 <= y_min < y_max <= 800, character
            assert abs((x_min + x_max) / 2 - 500) <= .5, character
            assert abs((y_min + y_max) / 2 - 300) <= .5, character
            coordinates, _, _ = font["glyf"][name].getCoordinates(font["glyf"])
            assert max(hypot(x - 500, y - 300) for x, y in coordinates) <= 475, character
        print(f"Verified {record['file']}: {record['characters']} ({record['sha256']})")


def verify_clerical_original(font, record, key="clerical"):
    spec = SPECS[key]
    native = ORIGINAL_FONT_METRICS[key]
    assert record["sha256"] == spec["source_sha256"]
    assert record["source_archive_sha256"] == spec["source_archive_sha256"]
    with ZipFile(FONT_DIR / spec["source_archive"]) as archive:
        assert archive.testzip() is None
        assert len(archive.infolist()) == native["entries"]
        assert original_ttf_bytes(archive) == (FONT_DIR / spec["file"]).read_bytes()
        if key == "clerical":
            assert next(archive.read(name) for name in archive.namelist() if name.endswith(".txt")) == (FONT_DIR / spec["license"]).read_bytes()
    assert font["head"].unitsPerEm == native["units"]
    assert (font["hhea"].ascent, font["hhea"].descent, font["hhea"].lineGap) == native["hhea"]
    metrics = clerical_metrics(font, key)
    assert json.loads((FONT_DIR / spec["render_metrics"]).read_text(encoding="utf-8")) == metrics
    assert (FONT_DIR / spec["render_metrics"]).with_suffix(".js").read_text(encoding="utf-8") == metrics_module(metrics, key)
    cmap = font.getBestCmap()
    assert set(metrics["glyphs"]) == set(spec["required_characters"]) - set(spec["fallback_characters"])
    fallback = TTFont(FONT_DIR / SPECS["kai"].get("file", "xiangqi-kai.woff2"), recalcTimestamp=False)
    fallback_cmap = fallback.getBestCmap()
    for character in spec["fallback_characters"]:
        assert character not in metrics["glyphs"], character
        assert bounds(fallback, fallback_cmap[ord(character)]) is not None, character
    em_scale = 1000 / metrics["unitsPerEm"]
    for character, item in metrics["glyphs"].items():
        x_min, y_min, x_max, y_max = item["boundsUnits"]
        assert x_max > x_min and y_max > y_min
        center_x, center_y = (x_min + x_max) / 2, (y_min + y_max) / 2
        actual_x = 500 + metrics["commonScale"] * (500 + (center_x - item["advanceUnits"] / 2) * em_scale - item["renderCenterX"])
        actual_y = 500 + metrics["commonScale"] * (800 - center_y * em_scale - item["renderCenterY"])
        assert abs(actual_x - 500) < 1e-9 and abs(actual_y - 500) < 1e-9, character
        points, _, _ = font["glyf"][cmap[ord(character)]].getCoordinates(font["glyf"])
        assert max(hypot(x - center_x, y - center_y) for x, y in points) * em_scale * metrics["commonScale"] <= 474.000001, character
    print(f"Verified original {record['file']}: {len(metrics['glyphs'])} native traditional glyphs, bundled Kai fallback {spec['fallback_characters'] or 'none'}; SVG ink center (500,500), radius <=474; author documents preserved ({record['sha256']})")


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
        if all((FONT_DIR / spec.get("file", f"xiangqi-{key}.woff2")).exists() for key, spec in SPECS.items()):
            write_manifest()
            verify()
