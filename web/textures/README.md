# 内置棋盘与棋子纹理

软件提供21种棋盘外观和12种独立棋子材质。15张用户新增的木材图、最早两张木纹，以及牛角/玉石五张材质，共22个WebP由软件自带的静态资源路由提供，主机和局域网客机都不依赖外部图片网址。

全部22张原始PNG集中在 `assets/source-png`，素材包单独归档；此目录不进入EXE运行资源。原图保持像素与色彩，运行图只做等比缩放与WebP编码。15张用户图最长边1024、quality88、method6；全部文件对应关系和双SHA-256见 `manifest.json`。

重新生成15张用户木材的WebP：

```powershell
python scripts/prepare_wood_textures.py
```

棋盘与小样使用同一张纹理、同一方向。黄花梨与花梨木只加15%浅罩，网格与河界字加窄暖米底描边，保留天然木纹。木棋子使用自然表面与更深字色；玫瑰木保留深色纹理并用浅色字。各材质纹理在棋子中适度放大，不改原图，主棋盘、小样和已吃子图标采用相同纹理比例。棋子材质与棋盘独立，部分相近色搭配可微调浅/暖表面，选中材质不改变。文字、边框和字库几何不受背景绘制影响。

最早两张木纹使用内置imagegen生成，PNG仅转码为1190×1322 WebP（quality90，method6）。新增牛角/玉石生成记录见 material-prompts.md。

## 原始生成提示词（内置 imagegen）

### beech

Use case: photorealistic-natural. Asset type: high-quality real wood texture bitmap for the entire background of a readable Chinese chess board. Create one portrait near-square 9:10 material scan of pale natural beech wood, flat orthographic top-down scan, evenly lit matte sanded fine wood surface, edge-to-edge wood only. Honey ivory and very light warm beige palette, low but clearly visible natural grain contrast. The characteristic anatomy must be fine predominantly vertical straight fibrous grain with organic waviness and irregular fiber widths, many tiny scattered short ray flecks and fine pores, delicate silky density variation and realistic subtle growth structure. This must look like actual high-resolution beech wood, not a few graphic lines or a pattern made of mathematical stripes. The fine grain should be distinguishable at 540px board width but never overpower dark chess grid lines. No large knots, no cracks, no plank joints, no decorative diagonal stripes, no chess grid, no pieces, no text, no border, no perspective, no lighting gradient or cast shadows, no objects, no watermark. Smooth restrained density across the whole surface, with texture detail extending to all four edges. Final asset is a naturally pale fine-grained beech board surface, ready to use in a UI without added dark overlays.

### walnut

Use case: photorealistic-natural. Asset type: high-quality real wood texture bitmap for the entire background of a readable Chinese chess board. Create one portrait near-square 9:10 material scan of light natural walnut sapwood/heartwood transition, flat orthographic top-down scan, evenly lit matte finely sanded wooden surface, edge-to-edge wood only. Light warm caramel taupe, pale nut brown and soft cream tones, restrained low to moderate contrast suitable under dark chess grid lines. This texture must have clearly characteristic broad flowing cathedral/crown grain: softly curved nested elongated arches and flame-shaped annual-ring contours around two asymmetrical long vertical peaks, organic wavy broad grain bands, fine pores and fibers following those contours. It must be structurally very different from straight-grained beech: recognizable curved mountains and smooth sweeping annual rings, not straight stripes and not generic noise. Show realistic wood anatomy and nuanced fibers, natural irregular spacing of curved rings. The sweeping shapes must remain visible at 540px board width and even in a small preview. Keep the surface light and the contours subtle, avoid high contrast dark grain or harsh ring edges. No large dark knots, no cracks, no plank joints, no decorative diagonal stripes, no chess grid, no pieces, no text, no border, no perspective, no lighting gradient, no cast shadows, no objects, no watermark. Final asset is a pale walnut wood board with gentle cathedral grain, ready to use as a readable game UI background.
