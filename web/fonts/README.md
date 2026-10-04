# Bundled Xiangqi fonts

Six local font choices apply to the chess pieces and **楚河 / 汉界** river labels. Four small WOFF2 derivatives and two complete, unmodified TTFs are served from this installation; no installed Chinese fonts or font CDN is needed. The names below are CSS family names for this application, not proprietary system fonts such as STXingkai / 华文行楷 or SimKai / 楷体.

| File / CSS family | Source / appearance | Coverage | Bytes | License |
| --- | --- | --- | ---: | --- |
| `xiangqi-running.woff2` / `Xiangqi Running` | Long Cang / 行书 | 帅仕相马车炮兵将士象卒楚河汉界 + space | 5,740 | [OFL-longcang.txt](OFL-longcang.txt) |
| `xiangqi-kai.woff2` / `Xiangqi Kai` | LXGW WenKai Regular v1.522 / 楷体 | 帅仕相马车炮兵将士象砲卒楚河汉界帥馬俥車將漢傌 + space | 6,188 | [OFL-wenkai.txt](OFL-wenkai.txt) |
| `xiangqi-xingkai.woff2` / `Xiangqi Xingkai` | Zhi Mang Xing / 草书 | 帅仕相马车炮兵将士象砲卒楚河汉界 + space | 5,332 | [OFL.txt](OFL.txt) |
| `xiangqi-regular.woff2` / `Xiangqi Regular` | Ma Shan Zheng / 毛笔正楷 | 帅仕相马车炮兵将士象卒楚河汉界 + space | 6,504 | [OFL-mashanzheng.txt](OFL-mashanzheng.txt) |
| `xiangqi-clerical.ttf` / `Xiangqi Clerical` | 青柳隷書しも v2.01 / 真正隶书 | 帥仕相馬俥車炮兵將士象砲卒楚河漢界 + space; full original character set also retained | 4,412,684 | [Original author notice, Shift-JIS](LICENSE-aoyagi.txt), [complete original distribution](aoyagi-original.zip) |
| `xiangqi-clerical-square.ttf` / `Xiangqi Clerical Square` | 教育部隸書 / TW-MOE-Li v3.00; orderly clerical structure | 帥仕相馬車炮兵將士象卒楚河漢界 + space; full original character set also retained | 5,243,908 | [MOE attribution and notice](LICENSE-moe-clerical.md), [CC BY-ND 3.0 Taiwan](CC-BY-ND-3.0-TW.html), [complete original distribution](moe-clerical-original.zip) |

The four WOFF2 derivatives have a 1000-unit advance, ink center `(500, 300)`, ascent `800`, descent `-200` and no line gap. All outline points, including Bezier control points, fit within a **475-unit-radius circle** around `(500, 300)`. Relative glyph sizes and stroke shapes are preserved with one common scale for each family. The Kai fallback includes seven additional traditional characters. Adding the native upstream **傌 U+508C** preserves all previous 22 Chinese glyphs' raw `glyf` bytes and `hmtx` advance/sidebearing pairs exactly; the offline verifier checks their combined fingerprint. No **傌** outline is fabricated from **馬**.

The build applies `min(1, 850 / largestAxis, 474 / largestControlPointRadius)` before rounding coordinates. A Bezier curve lies in the convex hull of its control points, so bounding every control point by that disk also bounds every actual stroke, including diagonals. Rounding adds less than `0.71` units, leaving the final contour within radius `475`; a square bounding box alone would not provide this circular guarantee.

For a piece outer diameter `d` with a 2 px border, the SVG side length is limited to `min(54px, max(0px, d - 8px))`, matching the current CSS. Its ink radius is at most `0.475 × SVG side length`, leaving at least **2 px** between the real stroke and the border's inner edge whenever the SVG has positive size. This accounts for the circular edge, not just a content square. A `1000 × 1000` SVG viewBox, `1000` unit font size, horizontal anchor `500` and baseline `800` position the normalized WOFF2 ink center at `(500,500)`.

Both clerical choices use the authors' original TTFs **byte for byte**, without subsetting, renaming their internal families, changing outlines or converting format. Their separately stored metrics describe SVG presentation only:

- 青柳隷書しも: native UPM `1024`, hhea ascent/descent/line gap `880 / -144 / 0`. [clerical-metrics.json](clerical-metrics.json) and its matching [ES module](clerical-metrics.js), exporting `clericalMetrics`, apply common scale `0.7492860052920658` to its 17 native traditional outlines. **傌 is absent from the original font and its metrics** and uses the bundled Kai glyph without a 青柳 transform.
- 教育部隸書: native UPM `2048`, hhea ascent/descent/line gap `2007 / -451 / 0`; OS/2 typo metrics `1599 / -449 / 0`, Windows ascent/descent `1638 / 410`. [clerical-square-metrics.json](clerical-square-metrics.json) and its matching [ES module](clerical-square-metrics.js), exporting `clericalSquareMetrics`, apply common scale `0.9384366576819407` to its 15 native required outlines. **傌, 俥 and 砲 are absent from both the original font and these metrics**; each uses the bundled Kai font's own centering, without a MOE transform.

For every native glyph, its measured real ink center is translated to `(500,500)` and every control point lies within radius `474`; therefore every actual Bezier stroke lies inside that disk. No original outlines are rounded or rewritten. River characters use the same per-character transform at their own display size. The offline verifier recomputes these values from each original TTF and checks both data formats, all 17 青柳 outlines and all 15 教育部 outlines, font hashes, archive integrity and included notices. Its Kai verification separately proves every fallback outline satisfies the normalized radius `475` bound.

Both clerical choices display traditional lettering: **帥、將、漢**, with red **傌 / 俥** and black **馬 / 車**. The required set is **帥仕相傌馬俥車炮兵將士象砲卒楚河漢界** (18 characters). 青柳 contains 17 of them, including **俥 / 車** and **炮 / 砲**, and uses Kai for **傌** only. 教育部 contains 15 of them and explicitly falls back to Kai for **傌 / 俥 / 砲**. Other choices use the shared canonical simplified labels, with **马 / 车** on both sides. No simplified codepoint is remapped to a traditional outline. Changing font only affects this client's displayed lettering; game rules and move notation retain their canonical names.

Long Cang and Ma Shan Zheng have no U+7832 **砲**. Their subsets deliberately omit that cmap entry, so CSS falls back **for that character only** to included `Xiangqi Kai`. The Kai subset has a nonempty outline for all 23 simplified/traditional characters required by the six choices, including the upstream font's genuine **傌 U+508C**. For compatibility, the earlier Zhi Mang Xing derivative retains its composed **砲**, using the same source font's 石 component from 码 and 包 component from 饱.

The four WOFF2 sources and derivatives are distributed under **SIL Open Font License 1.1**. Keep each corresponding complete license when redistributing them with the software. Copyright notices and upstream license metadata are retained inside these fonts. Copyright holders are:

- Long Cang: Copyright 2018 The Long Cang Project Authors.
- Zhi Mang Xing: Copyright 2018 The Zhi Mang Xing Project Authors.
- LXGW WenKai v1.522: Copyright 2021–2026 LXGW; Copyright 2020 The Klee Project Authors.
- Ma Shan Zheng: Copyright 2018 The Ma Shan Zheng Project Authors.

青柳隷書しも uses its author's original permission, **not OFL or GPL**. The official notice allows free use (including commercial use) and free redistribution, requires redistribution to include its usage instructions and font explanation, and prohibits charging for redistributed font files. Ordinary use and redistribution do not require contacting the author; inclusion with books or magazines requires notification under the original notice. Keep [aoyagi-original.zip](aoyagi-original.zip) with the application: it is the complete, unchanged official archive with the original TTF, usage TXT, explanation PDF and explanation DOC. The author's notice is also copied byte for byte into `LICENSE-aoyagi.txt` (original Shift-JIS encoding). This project neither modifies the font nor sells it separately. The original ZIP's Japanese filenames use legacy encoding; a Japanese-capable archive tool displays them correctly.

教育部隸書 is credited to **中華民國教育部** and distributed under **Creative Commons Attribution-NoDerivs 3.0 Taiwan / 姓名標示－禁止改作 3.0 台灣**. Retain its credit, [attribution and source notice](LICENSE-moe-clerical.md), [complete license text](CC-BY-ND-3.0-TW.html), and [unchanged official archive](moe-clerical-original.zip) when redistributing it. The official font's embedded copyright expressly permits commercial and noncommercial redistribution of the unchanged, complete font with attribution. This application provides exactly that original font alongside independent display measurements; it does not subset or modify the font. The ministry describes it as a 4,808-character font based on its clerical master manuscript. Its original archive contains one complete TTF; the license and ministry attribution are supplied alongside the archive.

The WenKai source is specifically the **v1.522** release, with that release's license; the build does not take a changing branch's license or font. Official source locations:

- [Long Cang at Google Fonts, pinned revision](https://github.com/google/fonts/tree/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/longcang).
- [Zhi Mang Xing at Google Fonts, pinned revision](https://github.com/google/fonts/tree/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/zhimangxing).
- [LXGW WenKai v1.522 release](https://github.com/lxgw/LxgwWenKai/releases/tag/v1.522), tag commit `e8b5b48b79f19f29aa68b0a178eab3472ea9f7e8` and [matching license](https://github.com/lxgw/LxgwWenKai/blob/v1.522/OFL.txt).
- [Ma Shan Zheng at Google Fonts, pinned revision](https://github.com/google/fonts/tree/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/mashanzheng) and [matching OFL](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/mashanzheng/OFL.txt).
- [Official 青柳隷書しも page](https://opentype.jp/aoyagireisho.htm) and [v2.01 original distribution](https://opentype.jp/bin/aoyagireisyosimo_ttf_2_01.zip). Original TTF SHA-256: `a4c55ad5f72e65a482931d967725e97ff206eb3019c87281d9e5514a63bb8db9`; original ZIP SHA-256: `3c4d62d669949dc2d5a9cd1cf0203b4c79d67c3a0760729af5163a0b0b58b1e7`.
- [Official 教育部隸書 page and license](https://language.moe.gov.tw/material/info?m=9fe3fb11-c3d5-41f2-b029-6d18a2c2fd0d) and [original v3.00 distribution](https://language.moe.gov.tw/uploads/files/17694976091079.zip). Original TTF SHA-256: `f0ba5eda31727ad89cc0b1f6b9a7dfda02f061fa101c18548b6f8ea0145c108b`; original ZIP SHA-256: `fd7e633ed8cebc94d46e2295e6bd9d58814be5fb7489e99dc23f99b7e435dce0`. The complete license is available from [Creative Commons](https://creativecommons.org/licenses/by-nd/3.0/tw/legalcode.zh-hant) and its [official legal-text repository](https://github.com/creativecommons/cc-legal-tools-data/blob/main/docs/licenses/by-nd/3.0/tw/legalcode.zh-hant.html); the local copy preserves the full legal text for offline reading.

## Rebuild and verify

From the repository root:

```powershell
python -m pip install fonttools==4.62.1 brotli==1.0.9
python scripts/build_chess_font.py
python scripts/build_chess_font.py --verify
```

The build verifies each upstream SHA-256 before reading outlines. WOFF2 derivatives use fixed timestamps and application names; both clerical TTFs and their complete official archives remain unchanged. [manifest.json](manifest.json) records source URLs/hashes, required and covered characters, output hashes, attribution, license-document hashes, original archive hashes and JSON/ES-module SVG metrics hashes. Rebuilding with pinned dependencies produces the same outputs. Python and these build dependencies are **not runtime dependencies**.

For an offline rebuild, keep the four OFL source TTFs outside packaged `web`, for example in ignored `artifacts/font-sources`, named `running.source.ttf`, `kai.source.ttf`, `xingkai.source.ttf` and `regular.source.ttf`. Cache the original 青柳 TTF as `clerical.source.ttf` and original 教育部 TTF as `clerical-square.source.ttf`; retain both bundled original ZIPs and their licenses:

```powershell
python scripts/build_chess_font.py --source-dir artifacts/font-sources
```

`--font running`, `--font kai`, `--font xingkai`, `--font regular`, `--font clerical` or `--font clerical-square` processes one face; `--source <path>` supplies its cached TTF or, for a clerical face, its original official ZIP. The offline `--verify` checks hashes, notices and original archive integrity; exact WOFF2 cmap coverage, visible outlines, centering, advance widths, OS/2/hhea metrics and the 475-unit bound; preservation of the earlier 22 Kai glyphs; plus all 32 native original-font chess outlines after their SVG transforms, with center `(500,500)` and control radius at most `474` units. Missing original-font glyphs must remain absent from their metrics and present as visible outlines in Kai.
