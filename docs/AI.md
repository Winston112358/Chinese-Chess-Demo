# 皮卡鱼人机对战

本项目接入 [Pikafish](https://github.com/official-pikafish/Pikafish) 官方 Windows x64 引擎及已训练的 NNUE 权重，供个人非商业游玩。棋局通过本地 UCI 进程计算，不使用远程 AI API；游玩时不需要账号、API Key、联网或 GPU。当前只提供一个固定较强的对手，不含模型训练和难度分档。

## 开始游玩

完整 Windows 便携 EXE 已带资源。打开“人机对战 · 皮卡鱼”，选择你的执子并开始：

- 执红时你先走；执黑时电脑先走，棋盘自动将你的一侧放在近处。
- 思考时不能替电脑走棋，仍可查看棋盘、修改外观或进入沙盘推演。
- “撤回我的上一步”回到你最近一着之前；电脑已应手则一起撤回，尚在思考则先取消。执黑时电脑单独的开局着不能撤回，可重新开局。
- 重开、换边、认输及切换模式会取消旧搜索；等待中的旧结果不能改变新棋局。
- 思考失败会给出原因，可点击“重试电脑走棋”；资源缺失时从源码运行的用户先执行下面的准备命令，再重新检查。
- 人机局不计时，认输立即生效；没有自动求和或完整的长将长捉裁定。

当前搜索预算为每步 **1000 ms**、**2 个 CPU 线程**、**64 MiB Hash**。64 MiB 只是置换表设置，实际进程内存还包括模型等资源。实际等待含引擎启动、模型加载和通信，可能超过 1 秒；没有承诺固定的人类棋力等级分。模型由 CPU 执行，不占用显卡算力。

## 从源码准备资源

需要 Windows x64、Node.js 22.12+，以及 Windows 自带的 `curl.exe` 和 `tar.exe`。无需单独安装 7-Zip。

```powershell
npm ci
npm run setup:ai
npm start
# 或运行桌面客户端：npm run desktop
```

只安装网页服务依赖时也可执行 `npm ci --omit=dev`；资源脚本只用 Node.js 内置模块和 Windows 工具。首次下载需要联网，后续复用通过大小及 SHA-256 检查的本地文件。初次需下载约 53.60 MB 的官方跨平台发布归档和约 0.56 MB 的源码 ZIP，但最终只打包 Windows 引擎、单个模型及许可/源码资料。

`npm run dist:win` 自动先执行资源准备，校验失败就停止构建。引擎通过 electron-builder 的 `extraResources` 放到 `resources/pikafish`，不放进 `app.asar`；源码开发时使用 `vendor/pikafish`。网页使用提供该页面的服务器运行引擎；仅在浏览器打开静态 HTML 不能运行本机 EXE 引擎。

`vendor/pikafish` 中的 EXE、NNUE 和源码 ZIP 已忽略，不提交到 Git。`.cache/pikafish` 保存下载缓存；删掉缓存不会影响已准备完毕的资源。

## 固定版本、来源和体积

版本：**Pikafish-2026-09-06**。来源为该版本[官方发布页](https://github.com/official-pikafish/Pikafish/releases/tag/Pikafish-2026-09-06)，引擎原名 `Pikafish-Windows-x86-64-universal.exe`，仅重命名为 `pikafish.exe`，未修改内容。固定源码 tag 对应 commit `4c17cee11f888ae1d48a9494f2e2239f019f0a1f`。

| 资源 | 字节数 | MiB（1024² 字节） |
| --- | ---: | ---: |
| Windows 通用引擎 | 6,944,256 | 6.62 |
| NNUE 权重 | 50,706,378 | 48.36 |
| 对应 tag 的源码 ZIP | 559,168 | 0.53 |
| 原始许可证、作者与上游 README | 44,539 | 0.04 |
| 合计（不含很小的清单与本项目说明） | 58,254,341 | 55.56 |

这张表是解包后的资源体积，最终便携 EXE 增量取决于压缩。下载 URL、各文件长度和 SHA-256 全部保存在 [manifest.json](../vendor/pikafish/manifest.json)。更新版本时必须一起更换二进制、模型、来源、哈希及源码归档，重新做实际引擎走棋与打包验证，不能只改版本字符串。

2026-10-02 使用相同 0.4.0 应用代码、Electron 和便携版构建配置对照：不附带皮卡鱼资源时 EXE 为 **101,136,855 字节（101.14 MB）**，附带时为 **153,176,179 字节（153.18 MB）**，增加 **52,039,324 字节（52.04 MB，51.45%）**。这里 MB 按 1,000,000 字节计算；对照包仅用于测量，不是可用的人机发行版。

## 规则边界

服务端从初始局面重放完整合法走棋历史后发送给皮卡鱼；返回着法仍要通过本项目规则模块校验。这样能避免引擎着法直接绕过棋盘规则，也让引擎收到历史局面。

本项目尚未完整实现长将长捉、重复局面、自然限着等裁定。皮卡鱼内部对此可能有自己的判断；遇到引擎不返回着法等差异时会提示错误，不擅自把它判成某一种胜负。可以悔棋或重新开始。这次接入不等于实现了全部赛事规则。

## 许可和分发

- **引擎：GPLv3。** [Copying.txt](../vendor/pikafish/Copying.txt)、[AUTHORS](../vendor/pikafish/AUTHORS) 与 [上游说明](../vendor/pikafish/UPSTREAM-README.md) 来自官方发布包，保持原始内容。对应源码 `Pikafish-source-Pikafish-2026-09-06.zip` 随便携 EXE 一起放在 `resources/pikafish`；也可从[精确 tag 的源码地址](https://github.com/official-pikafish/Pikafish/archive/refs/tags/Pikafish-2026-09-06.zip)下载。归档包括源码、Makefile 与构建工作流，本项目不修改引擎。
- **NNUE 权重单独授权。** 官方 [NNUE-License.md](../vendor/pikafish/NNUE-License.md) 规定未经许可不得商用；本项目按个人非商业使用接入，公开可下载不等于无条件商用。
- 分享完整程序时保留引擎许可、权重许可、作者信息与对应源码；本项目自身尚未指定开源许可证，第三方组件不因此失去其原有许可证。
