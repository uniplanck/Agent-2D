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

## Agent-2D 다운로드

일반 Apple Silicon Mac 사용자는 **[Agent-2D-macOS-arm64.zip](https://github.com/uniplanck/Agent-2D/releases/latest/download/Agent-2D-macOS-arm64.zip)** 을 다운로드하고 압축을 푼 뒤 **Agent-2D.app** 을 더블 클릭하면 됩니다. `/Applications`로 옮기는 것은 선택 사항입니다. 일반 Desktop 사용에는 Rust, Node.js, Xcode Command Line Tools, Homebrew, npm, cargo, Terminal이 필요하지 않습니다.

현재 Apple notarization은 적용하지 않았습니다. macOS가 첫 실행을 차단하면 **Control/오른쪽 클릭 Agent-2D.app → 열기**를 사용하고, 계속 차단되면 **시스템 설정 → 개인정보 보호 및 보안 → 그래도 열기**를 사용하세요. Terminal 명령은 필요하지 않습니다.

Enhance / Restore / Cutout / Object Edit 같은 AI 기능을 처음 사용할 때 Agent-2D가 Real-ESRGAN, FeyNoBg, SAM 2.1, Big-LaMa, GFPGAN, NAFNet을 직접 준비합니다. **Settings → AI Runtime**에서도 상태 확인과 Install / Repair가 가능합니다. 설치 후 이미지 처리는 로컬에서 실행됩니다.

## 주요 기능

| 기능 | 설명 | 주요 엔진 |
| --- | --- | --- |
| **Enhance** | 1× / 2× / 4× 초해상도 | Real-ESRGAN + NCNN/Vulkan |
| **Restore** | 손상된 얼굴 복원, 사진 노이즈 제거, 모션 블러 감소를 해상도 유지 상태로 수행 | GFPGAN v1.4 / NAFNet SIDD / NAFNet GoPro |
| **Compress** | 해상도를 유지한 압축 및 포맷 변환 | Rust pipeline + 로컬 codec |
| **Optimize** | 초해상도 후 압축 | 공통 Rust pipeline |
| **Custom** | 출력 크기, 구도, Zoom, 위치, Preset, 최대 파일 크기 | 공통 Rust pipeline |
| **Remove BG** | 고품질 투명 배경 추출 | FeyNoBg + alpha matting |
| **Object Edit** | 클릭/제외 클릭/Box 선택, 투명화, 선택 유지, 자연 제거 | SAM 2.1 Base+ + Big-LaMa |
| **Vectorize** | 로고, 아이콘, 선화, 플랫 일러스트를 실제 SVG path로 변환 | VTracer |

PNG, JPEG, WebP, AVIF, JPEG XL 관련 입출력 경로, 다중 포맷 동시 출력, 여러 이미지 일괄 처리, Before / After 비교, 여러 Theme, 사용자 지정 단축키도 지원합니다.

## 요구 환경

현재 개발 및 release 검증 기준은 **Apple Silicon macOS**입니다.

소스에서 빌드하는 Developer / Contributor에게만 다음이 필요합니다.

- Rust **1.87+**
- Node.js **20+**
- Xcode Command Line Tools

Release Desktop의 PNG / JPEG / WebP / AVIF / TIFF / BMP 주요 출력에는 Homebrew로 codec을 수동 설치할 필요가 없으며 AVIF 인코딩도 Rust 앱에 내장되어 있습니다. JPEG XL 같은 선택 기능은 codec이 없으면 안전하게 숨겨집니다. 대형 AI runtime은 app에 넣지 않고 첫 사용 시 Agent-2D가 자동 준비하며 Settings → AI Runtime에서 Install / Repair도 할 수 있습니다.

## 소스에서 빌드

아래 단계는 Developer / Contributor용입니다. 일반 사용자는 위 Release ZIP을 사용하세요.

### Desktop 빌드

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

Real-ESRGAN, FeyNoBg, SAM 2.1, Big-LaMa의 대형 모델 파일은 저장소나 일반 사용자 ZIP에 포함되지 않습니다. 관련 기능을 처음 사용할 때 Agent-2D가 upstream에서 필요한 runtime을 준비하며, 이후 일반 이미지 처리는 로컬 실행을 기본으로 합니다.

## License

Agent-2D 자체 소스 코드는 **MIT License**로 공개됩니다. [`LICENSE`](LICENSE)를 확인하세요.

서드파티 라이브러리, codec, runtime binary, AI model weight는 각각의 upstream 라이선스와 약관을 따릅니다. [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)를 확인하세요.

더 자세한 기술 문서는 메인 [`README.md`](README.md)에 있습니다.
