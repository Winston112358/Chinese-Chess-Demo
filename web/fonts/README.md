# Xiangqi Xingkai

Small bundled brush-script font for the chess pieces and river labels. All displayed characters use the same font on both computers, including the black cannon **砲**.

Derived from [Zhi Mang Xing](https://github.com/google/fonts/tree/main/ofl/zhimangxing), Copyright 2018 The ZhiMangXing Project Authors. Distributed under the SIL Open Font License 1.1; see [OFL.txt](OFL.txt). The derivative is named **Xiangqi Xingkai**.

The original font lacks U+7832 砲. This derivative composes it from the original font's 石 component in 码 and 包 component in 饱. It then centers each glyph's visible outline, gives every glyph a 1000-unit advance, and uses matching vertical metrics. No proprietary system font is included.

To regenerate the WOFF2, install Python packages `fonttools` and `brotli`, then run:

```powershell
python scripts/build_chess_font.py
```

The build script verifies the source TTF SHA-256 (`644e0cae9b40f0b10ab729a01bd32032e3973bac22be3dccae01bf6ae7fde969`) before accessing its contours. The application has no Python dependency and loads the bundled WOFF2 directly.
