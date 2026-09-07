# Agent-2D Third-Party Notices

Updated: 2026-09-05

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

## FeyNoBg background-removal model and managed Python runtime

Agent-2D's `Remove BG` operation uses the FeyNoBg model through the upstream NoBg Python library. The application bundle does not vendor the model or Python inference environment. An explicit user install action creates a dedicated runtime under the user's Agent-2D Application Support directory and downloads the dependencies from their normal upstream package/model channels.

- Model: `feyninc/FeyNobg`
- Pinned model revision: `c1fd67fbefe3efeb78fe2a003270fb5350a0bb1c`
- Model card/license: Apache-2.0
- Model distribution: https://huggingface.co/feyninc/FeyNobg
- Managed model file is approximately 1.05 GB in the current upstream repository.
- Library: `feyninc/nobg` / PyPI `nobg` `0.3.1`
- NoBg upstream license: Apache-2.0
- Repository: https://github.com/feyninc/nobg
- Inference framework: PyTorch `2.14.0` + TorchVision `0.29.0`

The managed installer downloads these assets only after an explicit install action. Normal background-removal inference is configured with Hugging Face offline mode and runs locally. A future Agent-2D package that redistributes FeyNoBg weights, NoBg/PyTorch wheels, or their transitive Python dependencies must include the applicable license texts, notices, and a complete dependency inventory rather than relying on this engineering summary alone.

## SAM 2.1 Base+ and Big-LaMa object editing

Agent-2D's `Object Edit` operation uses Meta's SAM 2.1 Base+ for interactive point / negative-point / box segmentation and Big-LaMa for optional image inpainting. The application bundle does not vendor either model. An explicit Object Edit runtime install reuses the existing FeyNoBg Python/PyTorch environment and downloads only the Object Edit-specific model assets into the user's Agent-2D Application Support directory.

- Segmentation model: `facebook/sam2.1-hiera-base-plus`
- Pinned Hugging Face revision used by Agent-2D: `b732075`
- SAM 2 repository/license: Apache-2.0
- Repository: https://github.com/facebookresearch/sam2
- Model distribution: https://huggingface.co/facebook/sam2.1-hiera-base-plus
- Inpainting checkpoint: Big-LaMa `big-lama.pt`
- Agent-2D download source: https://github.com/enesmsahin/simple-lama-inpainting/releases/download/v0.1.0/big-lama.pt
- LaMa upstream repository/license: https://github.com/advimman/lama / Apache-2.0
- Wrapper release source: https://github.com/enesmsahin/simple-lama-inpainting

Normal SAM inference is configured with Hugging Face offline mode after installation. The local implementation loads Big-LaMa directly as a TorchScript checkpoint rather than adding OpenCV or the full simple-lama-inpainting Python package. Before redistributing SAM or LaMa model files in a public Agent-2D package, verify the exact checkpoint terms and include the applicable license and notice material.

## Tauri and Rust/JavaScript dependencies

Agent-2D Desktop uses Tauri 2, React, Vite, and their dependency graphs. Cargo and npm lockfiles pin the dependency set used to build v0.1. A public binary distribution should generate a complete software-bill-of-materials/license report from those lockfiles before release.

## VTracer vectorization

Agent-2D's `Vectorize to SVG` operation embeds the Rust `vtracer` framework as a build dependency and uses it in-process to trace raster illustrations, logos, icons, and line art into real SVG paths.

- Crate: `vtracer` `1.0.0-alpha.4`
- Project: `visioncortex/vtracer`
- Upstream license: MIT OR Apache-2.0
- Repository: https://github.com/visioncortex/vtracer/
- Crates.io: https://crates.io/crates/vtracer/1.0.0-alpha.4

Unlike the optional Real-ESRGAN runtime, VTracer is linked into builds through Cargo. A future public binary distribution should therefore include the applicable VTracer and transitive dependency notices generated from `Cargo.lock`.

## Compression backends

Agent-2D currently uses:

- Rust `image`/PNG code for Exact PNG processing and PNG/JPEG/WebP decoding where supported.
- `cwebp` when WebP Lossless is requested.
- `ffmpeg` / `ffprobe` with `libaom-av1` when AVIF Preserve is requested, for high-quality JPEG output, and for AVIF/JXL probing or intermediate decoding where required.
- `cjxl` from the JPEG XL / libjxl toolchain when JXL Lossless is requested. JXL output is verified against decoded pixels before success is reported.

These external codec executables are discovered from the local system and are not bundled by Agent-2D. The current source changes therefore do not add libjxl, FFmpeg, WebP, or AV1 binaries to the application bundle. A future fully self-contained public distribution must review the exact redistributed codec builds and include all applicable upstream license texts/notices, or replace these adapters with audited in-process codecs.

## Agent-2D license

No public distribution license for Agent-2D itself has been declared yet. Do not infer a project license from any dependency listed above.
