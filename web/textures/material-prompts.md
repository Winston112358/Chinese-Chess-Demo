# 牛角与玉石棋子材质

五张材质均使用内置 imagegen 工具生成，未使用外部 API 或程序绘制纹理。图像为无棋子、字、圆边与投影的平面材质扫描图；原 PNG 保留在默认生成目录，并原样复制到 `assets/source-png/` 供单独归档。应用使用 `web/textures/{ID}.webp`，仅按比例缩至最长边 768 px，并以 WebP quality 88、method 6 转码；未重着色或重绘。

生成图检查：黑牛角呈黑褐层状细丝，白牛角呈暖乳白层缕；白玉为乳白柔云，青玉为浅青云雾，碧玉为较深青绿云斑。均无棋子、文字、圆边、硬光斑或巨大黑点；小圆盘的最终字体对比度由界面配色适配。

## 黑牛角 · horn-black

- 原 PNG：`C:\Users\Winston\.codex\generated_images\01a0fc8b-3d4a-7c31-858b-748f43f04fb1\exec-913ae60c-5f84-4cac-9cac-f3ec8d7db70d.png`
- 归档 PNG：`assets/source-png/黑牛角.png`
- 运行材质：`web/textures/horn-black.webp`

原始内置 imagegen 提示词：

```text
Use case: photorealistic-natural.
Asset type: an opaque square material-scan bitmap for Chinese chess piece faces, ultimately cropped into small 28–48 pixel circular discs.
Composition: one continuous flat surface scanned straight down, edge to edge; even neutral diffuse illumination, with subtle natural material depth and a restrained low-contrast texture. The image contains only the material itself. No physical object, circular piece, rim, lettering, engraving, chess symbols, borders, perspective, studio backdrop, lighting gradient, hard highlight, cast shadow, vignette, seams, repeating graphic pattern, cracks, or watermark. Keep small-scale texture readable and quiet behind bold red or dark/cream Chinese lettering; avoid large isolated black spots and sharp high-contrast thin veins.
Material: black bovine horn, dense dark charcoal-black and warm very dark brown keratin. Characteristic close layered laminae and flowing fine silky fibers, with naturally irregular gently swept parallel growth bands. Rich translucent horn depth without specular reflection. This is smooth horn anatomy, not wood grain or marble; no large knots or strong striped pattern. Keep the fibrous layers visible yet soft.
```

## 白牛角 · horn-ivory

- 原 PNG：`C:\Users\Winston\.codex\generated_images\01a0fc8b-3d4a-7c31-858b-748f43f04fb1\exec-2d36fd45-8d44-4ec2-bb09-3a31e9becbef.png`
- 归档 PNG：`assets/source-png/白牛角.png`
- 运行材质：`web/textures/horn-ivory.webp`

原始内置 imagegen 提示词：

```text
Use case: photorealistic-natural.
Asset type: an opaque square material-scan bitmap for Chinese chess piece faces, ultimately cropped into small 28–48 pixel circular discs.
Composition: one continuous flat surface scanned straight down, edge to edge; even neutral diffuse illumination, with subtle natural material depth and a restrained low-contrast texture. The image contains only the material itself. No physical object, circular piece, rim, lettering, engraving, chess symbols, borders, perspective, studio backdrop, lighting gradient, hard highlight, cast shadow, vignette, seams, repeating graphic pattern, cracks, or watermark. Keep small-scale texture readable and quiet behind bold red or dark/cream Chinese lettering; avoid large isolated black spots and sharp high-contrast thin veins.
Material: pale bovine horn, warm creamy milk-white and faint honey ivory translucent keratin. Characteristic soft overlapping growth laminae and delicate long wispy layered fibers, subtle warm cream ribbons, a smooth naturally translucent horn surface. This is light horn anatomy, not ivory carving, wood or marble. No yellow patches, no stark stripes, no glossy highlight.
```

## 白玉 · jade-white

- 原 PNG：`C:\Users\Winston\.codex\generated_images\01a0fc8b-3d4a-7c31-858b-748f43f04fb1\exec-1d533b01-c0a7-4b12-b6ea-dad87599416c.png`
- 归档 PNG：`assets/source-png/白玉.png`
- 运行材质：`web/textures/jade-white.webp`

原始内置 imagegen 提示词：

```text
Use case: photorealistic-natural.
Asset type: an opaque square material-scan bitmap for Chinese chess piece faces, ultimately cropped into small 28–48 pixel circular discs.
Composition: one continuous flat surface scanned straight down, edge to edge; even neutral diffuse illumination, with subtle natural material depth and a restrained low-contrast texture. The image contains only the material itself. No physical object, circular piece, rim, lettering, engraving, chess symbols, borders, perspective, studio backdrop, lighting gradient, hard highlight, cast shadow, vignette, seams, repeating graphic pattern, cracks, or watermark. Keep small-scale texture readable and quiet behind bold red or dark/cream Chinese lettering; avoid large isolated black spots and sharp high-contrast thin veins.
Material: white nephrite-style jade, warm milky white and extremely pale cool cream. Gentle fine cloudlike mineral mottling with soft diffuse translucent depth, small soft intermingled cloudy areas, silky dense polished jade structure without visible scratches or shine. Quiet almost-white stone with delicate natural cloud haze, not directional fibers or marble veins; no large dark inclusions or hairline cracks.
```

## 青玉 · jade-celadon

- 原 PNG：`C:\Users\Winston\.codex\generated_images\01a0fc8b-3d4a-7c31-858b-748f43f04fb1\exec-6749aa74-2592-4cb2-ab4a-01c2f853e9e0.png`
- 归档 PNG：`assets/source-png/青玉.png`
- 运行材质：`web/textures/jade-celadon.webp`

原始内置 imagegen 提示词：

```text
Use case: photorealistic-natural.
Asset type: an opaque square material-scan bitmap for Chinese chess piece faces, ultimately cropped into small 28–48 pixel circular discs.
Composition: one continuous flat surface scanned straight down, edge to edge; even neutral diffuse illumination, with subtle natural material depth and a restrained low-contrast texture. The image contains only the material itself. No physical object, circular piece, rim, lettering, engraving, chess symbols, borders, perspective, studio backdrop, lighting gradient, hard highlight, cast shadow, vignette, seams, repeating graphic pattern, cracks, or watermark. Keep small-scale texture readable and quiet behind bold red or dark/cream Chinese lettering; avoid large isolated black spots and sharp high-contrast thin veins.
Material: pale celadon jade, clearly light soft gray-green and delicate translucent seafoam-celadon tones. Gentle softly overlapping mineral cloud patterns, diffuse slightly deeper pale green wisps, restrained silky jade structure and smooth translucent depth. Different from white jade through an unmistakable pale green body color. Do not add white marble veins, hard streaks, dark inclusions or yellow patches.
```

## 碧玉 · jade-green

- 原 PNG：`C:\Users\Winston\.codex\generated_images\01a0fc8b-3d4a-7c31-858b-748f43f04fb1\exec-125d25b9-3397-4433-ba51-61a64bad7f1a.png`
- 归档 PNG：`assets/source-png/碧玉.png`
- 运行材质：`web/textures/jade-green.webp`

原始内置 imagegen 提示词：

```text
Use case: photorealistic-natural.
Asset type: an opaque square material-scan bitmap for Chinese chess piece faces, ultimately cropped into small 28–48 pixel circular discs.
Composition: one continuous flat surface scanned straight down, edge to edge; even neutral diffuse illumination, with subtle natural material depth and a restrained low-contrast texture. The image contains only the material itself. No physical object, circular piece, rim, lettering, engraving, chess symbols, borders, perspective, studio backdrop, lighting gradient, hard highlight, cast shadow, vignette, seams, repeating graphic pattern, cracks, or watermark. Keep small-scale texture readable and quiet behind bold red or dark/cream Chinese lettering; avoid large isolated black spots and sharp high-contrast thin veins.
Material: deeper green nephrite-style jade, mellow rich medium jade-green body color with soft muted deeper green mineral cloud patches and subtly lighter green haze. Natural dense smooth mineral texture and translucent depth. Clearly deeper green than pale celadon jade, without becoming black; broad diffuse softly blended clouds of low-to-moderate contrast, no giant black spots, no high-contrast white lines or directional fibers.
```


