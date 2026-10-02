# 内置浅木纹

这两张位图使用内置 imagegen 生成并随软件打包，不依赖外部网址或电脑上的素材。生成后的 PNG 仅转码为 WebP（1190 × 1322，quality 90，method 6）；未使用程序绘制或重着色木纹。

- `beech-light.webp`：浅榉木，细直纤维、自然微孔与细小射线斑点。
- `walnut-light.webp`：浅胡桃木，舒展的山形纹、弯曲年轮和波状纤维。

棋盘和皮肤预览使用同一张图片，保留纹理方向，以 `cover` 居中显示。预览的网格在位图上方。榉木使用约 25% 白色背景罩层，胡桃木使用 40%，仅浅化木材背景；棋盘线与河界文字使用加深的颜色。棋子几何、字号和内置字库不受纹理影响。

`appearance.css` 内嵌图片 data URL，使局域网客机在现有静态资源路由与 CSP 下可直接显示；原始 WebP 也保存在这里。替换 WebP 后，在项目根目录运行：

```powershell
python scripts/embed_wood_textures.py
```

## 原始生成提示词（内置 imagegen）

### beech

Use case: photorealistic-natural. Asset type: high-quality real wood texture bitmap for the entire background of a readable Chinese chess board. Create one portrait near-square 9:10 material scan of pale natural beech wood, flat orthographic top-down scan, evenly lit matte sanded fine wood surface, edge-to-edge wood only. Honey ivory and very light warm beige palette, low but clearly visible natural grain contrast. The characteristic anatomy must be fine predominantly vertical straight fibrous grain with organic waviness and irregular fiber widths, many tiny scattered short ray flecks and fine pores, delicate silky density variation and realistic subtle growth structure. This must look like actual high-resolution beech wood, not a few graphic lines or a pattern made of mathematical stripes. The fine grain should be distinguishable at 540px board width but never overpower dark chess grid lines. No large knots, no cracks, no plank joints, no decorative diagonal stripes, no chess grid, no pieces, no text, no border, no perspective, no lighting gradient or cast shadows, no objects, no watermark. Smooth restrained density across the whole surface, with texture detail extending to all four edges. Final asset is a naturally pale fine-grained beech board surface, ready to use in a UI without added dark overlays.

### walnut

Use case: photorealistic-natural. Asset type: high-quality real wood texture bitmap for the entire background of a readable Chinese chess board. Create one portrait near-square 9:10 material scan of light natural walnut sapwood/heartwood transition, flat orthographic top-down scan, evenly lit matte finely sanded wooden surface, edge-to-edge wood only. Light warm caramel taupe, pale nut brown and soft cream tones, restrained low to moderate contrast suitable under dark chess grid lines. This texture must have clearly characteristic broad flowing cathedral/crown grain: softly curved nested elongated arches and flame-shaped annual-ring contours around two asymmetrical long vertical peaks, organic wavy broad grain bands, fine pores and fibers following those contours. It must be structurally very different from straight-grained beech: recognizable curved mountains and smooth sweeping annual rings, not straight stripes and not generic noise. Show realistic wood anatomy and nuanced fibers, natural irregular spacing of curved rings. The sweeping shapes must remain visible at 540px board width and even in a small preview. Keep the surface light and the contours subtle, avoid high contrast dark grain or harsh ring edges. No large dark knots, no cracks, no plank joints, no decorative diagonal stripes, no chess grid, no pieces, no text, no border, no perspective, no lighting gradient, no cast shadows, no objects, no watermark. Final asset is a pale walnut wood board with gentle cathedral grain, ready to use as a readable game UI background.
