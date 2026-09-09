# AI Super-Resolution Model & Integration Research

更新日: 2026-09-02

## 目的

画像の「画質向上」を、特定アプリの機能としてではなく、複数の自作ツールから再利用できる独立したAI処理基盤として整理する。

Upscaylは実装事例として扱う。目標はUpscaylのUIや製品構造を複製することではなく、内部で成立している次の原理を抽出することにある。

> 低解像度画像 → 学習済み超解像モデルによる推論 → 高解像度画像 → 必要な出力サイズへ整形

この仕組みを `Agent-2D` の共通画像処理能力として切り出せば、壁紙生成、画像編集、サムネイル生成、EC素材、3D/映像制作向けテクスチャ前処理などへ横展開できる。

---

## 1. 結論

最初の実装候補は **Real-ESRGAN系モデル + ncnn + Vulkan** が妥当。

理由は以下。

- 完全ローカル推論が可能
- GPUを使える
- macOS / Windows / Linuxへ展開しやすい
- PyTorch本体をアプリへ抱え込むより配布負荷が小さい
- 画像を外部APIへ送らずに処理できる
- タイル推論で巨大画像にも対応できる
- 複数の学習済みモデルを差し替えられる
- Upscaylという実運用例が存在する

ただし「超解像 = 元画像の真の情報を復元する技術」ではない。

AI超解像は、低解像度画像から高解像度画像を**推定・生成**する。特にGAN系や知覚品質重視モデルは、元画像に存在しなかった微細ディテールを追加する可能性がある。

したがって自作ツールでは、最低でも次の2モードを分けるべきである。

1. **Fidelity**: 元画像忠実度を優先
2. **Perceptual**: 見た目の鮮明さ・ディテール感を優先

---

## 2. 通常の拡大とAI超解像の違い

### 通常の画像拡大

Lanczos、bicubic、bilinearなどは、既存pixel間を数学的に補間する。

```text
Low Resolution
      ↓
Interpolation
      ↓
Larger Resolution
```

画像サイズは増えるが、新しい意味的ディテールはほぼ増えない。

### AI超解像

学習済みニューラルネットワークが、低解像度画像の特徴から高解像度画像を推定する。

```text
Low Resolution Image
        ↓
Pre-processing
        ↓
Super Resolution Neural Network
        ↓
Estimated High Resolution Image
        ↓
Post-processing / Resize / Encode
```

モデルは大量の画像から、例えば次の関係を学習する。

- 細い線が低解像度ではどう潰れるか
- 毛髪や布、雲、岩、星雲などのtexture
- JPEG圧縮ノイズの特徴
- edgeの自然な復元方法
- 高解像度画像を縮小した際に失われる高周波情報

推論時にはその学習結果を使って「この低解像度pixel配置なら、高解像度側はこうである可能性が高い」と推定する。

---

## 3. Real-ESRGANの重要点

Real-ESRGANは、実世界の劣化画像を想定したBlind Super-Resolution系の代表例。

単純なbicubic縮小画像だけではなく、blur、resize、noise、JPEG圧縮などを組み合わせたsynthetic degradationを使って学習する。

概念的には以下。

```text
Clean HR Image
    ↓
Artificial Degradation
  - blur
  - resize
  - noise
  - JPEG artifacts
    ↓
Synthetic LR Image

Synthetic LR → Network → Estimated HR
                         ↑
                 Training Loss
                         ↑
                    Original HR
```

この方式の利点は、現実の低品質画像に対して比較的強いこと。

Real-ESRGANは一般画像・写真・AI生成画像の後処理に向く。一方、極端なblurや完全に失われた文字情報を正確に復元する保証はない。

---

## 4. Upscaylを事例として分解する

Upscayl公式は、AIモデルで画像の詳細を推定し、Real-ESRGANとVulkan系の構成を利用すると説明している。

重要なのはUIではなく、次の分離構造。

```text
Upscayl GUI
    ↓
Model Selection
    ↓
Upscayl / NCNN inference layer
    ↓
NCNN model (.param + .bin)
    ↓
Vulkan GPU compute
    ↓
Upscaled Image
```

Upscaylはcustom NCNN modelも読み込める。つまり製品として重要なのは「1個の固定AI」ではなく、**共通推論基盤 + 差し替え可能なモデル**という構造である。

### Scaleについて

Upscayl公式Guideでは、default modelは基本的にnative x4。x2/x3など非対応scaleは、x4推論後にdownscaleする方式で再現する場合がある。

```text
1536 × 1024
     ↓ x4 AI inference
6144 × 4096
     ↓ downscale
3072 × 2048
```

これは計算量は増えるが、最終出力を直接補間するよりAI復元を挟める。

なお、native x2 modelが存在する場合はx2を直接使う方が計算効率は良い。最終品質はモデルごとにbenchmarkすべきで、倍率だけで優劣は決まらない。

### 注意

Upscaylの画面上のモデル名と内部weightの対応はreleaseで変わり得る。`Upscayl Standard` などの名称を自作ツール側の恒久的なモデル仕様として扱わない。

---

## 5. 自作ツール向け共通アーキテクチャ

超解像を各アプリへ直書きすると保守不能になる。独立engineとして切り出す。

```text
┌─────────────────────┐
│      Host Tool      │
│ CINERA / Agent-2D   │
│ World-Closet / etc. │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ SuperResolution API │
└──────────┬──────────┘
           │
     ┌─────┴─────┐
     ▼           ▼
 ModelRouter   ImageInspector
     │           │
     └─────┬─────┘
           ▼
     PreProcessor
           ↓
     InferenceEngine
           ↓
      PostProcessor
           ↓
        Encoder
```

### 推奨コンポーネント

#### ImageInspector

入力画像を解析する。

- width / height
- alpha有無
- bit depth
- file format
- aspect ratio
- 推定画像種別
- compression artifact量
- blur量
- noise量

#### ModelRouter

画像と目的からmodelを選択する。

```text
photo                  → Real-ESRGAN general
AI-generated wallpaper → Real-ESRGAN / high-detail model
anime / illustration   → anime optimized model
UI / line art          → high-fidelity / sharp-line model
JPEG damaged           → restoration-oriented model
```

最初から自動判定を完璧にする必要はない。

MVPでは `General / Fidelity / Illustration` の3択程度で十分。

#### PreProcessor

- RGB/RGBA変換
- color space整理
- tile分割
- padding
- normalization

#### InferenceEngine

モデルを実行する共通層。

初期候補:

```text
ncnn + Vulkan
```

将来候補:

```text
Core ML       → Apple Silicon最適化
ONNX Runtime  → cross-platform
PyTorch       → 研究・benchmark
TensorRT      → NVIDIA環境
```

#### PostProcessor

- tile merge
- seam低減
- native倍率からtarget sizeへのresize
- sharpening量調整
- denoise
- color preservation

#### Encoder

- PNG
- JPEG
- WebP
- AVIF
- TIFF

などへ出力。

---

## 6. 推論Backend候補

| Backend | 強み | 弱み | 初期採用 |
|---|---|---|---|
| ncnn + Vulkan | 軽量、ローカル、cross-platform、GPU | 対応operator制約 | **最有力** |
| Core ML | Apple Siliconとの親和性 | Apple専用 | NEXT |
| ONNX Runtime | 汎用性、model移植性 | 配布サイズ・GPU backend整理が必要 | NEXT |
| PyTorch | 研究が容易 | アプリ配布には重い | Research |
| TensorRT | NVIDIAで高速 | NVIDIA依存 | Later |

### Macでの考え方

Apple Siliconでは最終的にCore ML benchmarkも行う価値がある。

ただしMVP時点でmacOS専用backendを先に作ると、モデル変換・実装・検証が増える。

最初はUpscaylでも実績のあるncnn/Vulkan系で動く共通engineを作り、その後Core ML版と速度・消費電力・品質を比較する方が合理的。

---

## 7. 研究対象model family

### A. Real-ESRGAN

用途:

- 一般写真
- AI生成画像
- 圧縮画像
- 実世界画像

特徴:

- practical restoration志向
- synthetic degradationを利用
- tile inference対応実装が存在
- ncnn/Vulkan版が存在

**MVP本命。**

### B. SwinIR

Swin Transformerを使った画像復元モデル。

対象:

- classical SR
- lightweight SR
- real-world SR
- denoise
- JPEG artifact reduction

GAN系とは違う比較軸として重要。Fidelityモード候補としてbenchmarkする価値が高い。

### C. HAT

Hybrid Attention Transformer系の高性能画像復元モデル。

高品質benchmark候補だが、MVPの軽量ローカル推論engineとして最初から採用する必要はない。

### D. ESRGAN community models

Upscayl custom modelsのように、用途特化weightを差し替える方式。

- clean image
- compressed image
- illustration
- high-detail

などのmodel presetを後から増やせる。

---

## 8. 「AIで画質が上がった」をどう評価するか

pixel数だけでは評価できない。

最低でも4軸に分ける。

### 1. Fidelity

元画像との整合性。

- PSNR
- SSIM
- LPIPS

ただしreal-world画像にはground truthがないことも多い。

### 2. Perceptual Quality

人間が見た際の自然さ・鮮明さ。

- edge
- texture
- ringing
- oversharpen
- fake details

### 3. Runtime

- latency
- peak memory
- CPU usage
- GPU usage
- energy impact

### 4. Artifact

- tile seam
- halo
- edge distortion
- fake texture
- color shift
- facial deformation
- text corruption

---

## 9. 特に重要な「幻覚」の扱い

超解像AIにはLLMとは別種だが、実質的なhallucination問題がある。

例えば低解像度画像に存在しない毛穴、草、星、布目などをAIが作る場合がある。

これは壁紙では長所になることがある。

一方で次の用途では危険。

- 証拠画像
- 医療画像
- OCR前の文書
- 製品検査
- 正確な顔認証
- scientific image

したがってAPIには最低でも以下を持たせる。

```ts
type SuperResolutionMode =
  | "fidelity"
  | "balanced"
  | "perceptual";
```

ツール側が用途に応じて選べるようにする。

---

## 10. 推奨API contract

ホストアプリとAI実装を分離する。

```ts
interface SuperResolutionRequest {
  inputPath: string;
  outputPath: string;
  targetScale?: 2 | 3 | 4;
  targetWidth?: number;
  targetHeight?: number;
  mode: "fidelity" | "balanced" | "perceptual";
  preset?: "general" | "photo" | "illustration" | "ai-art";
  preserveAlpha?: boolean;
  tileSize?: number;
}

interface SuperResolutionResult {
  inputWidth: number;
  inputHeight: number;
  outputWidth: number;
  outputHeight: number;
  modelId: string;
  backend: string;
  elapsedMs: number;
  warnings: string[];
}
```

ここを固定すればbackendは後から交換できる。

```text
Host App
   ↓
Stable SR Contract
   ↓
Real-ESRGAN / SwinIR / future model
   ↓
ncnn / CoreML / ONNX / future runtime
```

これが「Upscaylの仕組みだけを抜き取る」際の本質。

---

## 11. Model Registryを持つ

model binaryをソースコードへ直結しない。

```json
{
  "id": "realesrgan-general-x4",
  "family": "realesrgan",
  "nativeScale": 4,
  "backend": "ncnn",
  "task": "general",
  "mode": "balanced",
  "modelFiles": [
    "model.param",
    "model.bin"
  ]
}
```

最低でも管理する項目:

- model ID
- model family
- version
- checksum
- native scale
- supported input
- backend
- license
- source URL
- benchmark result

モデルを「なんとなくmodelsフォルダへ入れる」方式にしない。

---

## 12. ライセンス境界

ここは実装前に必ず確認する。

2026-09-02確認時点:

- Upscayl repository: AGPL-3.0
- Real-ESRGAN repository: BSD-3-Clause
- ncnn repository: BSD-3-Clause

ただし、**アプリ本体のlicenseとmodel weightのlicenseは別物**として扱う。

community modelを同梱する場合、各weightの配布条件を個別確認する。

Upscaylのソースコードをそのまま組み込むことと、Real-ESRGAN/ncnnという技術構成を自前実装することは法的意味が異なる。

商用ツールへ入れる場合は、依存コード・weight・学習データ由来条件を分離して監査する。

---

## 13. Agent-2Dでの推奨開発順

### NOW

**Super Resolution Engine MVP**

1. CLI / library boundaryを作る
2. ncnn inference backend
3. Real-ESRGAN系1モデルだけ対応
4. PNG/JPEG入力
5. x2またはx4出力
6. tile inference
7. benchmark fixture 5〜10枚
8. before / after比較

この段階ではGUIを作らない。

### NEXT

- model registry
- General / Fidelity / Illustration
- batch processing
- target resolution指定
- alpha保持
- Core ML backend benchmark

### LATER

- SwinIR
- HAT
- content-aware automatic model routing
- video frame SR
- temporal consistency
- GPU auto-selection
- plugin/API化

### HOLD

- 自前学習
- 巨大diffusion restoration model
- cloud inference infrastructure

既存modelで品質上限を測る前に学習基盤を作るのは費用対効果が悪い。

---

## 14. MVP Acceptance

最初の完成条件は「最高画質」ではなく、再利用できるengine contractの成立。

```text
[ ] 1 command / 1 APIで画像を超解像できる
[ ] host appから独立している
[ ] modelをコード変更なしで差し替えられる
[ ] 1536×1024級画像をMacで安定処理できる
[ ] tile seamが目立たない
[ ] output sizeが正しい
[ ] alpha画像で破綻しない
[ ] benchmark結果を保存できる
[ ] model/version/checksumを追跡できる
[ ] license情報を追跡できる
```

---

## 15. 最終設計原則

この研究で採用すべき軸は、特定のGUIアプリではない。

```text
Model
  ≠ Product

Inference Runtime
  ≠ Model

Super Resolution Engine
  ≠ Host Application
```

分離する。

```text
Host Tool
   ↓
Super Resolution Contract
   ↓
Model Router
   ↓
Inference Backend
   ↓
Model Weight
```

この構造なら、将来Real-ESRGANより優れたモデルが出ても、ツール全体を作り直さずengine内部だけ交換できる。

**長期的な資産になるのはモデルそのものより、この交換可能な境界である。**

---

## 参考一次情報

確認日: 2026-09-02

- Upscayl repository / architecture / FAQ
  - https://github.com/upscayl/upscayl
- Upscayl Guide / custom NCNN models / scale behavior
  - https://github.com/upscayl/upscayl/blob/main/docs/Guide.md
- Upscayl Model Conversion Guide
  - https://github.com/upscayl/upscayl/blob/main/docs/Model-Conversion-Guide.md
- Upscayl custom model repository
  - https://github.com/upscayl/custom-models
- Real-ESRGAN official repository
  - https://github.com/xinntao/Real-ESRGAN
- ncnn official repository
  - https://github.com/Tencent/ncnn
- SwinIR official repository
  - https://github.com/JingyunLiang/SwinIR
- HAT official repository
  - https://github.com/XPixelGroup/HAT
