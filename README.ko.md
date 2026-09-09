# Agent-2D

<p align="center">
  <a href="README.md#english">English</a> ·
  <a href="README.md#japanese">日本語</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.zh-TW.md">繁體中文</a> ·
  <strong>한국어</strong> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.de.md">Deutsch</a> ·
  <a href="README.pt-BR.md">Português (Brasil)</a>
</p>

Agent-2D는 Apple Silicon macOS를 위한 local-first 2D 이미지 처리 엔진입니다. 초해상도, 압축 및 포맷 변환, 사용자 지정 크기/구도, AI 배경 제거, 대화형 오브젝트 편집, raster-to-SVG 벡터화를 하나의 앱에 통합합니다.

Desktop, CLI, MCP는 모두 같은 Rust 처리 코어를 사용하므로 인터페이스마다 서로 다른 이미지 처리 로직을 유지하지 않습니다.

Desktop UI는 **日本語 / English / 简体中文 / 繁體中文 / 한국어 / Español / Français / Deutsch / Português (Brasil)**를 지원합니다. **System**을 선택하면 macOS 선호 언어 목록에서 처음 지원되는 언어를 사용합니다.

## 주요 기능

| 기능 | 설명 | 주요 엔진 |
| --- | --- | --- |
| **Enhance** | 1× / 2× / 4× 초해상도 | Real-ESRGAN + NCNN/Vulkan |
| **Compress** | 해상도를 유지한 압축 및 포맷 변환 | Rust pipeline + 로컬 codec |
| **Optimize** | 초해상도 후 압축 | 공통 Rust pipeline |
| **Custom** | 출력 크기, 구도, Zoom, 위치, Preset, 최대 파일 크기 | 공통 Rust pipeline |
| **Remove BG** | 고품질 투명 배경 추출 | FeyNoBg + alpha matting |
| **Object Edit** | 클릭/제외 클릭/Box 선택, 투명화, 선택 유지, 자연 제거 | SAM 2.1 Base+ + Big-LaMa |
| **Vectorize** | 로고, 아이콘, 선화, 플랫 일러스트를 실제 SVG path로 변환 | VTracer |

PNG, JPEG, WebP, AVIF, JPEG XL 관련 입출력 경로, 다중 포맷 동시 출력, 여러 이미지 일괄 처리, Before / After 비교, 여러 Theme, 사용자 지정 단축키도 지원합니다.

## 요구 환경

현재 개발 및 release 검증 기준은 **Apple Silicon macOS**입니다.

소스에서 빌드하려면 다음이 필요합니다.

- Rust **1.87+**
- Node.js **20+**
- Xcode Command Line Tools

일부 압축/포맷 처리에서는 로컬의 `ffmpeg`, `cwebp`, `cjxl`을 사용합니다. 대형 AI runtime은 Git 저장소에 포함되지 않으며 사용자가 명시적으로 설치할 때만 다운로드됩니다.

## Desktop 빌드

```bash
git clone https://github.com/uniplanck/Agent-2D.git
cd Agent-2D/apps/desktop
npm install
npm run typecheck
npm run release:app
```

생성되는 앱:

```text
target/aarch64-apple-darwin/release/bundle/macos/Agent-2D.app
```

DMG 생성:

```bash
npm run release:mac
```

기본 로컬 빌드는 ad-hoc 서명을 사용합니다. Gatekeeper 경고 없이 제3자에게 배포하려면 Developer ID Application 인증서와 Apple notarization이 필요합니다.

## AI runtime

### 초해상도

```bash
cargo run -p agent2d-cli -- runtime-status
cargo run -p agent2d-cli -- runtime-install
cargo run -p agent2d-cli -- capabilities
```

### 배경 제거

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

`object-bridge`는 Rust 프로세스와 SAM worker를 유지해 반복 선택 시 현재 이미지 embedding을 재사용합니다. MCP Server도 실행 중에는 이 bridge를 자동으로 사용합니다.

## Custom 예시

```bash
cargo run -p agent2d-cli -- custom input.png output.png \
  --width 1080 --height 1350 \
  --zoom 1.2 --x -0.1 --y 0.15 \
  --formats png,jpeg
```

## SVG 벡터화

```bash
cargo run -p agent2d-cli -- vectorize input.png output.svg \
  --preset logo \
  --detail balanced \
  --max-colors 8
```

출력은 원본 raster를 `<image>`로 삽입하는 방식이 아니라 실제 SVG `<path>` geometry가 생성되었는지 검증합니다.

## MCP Server

```bash
cd mcp/server
npm install
npm run typecheck
npm run build
npm run acceptance
```

주요 도구:

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

## Local-first 경계

Real-ESRGAN, FeyNoBg, SAM 2.1, Big-LaMa의 대형 모델 파일은 저장소에 포함되지 않습니다. 사용자가 runtime 설치를 명시적으로 요청했을 때만 upstream 배포처에서 내려받습니다. 필요한 runtime이 준비된 뒤의 일반 이미지 처리는 로컬 실행을 기본으로 합니다.

## License

Agent-2D 자체 소스 코드는 **MIT License**로 공개됩니다. [`LICENSE`](LICENSE)를 확인하세요.

서드파티 라이브러리, codec, runtime binary, AI model weight는 각각의 upstream 라이선스와 약관을 따릅니다. [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)를 확인하세요.

더 자세한 기술 문서는 메인 [`README.md`](README.md)에 있습니다.
