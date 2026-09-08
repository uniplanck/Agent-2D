# Agent-2D

<p align="center">
  <a href="README.md#english">English</a> ·
  <a href="README.md#japanese">日本語</a> ·
  <strong>简体中文</strong> ·
  <a href="README.zh-TW.md">繁體中文</a> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.de.md">Deutsch</a> ·
  <a href="README.pt-BR.md">Português (Brasil)</a>
</p>

Agent-2D 是一个面向 Apple Silicon macOS 的本地优先 2D 图像处理引擎。它把超分辨率、压缩与格式转换、自定义尺寸和构图、AI 抠图、交互式物体编辑，以及位图转 SVG 集成在同一个应用中。

Desktop、CLI 与 MCP 共用同一套 Rust 处理核心，因此不同入口不会各自维护一套独立的图像处理实现。

## 主要功能

| 功能 | 说明 | 主要引擎 |
| --- | --- | --- |
| **Enhance** | 1× / 2× / 4× 超分辨率 | Real-ESRGAN + NCNN/Vulkan |
| **Compress** | 保持尺寸的压缩与格式转换 | Rust pipeline + 本地 codec |
| **Optimize** | 超分辨率后继续压缩 | 共用 Rust pipeline |
| **Custom** | 指定输出尺寸、构图、缩放、位置、预设与最大文件大小 | 共用 Rust pipeline |
| **Remove BG** | 高质量透明背景输出 | FeyNoBg + alpha matting |
| **Object Edit** | 点击/排除点击/框选、透明化、保留选区、自然移除 | SAM 2.1 Base+ + Big-LaMa |
| **Vectorize** | 将 Logo、图标、线稿和扁平插画转换为真实 SVG path | VTracer |

应用还支持 PNG、JPEG、WebP、AVIF、JPEG XL 的相关输入输出路径、多格式同时导出、批量输入、Before / After 对比、多种主题与可编辑快捷键。

## 运行环境

当前开发和 release 验证目标为 **Apple Silicon macOS**。

从源码构建需要：

- Rust **1.87+**
- Node.js **20+**
- Xcode Command Line Tools

某些压缩/格式路径会使用本机已安装的 `ffmpeg`、`cwebp` 或 `cjxl`。大型 AI runtime 不包含在 Git 仓库中，只会在用户明确执行安装后下载。

## 构建 Desktop

```bash
git clone https://github.com/uniplanck/Agent-2D.git
cd Agent-2D/apps/desktop
npm install
npm run typecheck
npm run release:app
```

生成的应用位于：

```text
target/release/bundle/macos/Agent-2D.app
```

生成 DMG：

```bash
npm run release:mac
```

默认本地构建使用 ad-hoc 签名。若要向第三方分发并避免 Gatekeeper 警告，需要 Developer ID Application 证书与 Apple notarization。

## AI runtime

### 超分辨率

```bash
cargo run -p agent2d-cli -- runtime-status
cargo run -p agent2d-cli -- runtime-install
cargo run -p agent2d-cli -- capabilities
```

### 背景移除

```bash
cargo run -p agent2d-cli -- bg-runtime-status
cargo run -p agent2d-cli -- bg-runtime-install
cargo run -p agent2d-cli -- remove-bg input.jpg output.png --format png
```

### Object Edit

```bash
cargo run -p agent2d-cli -- object-runtime-status
cargo run -p agent2d-cli -- object-runtime-install
cargo run -p agent2d-cli -- object-mask input.png mask.png --include 320,240 --exclude 80,80 --expand 2 --feather 1
cargo run -p agent2d-cli -- object-edit input.png output.png --action make-selected-transparent --include 320,240 --format png
cargo run -p agent2d-cli -- object-edit input.png filled.png --action remove-and-fill --include 320,240 --format png
cargo run -p agent2d-cli -- object-bridge
```

`object-bridge` 会保持 Rust 进程与 SAM worker 常驻，让重复选择复用当前图像 embedding。MCP Server 运行期间会自动使用该 bridge。

## Custom 示例

```bash
cargo run -p agent2d-cli -- custom input.png output.png \
  --width 1080 --height 1350 \
  --zoom 1.2 --x -0.1 --y 0.15 \
  --formats png,jpeg
```

## SVG 矢量化

```bash
cargo run -p agent2d-cli -- vectorize input.png output.svg \
  --preset logo \
  --detail balanced \
  --max-colors 8
```

输出会验证是否包含真实 SVG `<path>`，而不是把原始位图作为 `<image>` 嵌入。

## MCP Server

```bash
cd mcp/server
npm install
npm run typecheck
npm run build
npm run acceptance
```

主要工具：

```text
agent2d_inspect
agent2d_compress
agent2d_upscale
agent2d_enhance
agent2d_custom
agent2d_remove_background
agent2d_object_select
agent2d_object_edit
agent2d_vectorize
agent2d_optimize
agent2d_capabilities
```

## 本地优先边界

Real-ESRGAN、FeyNoBg、SAM 2.1 与 Big-LaMa 的大型模型文件不会提交到仓库。只有在用户明确执行 runtime 安装后才会从上游来源下载。完成安装后，正常图像处理以本机执行为基本原则。

## License

Agent-2D 自身源码采用 **MIT License**。参见 [`LICENSE`](LICENSE)。

第三方库、codec、runtime binary 与 AI 模型权重仍受各自上游许可和条款约束。参见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

更完整的技术说明请参阅主 [`README.md`](README.md)。
