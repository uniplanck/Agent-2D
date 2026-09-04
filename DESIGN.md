# Agent-2D Design

更新日: 2026-09-02

## 0. Product Definition

Agent-2Dは、2D画像の「高品質化」と「軽量化」を同じローカルCoreで扱う画像最適化基盤とする。

最初の2本柱は以下。

1. **Super Resolution**: 元画像の構図を維持しながら高解像度化する
2. **Super Compression**: 縦横サイズを維持し、品質制約の範囲内でファイル容量を最小化する

Agent-2Dは単独Desktop Appとして使えるだけでなく、ChatGPT / Codex / GAGなどからMCP Toolとして呼び出せる構造にする。

重要なのは、DesktopとMCPで画像処理ロジックを二重実装しないこと。

```text
Desktop App ─┐
             ├──> Agent-2D Core ───> Image Engines
MCP Server ──┤
             │
CLI ─────────┘
```

`Agent-2D Core` を唯一の処理正本とする。

---

# 1. Goals

## 1.1 NOW

外部へ出せる最小完成物は以下。

> **1枚の画像に対して、超解像・圧縮・超解像+圧縮を同じCore APIから実行し、Desktop / MCPの両方から呼べる。**

初期対応:

- macOS Apple Silicon
- 完全ローカル処理
- PNG / JPEG / WebP / AVIF / JXL入力
- PNG / JPEG / WebP / AVIF / JXL出力
- Real-ESRGAN系超解像
- Exact Lossless圧縮
- Visually Lossless圧縮
- x2 / x4相当の超解像
- Coreは1枚単位処理、Desktopは同じCoreを使う逐次multi-image queue
- progress / cancel
- before / after確認

## 1.2 NEXT

- multi-image個別設定 / 部分再実行
- 複数超解像model
- automatic model routing
- native x2 / x3モデル
- Core ML backend benchmark
- metadata / ICC / HDR対応強化
- shared worker daemon

## 1.3 LATER

- SwinIR / HAT / DAT等の高性能SR
- Neural Image Compression
- Video Super Resolution
- temporal consistency
- Vectorization
- inpainting / outpainting / generative edit
- cloud worker
- Windows / Linux正式配布

## 1.4 HOLD

- 自前foundation model学習
- 自前超解像modelの大規模training
- 巨大diffusion restoration model
- cloud基盤先行開発

既存modelと既存codecで品質上限を測る前にtraining infrastructureを作らない。

---

# 2. Non-Goals for v0.1

Agent-2D v0.1は以下をしない。

- Promptで画像内容を自由に描き換える
- 失われた文字や顔を事実として復元する
- 医療・科学・証拠画像の真実性を保証する
- すべてのHDR / RAW / 16bit形式を完全保持する
- 任意の巨大動画をリアルタイム処理する
- すべてのOSへ同時対応する

超解像は「本来存在した情報の完全復元」ではなく、学習済みmodelによる推定を含む。

---

# 3. Design Principles

## 3.1 Local First

画像は標準では外部へ送信しない。

- inference: local
- compression: local
- metadata inspection: local
- model files: local

ネットワークアクセスはmodel install/updateなど明示操作に限定する。

## 3.2 One Core, Multiple Interfaces

Desktop、MCP、CLIは同じCore contractを使う。

## 3.3 Engine Swappable

ModelやcodecをUIへ直結しない。

```text
Request
  ↓
Stable Contract
  ↓
Router
  ↓
Backend Adapter
  ↓
Actual Model / Codec
```

## 3.4 Quality is Measured, Not Assumed

「AIだから綺麗」「AVIFだから軽い」で判定しない。

- output dimensions
- file bytes
- elapsed time
- pixel equality
- quality metric
- visual fixture
- artifact detection

を記録する。

## 3.5 Never Silently Destroy the Original

- source overwrite禁止をdefault
- outputは別path
- exact losslessはpixel verification
- lossy変換は明示表示

---

# 4. Recommended Technology Stack

## 4.1 Core

**Rust**を第一候補とする。

理由:

- DesktopとCLIの共通Coreにしやすい
- native binary配布が容易
- memory footprintを抑えやすい
- native codec / image libraryとの接続がしやすい
- Tauri backendへ直接組み込める
- MCP側からCLI binaryとして安定して呼べる

## 4.2 Desktop

**Tauri 2 + React + TypeScript**

Desktop側は画像処理ロジックを持たず、Rust Coreのcommandを呼ぶ。

## 4.3 MCP

**TypeScript + Model Context Protocol SDK** を薄いadapterとして使う。

v0.1:

```text
MCP Server
   ↓ JSON request
agent2d CLI
   ↓
agent2d-core
```

最初は1 jobごとのchild processでもよい。

v0.2以降でmodel cacheやbatch性能が必要になった時点でlong-lived local workerへ移行する。

## 4.4 CLI

`agent2d` binaryを持つ。

例:

```text
agent2d inspect image.png
agent2d upscale image.png --scale 2 --preset general
agent2d compress image.png --mode exact
agent2d compress image.png --mode preserve --format avif
agent2d optimize image.png --upscale 2 --compression preserve
```

CLIは人間向けだけではなく、MCP adapterとE2E testの安定境界でもある。

---

# 5. High-Level Architecture

```text
┌──────────────────────────────────────────────┐
│                    Clients                   │
│                                              │
│  Desktop App      MCP Server       CLI       │
└────────┬──────────────┬──────────────┬───────┘
         │              │              │
         └──────────────┼──────────────┘
                        ▼
┌──────────────────────────────────────────────┐
│               Agent-2D Core                  │
│                                              │
│  Request Validation                          │
│  Image Inspector                             │
│  Pipeline Planner                            │
│  Job Manager / Progress / Cancel             │
│  Model Registry                              │
│  Codec Registry                              │
│  Result / Metrics / Verification             │
└───────────────┬──────────────────────────────┘
                │
        ┌───────┴────────┐
        ▼                ▼
┌───────────────┐ ┌──────────────────┐
│ SR Engine     │ │ Compression      │
│               │ │ Engine           │
│ Real-ESRGAN   │ │                  │
│ ncnn/Vulkan   │ │ PNG optimize     │
│ future CoreML │ │ JPEG optimize    │
│ future HAT    │ │ WebP             │
│ future SwinIR │ │ AVIF             │
└───────┬───────┘ │ future JXL       │
        │         └────────┬─────────┘
        └──────────┬───────┘
                   ▼
          Post Process / Encode
                   ↓
              Output File
```

---

# 6. Core Modules

## 6.1 ImageInspector

入力画像を破壊せず解析する。

最低項目:

- format
- width / height
- channels
- alpha
- bit depth
- file size
- orientation
- ICC profile有無
- metadata有無

将来:

- blur score
- noise score
- compression artifact score
- photo / illustration classification
- HDR / SDR

## 6.2 PipelinePlanner

ユーザー要求を具体的な処理列へ落とす。

例:

```text
Request:
  upscale=2
  compression=visually_lossless
  output=avif

Plan:
  Inspect
  → Decode
  → Super Resolution
  → Target Resize
  → AVIF Quality Search
  → Verify
  → Write
```

## 6.3 JobManager

各処理をjobとして管理する。

最低契約:

- jobId
- state
- currentStage
- progress 0-100
- cancel
- elapsedMs
- warnings
- outputPath

DesktopとMCPのprogress表現を共通化する。

---

# 7. Super Resolution Engine

既存研究:

`research/ai-super-resolution/AI_SUPER_RESOLUTION_MODEL_AND_INTEGRATION_RESEARCH.md`

## 7.1 v0.1 Backend

**Real-ESRGAN family + ncnn/Vulkan**

UpscaylのAGPL実装をコピーするのではなく、Real-ESRGAN / ncnn等の上流技術をlicense確認の上で自前adapterから使う。

概念:

```text
Input
 ↓
PreProcessor
 ↓
Model Adapter
 ↓
ncnn/Vulkan inference
 ↓
Tile Merge
 ↓
Target Resize
 ↓
Output
```

## 7.2 SR Modes

ユーザーへmodel名を強制しない。

```text
fidelity
balanced
perceptual
```

MVPでは内部modelが1個でもcontractは先に固定する。

## 7.3 Model Registry

例:

```json
{
  "id": "realesrgan-general-x4",
  "family": "realesrgan",
  "version": "1",
  "nativeScale": 4,
  "backend": "ncnn-vulkan",
  "mode": "balanced",
  "tasks": ["photo", "general", "ai-art"],
  "license": "TO_VERIFY",
  "files": ["model.param", "model.bin"],
  "checksum": "..."
}
```

model binaryとsource codeを分離する。

## 7.4 Tile Inference

大画像を1回でGPUへ渡さない。

```text
Image
 ↓
Tiles + overlap
 ↓
Inference
 ↓
Blend / Merge
```

目的:

- peak memory低減
- M3 Airで安定
- 大画像対応

seamが出ないことをfixtureで検証する。

---

# 8. Super Compression Engine

「超圧縮」は1個のAI modelではなく、**品質条件を守りながら最も小さなencodingを探索するEngine**として設計する。

## 8.1 Compression Modes

### exact

pixel内容を変化させないことを要求する。

```text
mode = exact
```

成功条件:

> decode(original) と decode(output) のcanonical pixel hashが一致する。

formatやbit depthによってexact変換できない場合はfail closedし、勝手にlossyへ落とさない。

### preserve

人間が見た際の差を極小にしながら容量を減らす。

```text
mode = preserve
```

内部ではAVIF / WebP等のquality parameterを探索する。

### compact

容量優先。

```text
mode = compact
```

これはv0.1でUIに出してもよいが、品質保証はpreserveより弱い。

## 8.2 Initial Codec Strategy

### PNG

Exact Lossless候補。

- pixel内容維持
- deflate/filter最適化
- 不要metadata削除は別flag

### JPEG

既存JPEGを再圧縮せず、可能な範囲でlossless optimizationする。

注意:

JPEGそのものが既にlossyであるため、ここでいうexactは「現在decodeされる見た目を新たに劣化させない」境界として扱う。

### WebP

- lossless
- lossy / visually-lossless候補
- alpha対応

### AVIF

主にpreserve / compact用。

高圧縮率が期待できるが、RGB↔YUV・bit depth・ICC等の扱いを検証せず「lossless」と表示しない。

### JPEG XL

NEXT。

技術的にはlossless / lossy双方で有力だが、v0.1の依存と互換性を増やさないため初期必須から外す。

---

# 9. Exact Lossless Verification

「lossless」はencoder option名だけで判定しない。

Agent-2D側で検証する。

```text
Original
  ↓ decode
Canonical Pixel Buffer
  ↓ hash
originalPixelHash

Output
  ↓ decode
Canonical Pixel Buffer
  ↓ hash
outputPixelHash

originalPixelHash == outputPixelHash
```

Canonical bufferには以下を含める。

- width
- height
- channel order
- alpha
- bit depth
- pixel data

v0.1では対応範囲を **8-bit SDR RGB/RGBA** に絞ってよい。

HDR / 10bit / 12bit / 16bitはNEXTで明示対応する。

---

# 10. Visually Lossless / Preserve Strategy

単一quality値を固定しない。

```text
Input
 ↓
Encode candidate q1
 ↓
Quality Measure
 ↓
Encode candidate q2
 ↓
Quality Measure
 ↓
...
 ↓
最小file sizeでthresholdを満たすcandidate
```

探索はbounded binary searchまたは段階探索にする。

測定候補:

- SSIM
- MS-SSIM
- LPIPS
- edge difference
- color shift

v0.1ではmetricを過剰に増やさず、1〜2個 + visual fixturesでよい。

重要:

> target bytesと品質thresholdの両方を満たせない場合、品質を勝手に破壊せず「条件未達」と返す。

---

# 11. Combined Optimize Pipeline

Agent-2Dの価値は2 engineを別々に持つだけではなく、1 pipelineで使えること。

```text
Original
  ↓
Inspect
  ↓
Super Resolution
  ↓
Post Process
  ↓
Compression Search
  ↓
Verification
  ↓
Optimized Output
```

例:

```text
1536×1024 PNG 8MB
 ↓ Real-ESRGAN
3072×2048 internal image
 ↓ preserve compression
3072×2048 AVIF 1.5MB
```

最終容量は画像内容とcodec設定次第なので保証値を固定しない。

---

# 12. Stable Core Contract

## 12.1 Inspect

```ts
interface InspectRequest {
  inputPath: string;
}
```

## 12.2 Upscale

```ts
interface UpscaleRequest {
  inputPath: string;
  outputPath: string;
  scale?: 2 | 3 | 4;
  targetWidth?: number;
  targetHeight?: number;
  mode: "fidelity" | "balanced" | "perceptual";
  preset?: "general" | "photo" | "illustration" | "ai-art";
  modelId?: string;
}
```

## 12.3 Compress

```ts
interface CompressRequest {
  inputPath: string;
  outputPath: string;
  mode: "exact" | "preserve" | "compact";
  format?: "png" | "jpeg" | "webp" | "avif" | "jxl";
  targetBytes?: number;
  preserveMetadata?: boolean;
}
```

## 12.4 Optimize

```ts
interface OptimizeRequest {
  inputPath: string;
  outputPath: string;
  upscale?: {
    scale?: 2 | 3 | 4;
    targetWidth?: number;
    targetHeight?: number;
    mode: "fidelity" | "balanced" | "perceptual";
    modelId?: string;
  };
  compression: {
    mode: "exact" | "preserve" | "compact";
    format?: "png" | "jpeg" | "webp" | "avif" | "jxl";
    targetBytes?: number;
  };
}
```

## 12.5 Result

```ts
interface Agent2DResult {
  jobId: string;
  inputPath: string;
  outputPath: string;
  inputWidth: number;
  inputHeight: number;
  outputWidth: number;
  outputHeight: number;
  inputBytes: number;
  outputBytes: number;
  compressionRatio: number;
  modelId?: string;
  codec?: string;
  pixelExact?: boolean;
  elapsedMs: number;
  warnings: string[];
}
```

このcontractをApp / MCP / CLI共通にする。

---

# 13. MCP Surface

MCPは巨大な万能toolを1個作らず、責務を分ける。

初期候補:

```text
agent2d_inspect
agent2d_upscale
agent2d_compress
agent2d_optimize
agent2d_capabilities
```

### agent2d_inspect

画像のformat / size / alpha / byte size等を返す。

### agent2d_upscale

超解像のみ。

### agent2d_compress

圧縮のみ。

### agent2d_optimize

超解像 + 圧縮pipeline。

### agent2d_capabilities

install済みmodel / codec / backendを返す。

MCP側は画像処理を実装しない。Coreへrequestを渡すだけ。

---

# 14. Desktop UX

MVP画面は1 workspaceでよい。

```text
┌─────────────────────────────────────┐
│ Drop Image                          │
├──────────────┬──────────────────────┤
│ Operation    │ Preview              │
│              │ Before | After       │
│ Enhance      │                      │
│ Compress     │                      │
│ Optimize     │                      │
│              │                      │
├──────────────┴──────────────────────┤
│ Output: 3072×2048 / 1.42MB          │
│ Saved: 78% / pixel exact: no        │
│ [Run] [Cancel]                      │
└─────────────────────────────────────┘
```

必要機能:

- window-wide drag & drop
- single replace / multi-image queue toggle
- before / after preview
- Enhance / Compress / Optimize
- Mode / Model contextual help
- preset
- output format / cross-format conversion
- expected / final file size
- progress
- cancel
- reveal in Finder

高度設定は折りたたむ。

model名・codec parameterを最初から大量に見せない。

---

# 15. Suggested Repository Structure

```text
Agent-2D/
├── DESIGN.md
├── research/
│   └── ai-super-resolution/
│       └── AI_SUPER_RESOLUTION_MODEL_AND_INTEGRATION_RESEARCH.md
│
├── crates/
│   ├── agent2d-core/
│   ├── agent2d-cli/
│   ├── agent2d-image/
│   ├── agent2d-sr/
│   └── agent2d-compression/
│
├── apps/
│   └── desktop/
│
├── mcp/
│   └── server/
│
├── models/
│   ├── registry/
│   └── README.md
│
├── fixtures/
│   ├── sr/
│   └── compression/
│
└── docs/
```

最初から大量にpackageを作る必要はない。

実装開始時は `core / cli / sr / compression` の4境界程度で開始し、必要になったら分離する。

---

# 16. Security / Safety Boundaries

MCPとして使うため、filesystem boundaryを明示する。

- input pathを明示
- source overwrite default禁止
- output parent directory存在確認
- symlink / traversal確認
- output file衝突時はfailまたは明示overwrite flag
- network accessなしがdefault
- model downloadは別操作
- temp file cleanup
- external binary stdout/stderrをbounded capture

AI超解像ではhallucinated detail warningをresultへ含められるようにする。

---

# 17. Licensing Boundary

Upscaylは重要な設計事例だが、そのAGPLコードをAgent-2Dへ直接コピーすることを初期方針にしない。

実装前に以下を依存単位で確認する。

- source code license
- binary redistribution
- model weight license
- codec library license
- attribution requirement
- commercial use

`Model Registry` と `Codec Registry` にlicense fieldを持たせる。

不明なweightは同梱しない。

---

# 18. v0.1 Scope

## NOW

### Core

- Rust workspace
- image inspect
- stable JSON request/result
- job/progress skeleton

### Super Resolution

- Real-ESRGAN系model 1個
- ncnn/Vulkan backend
- PNG/JPEG input
- x2 target / x4 native
- tile inference

### Compression

- PNG exact optimization
- JPEG non-reencode optimization
- WebP lossless
- AVIF preserve
- exact pixel verifier

### Combined

- upscale → compress pipeline

### Interface

- CLI
- MCP thin adapter
- Tauri Desktop thin adapter

### Validation

- 5〜10 SR fixture
- 5〜10 compression fixture
- M3 Air actual benchmark

---

# 19. Acceptance Criteria

Agent-2D v0.1は以下を満たしたとき完成とする。

## Core

- [x] App / MCP / CLIが同じCoreを使う
- [x] source overwriteなし
- [x] progress / cancel contract成立

## Super Resolution

- [x] 1536×1024級PNGをM3 Airで安定処理
- [x] x2 target出力の寸法が正しい
- [x] tile seamが目立たない
- [x] model registry経由でmodelを選べる

## Compression

- [x] dimensionsを変えず圧縮できる
- [x] exact modeはpixel hash一致を検証する
- [x] preserve modeでbefore/after bytesを返す
- [x] 条件未達時に品質を勝手に下げない

## Combined

- [x] 1 requestでupscale + compressできる
- [x] intermediate fileを安全にcleanupする

## Interfaces

- [x] CLI actual PASS
- [x] MCP actual PASS
- [x] Desktop actual PASS

---

# 20. Development Phases

## F1: Core Contract

目的:

> 画像処理engineがまだdummyでも、App/MCP/CLIが共有できるrequest/result contractを成立させる。

成果:

- Rust workspace
- core types
- inspect
- CLI
- tests

## F2: Compression Vertical Slice

最初に圧縮を実装する。

理由:

- AI model download不要
- contract / file safety / verifierを先に確立できる
- App/MCP integrationを早くactual検証できる

成果:

- PNG exact
- WebP lossless
- AVIF preserve
- pixel verifier

## F3: Super Resolution Vertical Slice

成果:

- Real-ESRGAN + ncnn
- tile
- model registry
- benchmark

## F4: Optimize Pipeline

成果:

- SR + Compression直列pipeline
- temp handling
- unified result

## F5: MCP

成果:

- 5 tools
- local filesystem guard
- actual tool acceptance

## F6: Desktop

成果:

- Tauri App
- before/after
- progress/cancel
- output stats

## F7: Quality Closure

成果:

- fixture suite
- M3 Air performance
- artifact review
- packaging

---

# 21. Why Compression Before SR Implementation

全体プロダクトは「超解像 + 超圧縮」だが、実装順は圧縮から始める。

理由:

1. Core contractを軽い処理で検証できる
2. path / temp / output safetyを先に固められる
3. Desktop / MCPの疎通をAI modelなしで作れる
4. pixel exact verifierが後のSR output検証にも再利用できる
5. Real-ESRGAN integration固有の問題とCore問題を分離できる

これは優先順位の都合であり、製品上の主役を圧縮へ変えるという意味ではない。

---

# 22. Architecture Decision

現時点の推奨を1行で固定する。

> **Rust Coreを正本とし、Compression EngineとReal-ESRGAN/ncnn Super Resolution Engineをplugin-like adapterとして接続し、Tauri Desktop・TypeScript MCP・CLIを薄いfront-endとして載せる。**

この構造なら、将来Real-ESRGANをHATへ変えても、AVIFをJXLへ増やしても、Desktop/MCPのcontractを壊さず進化できる。

---

# 23. F8 Production Independence Decision

F8では、Super Resolution runtimeをUpscayl.appのインストール状態から完全に切り離す。

正本runtimeは以下。

```text
Real-ESRGAN official macOS portable release
realesrgan-ncnn-vulkan-20220424
↓ explicit install + SHA-256 verify
~/Library/Application Support/Agent-2D/runtime/
  realesrgan-ncnn-vulkan-20220424/
    realesrgan-ncnn-vulkan
    models/
```

ルール:

- Upscayl.appへのfallbackを持たない
- runtime未導入時はfail closed
- Desktopから明示的にInstall runtime可能
- CLIからruntime-status / runtime-install可能
- download URLとarchive SHA-256をsourceで固定
- image処理中のnetwork accessは禁止
- development overrideはbackend/model dirをpairで明示した場合のみ許可
- runtime/modelの出典とthird-party境界は`THIRD_PARTY_NOTICES.md`へ記録

公式NCNN binaryはUpscayl fork固有の`-z / -r / -w`を持たないため、v0.1 managed runtimeではscale 2/3/4を正本とし、任意target dimensionsはfail closedとする。

F8 actualでは公式`realesrgan-x4plus`を使い、M3 Airで1536×1024→3072×2048を実測する。品質優先runtimeへ独立化した結果、旧Upscayl Lite経路より処理時間が増える場合は性能回帰として記録し、将来のFast model trackで解消する。依存排除を理由に品質や契約を暗黙変更しない。
