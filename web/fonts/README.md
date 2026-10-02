# Bundled Xiangqi fonts

Three small WOFF2 derivatives provide independent local choices for the chess pieces and **楚河 / 汉界** river labels. The application serves these files from its own installation; it needs neither installed Chinese fonts nor a connection to a font CDN. The names below identify this application's derivatives, not proprietary system fonts such as STXingkai / 华文行楷 or SimKai / 楷体.

| File / CSS family | Source / appearance | Coverage | Bytes | License |
| --- | --- | --- | ---: | --- |
| `xiangqi-running.woff2` / `Xiangqi Running` | Long Cang / 行书 | 帅仕相马车炮兵将士象卒楚河汉界 + space | 5,740 | [OFL-longcang.txt](OFL-longcang.txt) |
| `xiangqi-kai.woff2` / `Xiangqi Kai` | LXGW WenKai Regular v1.522 / 楷体 | 帅仕相马车炮兵将士象砲卒楚河汉界 + space | 4,268 | [OFL-wenkai.txt](OFL-wenkai.txt) |
| `xiangqi-xingkai.woff2` / `Xiangqi Xingkai` | Zhi Mang Xing / 草书 | 帅仕相马车炮兵将士象砲卒楚河汉界 + space | 5,332 | [OFL.txt](OFL.txt) |

Each Chinese glyph has a 1000-unit advance. Each visible outline is centered at `(500, 300)`, with ascent `800`, descent `-200`, no line gap, and a maximum ink dimension of `850` units. All outline points, including Bezier control points, fit within a **475-unit-radius circle** around `(500, 300)`. Relative glyph sizes and stroke shapes are preserved with one common scale for all 16 Chinese glyphs in each family.

The build applies `min(1, 850 / largestAxis, 474 / largestControlPointRadius)` before rounding coordinates. A Bezier curve lies in the convex hull of its control points, so bounding every control point by that disk also bounds every actual stroke, including diagonals. Rounding adds less than `0.71` units, leaving the final contour within radius `475`; a square bounding box alone would not provide this circular guarantee.

For a piece outer diameter `d` with a 2 px border, the SVG side length is limited to `min(38px, max(0px, d - 8px))`. Its ink radius is at most `0.475 × SVG side length`, leaving at least **2 px** between the real stroke and the border's inner edge whenever the SVG has positive size. This remains true as the board becomes smaller; it accounts for the circular edge, not just the content square. The normalized glyph center is positioned at the disc center using a `1000 × 1000` SVG viewBox, a `1000` unit font size, horizontal anchor `500`, and baseline `800`.

Long Cang has no U+7832 **砲**. Its subset deliberately omits that cmap entry, so the application's CSS family stack can fall back **for that character only** to the included `Xiangqi Kai`. The Kai subset has a nonempty outline for every required Chinese character. For compatibility, the earlier Zhi Mang Xing derivative retains its composed **砲**, using the same source font's 石 component from 码 and 包 component from 饱.

All three sources and their derivatives are distributed under **SIL Open Font License 1.1**. Keep each corresponding complete license file when redistributing these fonts with the software. Copyright notices and upstream license metadata are also retained inside the fonts. Copyright holders are:

- Long Cang: Copyright 2018 The Long Cang Project Authors.
- Zhi Mang Xing: Copyright 2018 The Zhi Mang Xing Project Authors.
- LXGW WenKai v1.522: Copyright 2021–2026 LXGW; Copyright 2020 The Klee Project Authors.

The WenKai source is specifically the **v1.522** release, with that release's license; the build does not take a changing branch's license or font. Official source locations:

- [Long Cang at Google Fonts, pinned revision](https://github.com/google/fonts/tree/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/longcang).
- [Zhi Mang Xing at Google Fonts, pinned revision](https://github.com/google/fonts/tree/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/zhimangxing).
- [LXGW WenKai v1.522 release](https://github.com/lxgw/LxgwWenKai/releases/tag/v1.522), tag commit `e8b5b48b79f19f29aa68b0a178eab3472ea9f7e8` and [matching license](https://github.com/lxgw/LxgwWenKai/blob/v1.522/OFL.txt).

## Rebuild and verify

From the repository root:

```powershell
python -m pip install fonttools==4.62.1 brotli==1.0.9
python scripts/build_chess_font.py
python scripts/build_chess_font.py --verify
```

The build verifies each upstream TTF SHA-256 before reading its outlines, uses fixed timestamps and derivative names, and records source URLs, source hashes, subset coverage, output hashes, and license hashes in [manifest.json](manifest.json). Rebuilding with the pinned tool versions produces the same output hashes. Python and these build dependencies are **not runtime dependencies**.

For an offline rebuild, place downloaded TTFs outside the packaged `web` directory, for example under the ignored `artifacts/font-sources` directory, named `running.source.ttf`, `kai.source.ttf`, and `xingkai.source.ttf`:

```powershell
python scripts/build_chess_font.py --source-dir artifacts/font-sources
```

`--font running`, `--font kai`, or `--font xingkai` builds one face; `--source <path>` supplies that face's cached TTF. The offline `--verify` check verifies committed hashes and licenses, exact cmap coverage, nonempty Chinese outlines, centering, advance widths, line metrics, and the 475-unit bound for every contour/control point.
