# Agent-2D Third-Party Notices

Updated: 2026-09-02

This document records the main third-party boundaries used by Agent-2D v0.1. It is an engineering inventory, not legal advice.

## Real-ESRGAN-ncnn-vulkan

Agent-2D's managed super-resolution runtime downloads the official macOS portable release from the upstream Real-ESRGAN project only after an explicit runtime-install action.

- Project: `xinntao/Real-ESRGAN-ncnn-vulkan`
- Upstream license: MIT
- Source repository: https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan
- License text: https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan/blob/master/LICENSE
- Runtime archive used by Agent-2D:
  https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-macos.zip
- Pinned archive SHA-256:
  `e0ad05580abfeb25f8d8fb55aaf7bedf552c375b5b4d9bd3c8d59764d2cc333a`

The Agent-2D source repository and Tauri application bundle do not vendor this runtime archive in v0.1. The user-triggered installer stores the selected executable and model files under the user's Agent-2D Application Support directory.

## ncnn

Real-ESRGAN-ncnn-vulkan uses Tencent ncnn as its neural-network inference framework.

- Project: `Tencent/ncnn`
- Upstream license: BSD 3-Clause
- Repository: https://github.com/Tencent/ncnn
- License: https://github.com/Tencent/ncnn/blob/master/LICENSE.txt

ncnn's own license file also enumerates third-party components and their respective notices. Any future Agent-2D package that redistributes ncnn-derived binaries should retain the applicable upstream notices.

## Real-ESRGAN model/project assets

The managed runtime archive contains model assets distributed by the Real-ESRGAN project.

- Project: `xinntao/Real-ESRGAN`
- Upstream repository license: BSD 3-Clause
- Repository: https://github.com/xinntao/Real-ESRGAN
- License: https://github.com/xinntao/Real-ESRGAN/blob/master/LICENSE

Current logical model choices exposed by Agent-2D from the pinned official runtime are:

- `realesrgan-x4plus`
- `realesrgan-x4plus-anime`
- `realesr-animevideov3` (multi-scale x2/x3/x4 files presented as one logical model)

Model and dataset terms can be more specific than a repository-level software license. Before redistributing model files inside a future installer rather than downloading the official release at user request, perform a release-specific model/license review and include the applicable texts.

## Tauri and Rust/JavaScript dependencies

Agent-2D Desktop uses Tauri 2, React, Vite, and their dependency graphs. Cargo and npm lockfiles pin the dependency set used to build v0.1. A public binary distribution should generate a complete software-bill-of-materials/license report from those lockfiles before release.

## Compression backends

Agent-2D currently uses:

- Rust `image`/PNG code for Exact PNG processing.
- `cwebp` when WebP Lossless is requested.
- `ffmpeg` / `ffprobe` with `libaom-av1` when AVIF Preserve is requested.

These external codec executables are discovered from the local system in v0.1 and are not bundled by Agent-2D. A future fully self-contained public distribution should either bundle compatible codec implementations with their notices or replace these adapters with in-process codecs.

## Agent-2D license

No public distribution license for Agent-2D itself has been declared yet. Do not infer a project license from any dependency listed above.
