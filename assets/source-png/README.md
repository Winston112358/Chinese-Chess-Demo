# 中国象棋材质 PNG 原图

这里集中保留本次软件所使用的全部材质原图：15 张用户提供的木材 PNG、最早的浅榉木与浅胡桃木，以及黑牛角、白牛角、白玉、青玉、碧玉 5 张新棋子材质图，共 22 张。

原图保持原始像素和色彩。软件运行时加载 `web/textures` 中的 WebP 压缩版本，原始 PNG 不进入软件的运行资源，也不对局域网提供原图下载。

原图与运行资源的对应关系和 SHA-256 保存在 `web/textures/manifest.json` 的 `allImageOrigins` 中。15 张用户提供的木材可以运行 `python scripts/prepare_wood_textures.py` 重新生成 WebP；其余 7 张来自内置 imagegen，原始生成文件也保留在生成目录。

最早两张木纹提示词见 `web/textures/README.md`，新增牛角和玉石提示词见 `web/textures/material-prompts.md`。棋盘、棋子表面的明暗适配在 CSS 中完成，不修改这里的图像。
