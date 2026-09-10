# Agent-2D Third-Party Notices

Updated: 2026-09-10

This document records the main third-party boundaries used by Agent-2D v0.1. It is an engineering inventory, not legal advice.

## Real-ESRGAN-ncnn-vulkan

Agent-2D's managed super-resolution runtime downloads the official macOS portable release from the upstream Real-ESRGAN project when the user first invokes an AI-upscale feature or chooses Install/Repair in the Desktop runtime settings.

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

Agent-2D's `Remove BG` operation uses the FeyNoBg model through the upstream NoBg Python library. The application bundle does not vendor the model, PyTorch wheels, or Python inference environment. The Desktop app bootstraps a dedicated portable Python runtime under the user's Agent-2D Application Support directory when the feature is first used (or Install/Repair is selected), then downloads dependencies from their normal upstream package/model channels.

- Model: `feyninc/FeyNobg`
- Pinned model revision: `c1fd67fbefe3efeb78fe2a003270fb5350a0bb1c`
- Model card/license: Apache-2.0
- Model distribution: https://huggingface.co/feyninc/FeyNobg
- Managed model file is approximately 1.05 GB in the current upstream repository.
- Library: `feyninc/nobg` / PyPI `nobg` `0.3.1`
- NoBg upstream license: Apache-2.0
- Repository: https://github.com/feyninc/nobg
- Inference framework: PyTorch `2.14.0` + TorchVision `0.29.0`

The managed installer downloads these assets on demand. Normal background-removal inference is configured with Hugging Face offline mode and runs locally. Agent-2D also downloads a pinned Apple Silicon CPython build from `astral-sh/python-build-standalone` rather than requiring Homebrew or a system Python:

- Packaging project: `astral-sh/python-build-standalone`
- Packaging project license: MPL-2.0
- Source: https://github.com/astral-sh/python-build-standalone
- Pinned build: `cpython-3.10.21+20260901-aarch64-apple-darwin-install_only`
- Archive SHA-256: `cee232aabfb6790eec78f3cca935caeb7bd4eedca4dcb0a10dbcdb4302320b38`
- CPython itself remains governed by the Python Software Foundation / CPython license terms: https://github.com/python/cpython/blob/main/LICENSE

The Python archive is downloaded at runtime rather than embedded in the Agent-2D Release ZIP. A future Agent-2D package that redistributes FeyNoBg weights, NoBg/PyTorch wheels, CPython, or their transitive dependencies must include the applicable license texts, notices, and a complete dependency inventory rather than relying on this engineering summary alone.

## SAM 2.1 Base+ and Big-LaMa object editing

Agent-2D's `Object Edit` operation uses Meta's SAM 2.1 Base+ for interactive point / negative-point / box segmentation and Big-LaMa for optional image inpainting. The application bundle does not vendor either model. First use (or Install/Repair in Settings) reuses the managed FeyNoBg Python/PyTorch environment and downloads only the Object Edit-specific model assets into the user's Agent-2D Application Support directory.

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

## GFPGAN v1.4 face restoration

Agent-2D's `Restore → Face` operation uses TencentARC GFPGAN v1.4. The checkpoint and Python support packages are not embedded in the general-user ZIP; Agent-2D downloads them into its managed Application Support runtime on first use or when Install/Repair is selected.

- Project: `TencentARC/GFPGAN`
- Model: `GFPGANv1.4.pth`
- Upstream repository license: Apache-2.0
- Repository: https://github.com/TencentARC/GFPGAN
- Checkpoint source: https://github.com/TencentARC/GFPGAN/releases/download/v1.3.0/GFPGANv1.4.pth
- Pinned checkpoint SHA-256: `e2cd4703ab14f4d01fd1383a8a8b266f9a5833dacee8e6a79d3bf21a1b6be5ad`
- Python package: `gfpgan` `1.3.8`, with BasicSR / FaceXLib and their transitive dependencies installed into the Agent-2D-managed runtime.

The current integration keeps output dimensions unchanged (`upscale=1`) and uses GFPGAN only for detected face restoration. Review the exact model/checkpoint terms again before any future release that embeds the weights directly instead of downloading them on demand.

## NAFNet image restoration

Agent-2D's `Restore → Denoise` and `Restore → Deblur` operations use the official NAFNet width-32 checkpoints. They are downloaded on demand into the managed restoration runtime and verified by SHA-256 before use.

- Project: `megvii-research/NAFNet`
- Upstream repository license: MIT
- Repository: https://github.com/megvii-research/NAFNet
- Denoise checkpoint: `NAFNet-SIDD-width32.pth`
- Pinned denoise SHA-256: `89c70e808d1783b6c07911306e106aaf0d4f7f3da8c61078b99ff7f8929a26f4`
- Deblur checkpoint: `NAFNet-GoPro-width32.pth`
- Pinned deblur SHA-256: `19394e6155d12ef6371d1d57496f87f0ec88f92bdffa27c0792690722d5d1a5c`

Agent-2D carries a small compatible NAFNet inference definition in the managed runner while the trained weights remain external runtime assets. If another Agent-2D managed Python/PyTorch runtime is already installed it is reused; otherwise Restore prepares its own managed portable Python/PyTorch runtime. Inference runs locally after installation.

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

Agent-2D's general-user Release uses in-process Rust codecs for the normal PNG, JPEG, WebP, AVIF, TIFF, and BMP output paths. AVIF encoding is provided by the Rust `image` AVIF feature and its Rust codec stack rather than a redistributed FFmpeg executable.

Key AVIF encoder dependencies introduced for this path include:

- `ravif` `0.12.x` — BSD-3-Clause — https://github.com/kornelski/cavif-rs
- `rav1e` `0.8.x` — BSD-2-Clause — https://github.com/xiph/rav1e/
- `avif-serialize` `0.8.x` — BSD-3-Clause — https://github.com/kornelski/avif-serialize

External codec executables remain optional adapters rather than general-user prerequisites:

- `cwebp` may be used for target-size lossy WebP; normal WebP remains available through the in-process lossless path.
- `ffmpeg` / `ffprobe` remain useful for some external-codec input/probing paths such as AVIF/JXL source conversion.
- `cjxl` is used for JPEG XL output. JPEG XL is capability-gated and hidden when the required local backend is unavailable.

Agent-2D does **not** redistribute FFmpeg, libjxl/cjxl, or cwebp in the Release ZIP, so users are not silently given third-party executables whose redistribution terms were not reviewed. Missing optional codecs are handled by capability detection instead of requiring Homebrew.

## Agent-2D license

Agent-2D's own source code is licensed under the MIT License. The authoritative project license text is the root [`LICENSE`](LICENSE) file.

That MIT license applies only to Agent-2D's own code and documentation. It does not replace, override, or relicense the third-party software, runtime binaries, Python packages, model weights, or external codec tools listed above; those remain governed by their respective upstream terms.
