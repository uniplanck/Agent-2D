# Agent-2D

<p align="center">
  <a href="#english"><kbd>English</kbd></a>
  <a href="#japanese"><kbd>日本語</kbd></a>
</p>

<p align="center">
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.zh-TW.md">繁體中文</a> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.de.md">Deutsch</a> ·
  <a href="README.pt-BR.md">Português (Brasil)</a>
</p>

---

<a id="english"></a>

## English

Agent-2D is a local-first 2D image processing engine for macOS Apple Silicon. It combines super resolution, compression and format conversion, custom framing, AI background removal, interactive object editing, and raster-to-SVG vectorization in one application.

The same Rust processing core powers the Desktop app, CLI, and MCP server. Image processing does not silently move to a cloud service.

### What Agent-2D can do

| Capability | What it does | Main engine |
| --- | --- | --- |
| **Enhance** | 1× / 2× / 4× AI super resolution or deterministic **Crisp Graphics** scaling for tiny logos/icons, with optional compression after enhancement | Real-ESRGAN + NCNN/Vulkan / local edge-preserving scaler + shared Rust compression pipeline |
| **Compress** | Compress or convert while preserving dimensions | Rust image pipeline + local codecs |
| **Custom** | Exact output size, framing, zoom, position, ⅛× / ¼× / ½× / 1× / 2× / 4× source-relative presets, Custom scale, and optional target file size | Shared Rust pipeline |
| **Cutout** | Two sidebar modes: automatic background removal or click/box object editing and erase-and-fill | FeyNoBg / SAM 2.1 Base+ + Big-LaMa |
| **Vectorize** | Convert logos, icons, line art, and flat illustrations to real SVG paths | VTracer |

Agent-2D uses PNG, JPEG, WebP, AVIF, and JPEG XL as its five primary formats. TIFF and BMP are also supported as optional lossless formats and can be shown or hidden from **Settings → Output Formats**. The Desktop app automatically hides codec-dependent formats when their required local backend is unavailable. **Optimize is no longer a separate Desktop tab**: use **Enhance → Compress after enhancement** to run the same super-resolution → compression pipeline. The CLI/MCP optimize contract remains available. Multi-format export, batch input, Before/After comparison, configurable keyboard shortcuts, multiple UI themes, and Japanese/English application UI are included.

### Interfaces

All three interfaces use the same core processing contract:

- **Desktop**: Tauri 2 + React
- **CLI**: `agent2d`
- **MCP**: TypeScript stdio server

The Desktop and MCP layers do not maintain separate image-processing implementations.

### Requirements

Current development and release validation targets **macOS on Apple Silicon**.

For a source build, install:

- Rust **1.87+**
- Node.js **20+**
- Xcode Command Line Tools

Some compression/format paths discover local codec tools such as `ffmpeg`, `cwebp`, or `cjxl`. Optional AI runtimes are installed explicitly by Agent-2D and are not committed to this repository.

### Quick start: Desktop

```bash
git clone https://github.com/uniplanck/Agent-2D.git
cd Agent-2D/apps/desktop
npm install
npm run typecheck
npm run release:app
```

The generated app bundle is created under:

```text
target/release/bundle/macos/Agent-2D.app
```

For a DMG build:

```bash
npm run release:mac
```

The default local build uses ad-hoc signing. A public macOS binary that opens without Gatekeeper warnings requires a valid Developer ID Application certificate and Apple notarization credentials.

### Optional AI runtimes

Agent-2D keeps large model/runtime assets outside the app bundle and downloads them only after an explicit install action.

#### Super resolution

```bash
cargo run -p agent2d-cli -- runtime-status
cargo run -p agent2d-cli -- runtime-install
cargo run -p agent2d-cli -- capabilities
```

Managed runtime location:

```text
~/Library/Application Support/Agent-2D/runtime/realesrgan-ncnn-vulkan-20220424
```

The Real-ESRGAN archive is pinned by SHA-256 in the implementation and downloaded from the upstream project.

For tiny logos, icons, UI marks, or flat graphics where photo-oriented AI can soften edges or invent texture, choose **Crisp Graphics** in the Desktop Content selector or use `--preset graphics` from CLI/MCP. This route deliberately bypasses Real-ESRGAN and uses a deterministic edge-preserving resize plus light sharpening. It cannot reconstruct detail that is absent from the source, but it avoids turning a tiny graphic into a larger blur.

```bash
cargo run -p agent2d-cli -- enhance tiny-logo.png crisp.png --scale 4 --preset graphics --format png
```

#### Background removal

```bash
cargo run -p agent2d-cli -- bg-runtime-status
cargo run -p agent2d-cli -- bg-runtime-install
cargo run -p agent2d-cli -- remove-bg input.jpg output.png --format png
```

Agent-2D uses `feyninc/FeyNobg` through the upstream `nobg` library. Normal inference is configured for local/offline use after installation and prefers Apple MPS with a CPU fallback.

#### Object Edit

```bash
cargo run -p agent2d-cli -- object-runtime-status
cargo run -p agent2d-cli -- object-runtime-install
cargo run -p agent2d-cli -- object-mask input.png mask.png --include 320,240 --exclude 80,80 --expand 2 --feather 1
cargo run -p agent2d-cli -- object-edit input.png output.png --action make-selected-transparent --include 320,240 --format png
cargo run -p agent2d-cli -- object-edit input.png filled.png --action remove-and-fill --include 320,240 --format png
cargo run -p agent2d-cli -- object-bridge
```

`object-bridge` keeps the Rust process and SAM worker alive so repeated selections can reuse the active image embedding. The MCP server uses this persistent bridge automatically while the server process is alive.

### Custom framing and multi-format output

Custom mode supports exact dimensions or a source-relative multiplier. The Desktop exposes quick source-relative presets for **⅛×, ¼×, ½×, 1×, 2×, and 4×**, plus an editable Custom multiplier.

```bash
# Exact 1080 × 1350 frame with two output formats
cargo run -p agent2d-cli -- custom input.png output.png \
  --width 1080 --height 1350 \
  --zoom 1.2 --x -0.1 --y 0.15 \
  --formats png,jpeg

# Source-relative 2× with a 1 MiB output cap
cargo run -p agent2d-cli -- custom input.png output.png \
  --source-scale 2 \
  --formats jpeg,webp \
  --max-bytes 1048576
```

When multiple formats are selected, Agent-2D writes tagged sibling outputs such as `output-png.png` and `output-jpg.jpg`.

### Vectorize to SVG

Vectorization is separate from super resolution. It targets shape-driven images rather than photography.

```bash
cargo run -p agent2d-cli -- vectorize input.png output.svg \
  --preset logo \
  --detail balanced \
  --max-colors 8
```

Generated SVG output is validated to contain real `<path>` geometry rather than an embedded raster `<image>`.

### MCP server

```bash
cd mcp/server
npm install
npm run typecheck
npm run build
npm run acceptance
```

Current MCP tools:

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

### Local-first boundary

Agent-2D does not bundle the large Real-ESRGAN, FeyNoBg, SAM 2.1, or Big-LaMa model assets in the Git repository. Managed installers fetch those assets only after a user explicitly requests installation. Normal processing is designed to stay on the local machine after the required runtime is present.

### Validation

The current project validation includes:

- PNG/WebP/JXL exact-output fixtures and AVIF/JPEG preserve-oriented fixtures
- PNG/JPEG/WebP/AVIF/JXL input inspection and conversion paths
- Real-ESRGAN logical model routing
- real process cancellation and partial-output cleanup
- Desktop typecheck/build and native arm64 app launch
- path-based SVG verification
- FeyNoBg transparent-output verification when its runtime is installed
- SAM 2.1 selection, transparent Object Edit, and Big-LaMa erase-and-fill E2E when the runtime is installed
- MCP stdio acceptance tests

### License

Agent-2D's own source code is released under the **MIT License**. See [`LICENSE`](LICENSE).

Third-party libraries, local codec executables, runtime binaries, and AI model weights retain their own upstream licenses and terms. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

---

<a id="japanese"></a>

## 日本語

画像処理の機能を増やしていくと、超解像はこのアプリ、圧縮は別ツール、背景透過はWebサービス、物体削除はさらに別のAI、と処理が分散しがちです。Agent-2Dは、その分散をローカルの一つの処理基盤へ戻すためのmacOS向け2D画像エンジンです。

超解像、圧縮・形式変換、サイズと構図の調整、AI背景透過、クリックによる物体編集、SVGベクター化までを一つのアプリにまとめています。Desktop、CLI、MCPは見た目こそ違いますが、内部では同じRustコアを共有します。Desktopだけ別処理、MCPだけ別品質、という分岐を作らない構成です。

### できること

| 機能 | 内容 | 主なエンジン |
| --- | --- | --- |
| **Enhance** | 1× / 2× / 4×のAI超解像、または極小ロゴ/アイコン向けの**Crisp Graphics**拡大。必要なら超解像後の圧縮も同時実行 | Real-ESRGAN + NCNN/Vulkan / ローカル輪郭保持scaler + 共通Rust圧縮pipeline |
| **Compress** | 解像度を維持した圧縮・形式変換 | Rust画像処理 + ローカルcodec |
| **Custom** | 指定サイズ、構図、Zoom、位置、⅛× / ¼× / ½× / 1× / 2× / 4×の倍率Preset、Custom倍率、最大ファイル容量 | 共通Rust pipeline |
| **Cutout** | サイドバーの2モードから、自動背景透過またはクリック/Box選択・透明化・自然削除を選ぶ | FeyNoBg / SAM 2.1 Base+ + Big-LaMa |
| **Vectorize** | ロゴ・アイコン・線画・フラットイラストをSVG pathへ変換 | VTracer |

主要形式はPNG、JPEG、WebP、AVIF、JPEG XLの5種です。加えてTIFFとBMPをlossless形式として利用でき、**設定 → 出力形式**から表示/非表示を切り替えられます。Desktopでは必要なローカルcodec backendが存在しない形式を自動で非表示にします。**OptimizeはDesktopの独立タブから外し、Enhance内の「圧縮も一緒に実行」に統合**しました。CLI / MCPのoptimize contractは互換性のため残しています。処理内容に応じて複数形式の同時書き出しや複数画像の一括処理もでき、Before / After比較、Theme切替、編集可能なKeyboard Shortcut、日本語/英語UIも利用できます。

### なぜローカルで動かすのか

画像を扱うたびに外部サービスへアップロードする構成は便利ですが、処理の再現性、待ち時間、ネットワーク依存、画像の扱いを一つずつ外部へ預けることになります。Agent-2Dでは、大きなAIモデルも含め、必要なruntimeを一度明示的に導入したあとはローカル処理を基本にしています。

ただし、最初のruntime導入時には上流の配布元からモデルや依存パッケージを取得します。リポジトリ自体に1GB級のモデルを埋め込んでいるわけではありません。この境界は、アプリを軽く保つためだけでなく、各モデルの配布条件をAgent-2D本体のMIT Licenseと混同しないためにも重要です。

### 構成

処理コアは共通です。

- **Desktop**: Tauri 2 + React
- **CLI**: `agent2d`
- **MCP**: TypeScript stdio server

AI AgentからMCPを使う場合も、Desktopとは別の簡易版処理へ落としません。同じ処理契約を別の入口から呼び出します。

### 動作環境

現在の開発・release検証は **Apple Silicon搭載macOS** を基準にしています。

Sourceからbuildする場合は、少なくとも次を用意してください。

- Rust **1.87以上**
- Node.js **20以上**
- Xcode Command Line Tools

圧縮形式によっては、ローカル環境の`ffmpeg`、`cwebp`、`cjxl`などを利用します。Real-ESRGAN、FeyNoBg、SAM 2.1、Big-LaMaの大きなruntimeは別途明示的に導入します。

### Desktopをbuildする

```bash
git clone https://github.com/uniplanck/Agent-2D.git
cd Agent-2D/apps/desktop
npm install
npm run typecheck
npm run release:app
```

生成されるapp bundle:

```text
target/release/bundle/macos/Agent-2D.app
```

DMGを作る場合:

```bash
npm run release:mac
```

通常のローカルbuildはad-hoc署名です。第三者へGatekeeper警告なしで配布するには、Developer ID Application証明書とApple notarizationが別途必要です。

### 超解像runtime

```bash
cargo run -p agent2d-cli -- runtime-status
cargo run -p agent2d-cli -- runtime-install
cargo run -p agent2d-cli -- capabilities
```

保存先:

```text
~/Library/Application Support/Agent-2D/runtime/realesrgan-ncnn-vulkan-20220424
```

Real-ESRGANのruntimeは上流releaseから取得し、実装側でSHA-256を固定しています。

極小ロゴ、アイコン、UI記号、ベタ塗りグラフィックでは、写真向けAI超解像が境界を丸めたり、元にない質感を足したりすることがあります。**Crisp Graphics**はその用途を分離した経路です。Real-ESRGANを通さず、輪郭を保つリサイズと軽いsharp処理だけで拡大します。存在しない細部を復元する機能ではありませんが、「小さなモヤをAIでもっと大きなモヤにする」挙動を避けたいときに向いています。

```bash
cargo run -p agent2d-cli -- enhance tiny-logo.png crisp.png --scale 4 --preset graphics --format png
```

### 背景透過runtime

```bash
cargo run -p agent2d-cli -- bg-runtime-status
cargo run -p agent2d-cli -- bg-runtime-install
cargo run -p agent2d-cli -- remove-bg input.jpg output.png --format png
```

背景透過には`feyninc/FeyNobg`を使用します。導入後の通常推論はローカル/オフライン前提で、Apple MPSを優先し、利用できない場合はCPUへfallbackします。

### Object Edit

Object Editは「画像全体を編集する」のではなく、まずSAM 2.1で対象を特定し、そのmaskへ処理を適用します。対象へクリック、除外したい場所へnegative point、広い対象にはBoxを与えられます。maskは拡張/縮小とFeatherで調整できます。

```bash
cargo run -p agent2d-cli -- object-runtime-status
cargo run -p agent2d-cli -- object-runtime-install
cargo run -p agent2d-cli -- object-mask input.png mask.png --include 320,240 --exclude 80,80 --expand 2 --feather 1
cargo run -p agent2d-cli -- object-edit input.png output.png --action make-selected-transparent --include 320,240 --format png
cargo run -p agent2d-cli -- object-edit input.png filled.png --action remove-and-fill --include 320,240 --format png
cargo run -p agent2d-cli -- object-bridge
```

`object-bridge`はSAMを毎回cold startさせないための常駐経路です。同じprocess内で画像embeddingを再利用でき、MCP Serverも起動中はこのbridgeを利用します。

### Customと複数形式書き出し

Customでは、固定のpxサイズだけでなく、元画像基準の倍率も使えます。Desktopには**⅛×、¼×、½×、1×、2×、4×**の即時Presetと、任意倍率を入力するCustom欄があります。

```bash
# 1080 × 1350へ構図を合わせ、PNGとJPEGを同時出力
cargo run -p agent2d-cli -- custom input.png output.png \
  --width 1080 --height 1350 \
  --zoom 1.2 --x -0.1 --y 0.15 \
  --formats png,jpeg

# 元画像の2×、各出力を最大1 MiBへ
cargo run -p agent2d-cli -- custom input.png output.png \
  --source-scale 2 \
  --formats jpeg,webp \
  --max-bytes 1048576
```

複数形式を選んだ場合は、`output-png.png`、`output-jpg.jpg`のように形式名を付けた兄弟ファイルとして保存します。

### SVGベクター化

Vectorizeは超解像とは別物です。写真を「無限解像度」にする機能ではなく、形状が主役の画像をSVG pathとして再構成する処理です。

```bash
cargo run -p agent2d-cli -- vectorize input.png output.svg \
  --preset logo \
  --detail balanced \
  --max-colors 8
```

出力SVGには埋め込みraster画像ではなく、実際の`<path>` geometryが存在することを検証します。

### MCP Server

```bash
cd mcp/server
npm install
npm run typecheck
npm run build
npm run acceptance
```

利用できる主なtool:

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

### 検証範囲

現行projectでは、PNG/WebP/JXLのexact出力、AVIF/JPEGのpreserve系出力、各形式のinspection/変換、Real-ESRGAN routing、process cancelと途中ファイル削除、native arm64 Desktop build、SVG path検証、FeyNoBg背景透過、SAM 2.1 + Big-LaMa Object Edit、MCP stdio acceptanceまでを検証対象にしています。

AI runtimeが必要なE2Eは、そのruntimeが導入済みの環境で実行します。テストがあることと、すべての外部modelをリポジトリへ同梱していることは別です。

### License

Agent-2D本体のsource codeは **MIT License** です。 [`LICENSE`](LICENSE) を参照してください。

一方、利用しているlibrary、codec、runtime binary、AI model weightには、それぞれ上流のlicenseや利用条件があります。Agent-2DのMIT Licenseがそれらを上書きすることはありません。現在の境界は [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) に整理しています。
