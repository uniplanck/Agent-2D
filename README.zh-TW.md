# Agent-2D

<p align="center">
  <a href="README.md#english">English</a> ·
  <a href="README.md#japanese">日本語</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <strong>繁體中文</strong> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.de.md">Deutsch</a> ·
  <a href="README.pt-BR.md">Português (Brasil)</a>
</p>

Agent-2D 是一套面向 Apple Silicon macOS 的 local-first 2D 影像處理引擎。它把超解析度、壓縮與格式轉換、自訂尺寸與構圖、AI 去背、互動式物件編輯，以及 raster-to-SVG 向量化整合在同一個應用程式中。

Desktop、CLI 與 MCP 共用同一套 Rust processing core，因此不同入口不會各自維護另一套影像處理邏輯。

Desktop UI 支援 **日本語 / English / 简体中文 / 繁體中文 / 한국어 / Español / Français / Deutsch / Português (Brasil)**。選擇 **System** 時，會從 macOS 偏好語言清單中使用第一個受支援的語言。

## 下載 Agent-2D

一般 Apple Silicon Mac 使用者請直接下載 **[Agent-2D-macOS-arm64.zip](https://github.com/uniplanck/Agent-2D/releases/latest/download/Agent-2D-macOS-arm64.zip)**：下載 → 解壓縮 → 雙擊 **Agent-2D.app**。是否移到 `/Applications` 都可以。一般 Desktop 使用不需要 Rust、Node.js、Xcode Command Line Tools、Homebrew、npm、cargo 或 Terminal。

目前尚未進行 Apple notarization。若 macOS 阻擋第一次啟動，請 **Control/右鍵點擊 Agent-2D.app → 打開**；若仍被阻擋，前往 **系統設定 → 隱私權與安全性 → 仍要打開**。不需要 Terminal 指令。

第一次使用 Enhance / Restore / Cutout / Object Edit 等 AI 功能時，Agent-2D 會自行準備 Real-ESRGAN、FeyNoBg、SAM 2.1、Big-LaMa、GFPGAN 與 NAFNet；也可在 **Settings → AI Runtime** 查看狀態或執行 Install / Repair。安裝後影像處理會在本機執行。

## 主要功能

| 功能 | 說明 | 主要引擎 |
| --- | --- | --- |
| **Enhance** | 1× / 2× / 4× 超解析度 | Real-ESRGAN + NCNN/Vulkan |
| **Restore** | 修復退化臉部、降低照片雜訊或減少動態模糊，並維持影像尺寸 | GFPGAN v1.4 / NAFNet SIDD / NAFNet GoPro |
| **Compress** | 維持尺寸的壓縮與格式轉換 | Rust pipeline + 本機 codec |
| **Optimize** | 超解析度後接續壓縮 | 共用 Rust pipeline |
| **Custom** | 指定輸出尺寸、構圖、縮放、位置、Preset 與最大檔案大小 | 共用 Rust pipeline |
| **Remove BG** | 高品質透明背景輸出 | FeyNoBg + alpha matting |
| **Object Edit** | 點選/排除點/框選、透明化、保留選區與自然移除 | SAM 2.1 Base+ + Big-LaMa |
| **Vectorize** | 將 Logo、Icon、線稿與平面插畫轉為真正的 SVG path | VTracer |

應用程式亦支援 PNG、JPEG、WebP、AVIF、JPEG XL 的相關輸入輸出路徑、多格式同時匯出、批次輸入、Before / After 比較、多種 Theme 與可自訂快捷鍵。

## 執行環境

目前開發與 release 驗證以 **Apple Silicon macOS** 為基準。

只有從原始碼建置的 Developer / Contributor 需要：

- Rust **1.87+**
- Node.js **20+**
- Xcode Command Line Tools

Release Desktop 的 PNG / JPEG / WebP / AVIF / TIFF / BMP 主要輸出不需要用 Homebrew 手動安裝 codec；AVIF 編碼已內建於 Rust 應用。JPEG XL 等選用路徑在缺少 codec 時會安全隱藏。大型 AI runtime 不塞進 app，而是由 Agent-2D 在第一次使用時自動準備，也可從 Settings → AI Runtime 執行 Install / Repair。

## 從原始碼建置

以下步驟只供 Developer / Contributor。一般使用者請使用上方 Release ZIP。

### 建置 Desktop

```bash
git clone https://github.com/uniplanck/Agent-2D.git
cd Agent-2D/apps/desktop
npm install
npm run typecheck
npm run release:app
```

產生的 App：

```text
target/aarch64-apple-darwin/release/bundle/macos/Agent-2D.app
```

建立 DMG：

```bash
npm run release:mac
```

預設 local build 使用 ad-hoc signing。若要對第三方正式散佈並避免 Gatekeeper 警告，仍需要 Developer ID Application 憑證與 Apple notarization。

## AI runtime

### 超解析度

```bash
cargo run -p agent2d-cli -- runtime-status
cargo run -p agent2d-cli -- runtime-install
cargo run -p agent2d-cli -- capabilities
```

### 去背

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

`object-bridge` 會讓 Rust process 與 SAM worker 保持常駐，重複選取時可以重用目前影像的 embedding。MCP Server 在執行期間會自動使用此 bridge。

## Custom 範例

```bash
cargo run -p agent2d-cli -- custom input.png output.png \
  --width 1080 --height 1350 \
  --zoom 1.2 --x -0.1 --y 0.15 \
  --formats png,jpeg
```

## SVG 向量化

```bash
cargo run -p agent2d-cli -- vectorize input.png output.svg \
  --preset logo \
  --detail balanced \
  --max-colors 8
```

輸出會驗證是否含有真正的 SVG `<path>` geometry，而不是把原始 bitmap 以 `<image>` 形式嵌入。

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

## Local-first 邊界

Real-ESRGAN、FeyNoBg、SAM 2.1 與 Big-LaMa 的大型模型不會提交到 repository 或一般使用者 ZIP。第一次使用相關功能時，Agent-2D 會從 upstream 來源準備需要的 runtime；完成後日常影像處理以本機執行為原則。

## License

Agent-2D 本身的 source code 採用 **MIT License**。請參閱 [`LICENSE`](LICENSE)。

第三方 library、codec、runtime binary 與 AI model weight 仍適用各自 upstream 的授權與條款。請參閱 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

完整技術說明請參閱主 [`README.md`](README.md)。
