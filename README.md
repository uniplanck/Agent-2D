# Agent-2D

Agent-2D is a local-first 2D image optimization engine for macOS Apple Silicon.

The v0.1 product has five primary capability families:

- **Super Resolution**: Real-ESRGAN / NCNN / Vulkan based image upscaling.
- **Super Compression**: exact or preserve-oriented image compression without changing pixel dimensions.
- **Background Removal**: FeyNoBg foreground extraction + alpha matting with transparent PNG/WebP output.
- **Object Edit**: SAM 2.1 Base+ point/negative-point/box selection with mask expansion/feathering, transparent object isolation/removal, and optional Big-LaMa inpainting.
- **Vectorize to SVG**: in-process VTracer conversion from raster logos, icons, line art, and flat illustrations into real SVG paths.

Super Resolution and Super Compression can be combined as **Optimize = Super Resolution → Compression**. Background removal, object editing, and vectorization are separate representation-oriented operations and do not silently enter the SR/compression path.

## Interfaces

All interfaces share the same Rust processing core.

- Desktop: Tauri 2 + React
- CLI: `agent2d`
- MCP: TypeScript stdio server

The Desktop and MCP layers do not contain independent image-processing implementations.

## Managed Super-Resolution Runtime

Agent-2D does **not** require Upscayl.

The managed runtime is installed explicitly into:

```text
~/Library/Application Support/Agent-2D/runtime/realesrgan-ncnn-vulkan-20220424
```

It is downloaded directly from the official Real-ESRGAN GitHub release and is pinned by SHA-256:

```text
source:
https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-macos.zip

sha256:
e0ad05580abfeb25f8d8fb55aaf7bedf552c375b5b4d9bd3c8d59764d2cc333a
```

The official macOS executable is a universal Mach-O containing both `arm64` and `x86_64` slices.

Install or inspect it from the CLI:

```bash
cargo run -p agent2d-cli -- runtime-status
cargo run -p agent2d-cli -- runtime-install
cargo run -p agent2d-cli -- capabilities
```

The Desktop app also exposes an explicit **Install runtime** action when the managed runtime is absent. Network access is therefore limited to an explicit runtime installation action; normal image processing stays local.

CLI Custom parity is available through numeric parameters. `--source-scale` derives the target dimensions from the input while `--width` + `--height` selects an exact frame. Multiple formats use tagged sibling outputs such as `output-png.png` / `output-jpg.jpg`.

```bash
# exact custom frame
cargo run -p agent2d-cli -- custom input.png output.png --width 1080 --height 1350 --zoom 1.2 --x -0.1 --y 0.15 --formats png,jpeg

# source-relative 2× with a 1 MiB maximum per output
cargo run -p agent2d-cli -- custom input.png output.png --source-scale 2 --formats jpeg,webp --max-bytes 1048576
```

`enhance`, `compress`, and `optimize` accept legacy `--format <one>` or App-style `--formats png,jpeg,...` multi-output selection. `compress` and `optimize` also expose `--target-bytes`; when no explicit compression mode is supplied, the CLI chooses the same safe format-oriented default used by the Desktop flow, and a target byte limit selects Compact encoding.

Environment overrides remain available for development/testing and must be supplied as a pair:

```text
AGENT2D_SR_BACKEND
AGENT2D_SR_MODEL_DIR
```

`AGENT2D_RUNTIME_ROOT` can override the parent directory used by the managed installer.

## Managed Background-Removal Runtime

Agent-2D uses `feyninc/FeyNobg` through the upstream `nobg` Python library. The model is not embedded in the application bundle. An explicit install action creates a dedicated Python environment and model cache under:

```text
~/Library/Application Support/Agent-2D/runtime/feynobg-nobg-0.3.1-torch-2.14.0
```

Pinned runtime contract:

```text
model:       feyninc/FeyNobg
revision:    c1fd67fbefe3efeb78fe2a003270fb5350a0bb1c
NoBg:        0.3.1
PyTorch:     2.14.0
TorchVision: 0.29.0
```

The installer requires a local Python 3.10+ interpreter for bootstrapping. It downloads Python packages and the FeyNoBg weights only during the explicit install action. Normal inference sets `HF_HUB_OFFLINE=1`, uses Apple MPS when available with a CPU fallback, and does not require a network connection.

CLI management and processing:

```bash
cargo run -p agent2d-cli -- bg-runtime-status
cargo run -p agent2d-cli -- bg-runtime-install
cargo run -p agent2d-cli -- remove-bg input.jpg output.png --format png
cargo run -p agent2d-cli -- remove-bg input.jpg output.webp --format webp
```

`AGENT2D_BG_RUNTIME_ROOT` can point to an existing compatible runtime for development/testing, `AGENT2D_BG_BOOTSTRAP_PYTHON` can select the Python used by the installer, and `AGENT2D_BG_DEVICE=auto|mps|cpu` controls inference routing.

## Managed Object-Edit Runtime

`Object Edit` uses `facebook/sam2.1-hiera-base-plus` for point / negative-point / box prompting and Big-LaMa for optional erase-and-fill. Agent-2D reuses the already-installed FeyNoBg Python/PyTorch runtime instead of installing a second PyTorch stack. The Object Edit-specific assets live under:

```text
~/Library/Application Support/Agent-2D/runtime/object-edit-sam2.1-base-plus-lama-v1
```

The SAM model is pinned to revision `b732075`. Normal prompt inference uses the local Hugging Face cache in offline mode. On macOS, SAM uses MPS with a one-time CPU fallback. LaMa now prefers MPS when available and automatically retries on CPU if the TorchScript/operator path fails. The Desktop keeps a warm SAM worker and caches the active image embeddings so repeated include/exclude clicks avoid reloading the model.

CLI management and processing:

```bash
cargo run -p agent2d-cli -- object-runtime-status
cargo run -p agent2d-cli -- object-runtime-install
cargo run -p agent2d-cli -- object-mask input.png mask.png --include 320,240 --exclude 80,80 --expand 2 --feather 1
cargo run -p agent2d-cli -- object-edit input.png output.png --action make-selected-transparent --include 320,240 --format png
cargo run -p agent2d-cli -- object-edit input.png filled.png --action remove-and-fill --include 320,240 --format png
cargo run -p agent2d-cli -- object-bridge
```

`object-bridge` is a line-delimited JSON integration mode for repeated `object-mask` / `object-edit` requests. It keeps the Rust process and SAM worker alive so image embeddings can be reused across calls; the MCP server uses this bridge automatically for Object Edit tools while the MCP server process is alive. Normal one-shot CLI commands remain unchanged.

`AGENT2D_OBJECT_RUNTIME_ROOT` can point to a compatible Object Edit runtime. `AGENT2D_OBJECT_DEVICE=auto|mps|cpu` controls SAM routing; `AGENT2D_LAMA_DEVICE=auto|mps|cpu` controls LaMa, with `auto` preferring MPS on supported Macs and falling back to CPU.

## Desktop

Development bundle:

```bash
cd apps/desktop
npm install
npm run typecheck
npm run build
npm run tauri -- build --debug --bundles app
```

Release bundle:

```bash
cd apps/desktop
npm run release:app
```

macOS distribution image:

```bash
cd apps/desktop
npm run release:mac
```

By default, macOS bundles use Tauri's ad-hoc signing identity (`-`). This keeps local Apple Silicon builds signed without storing credentials in the repository, but it is **not** a substitute for Developer ID distribution and users may still receive Gatekeeper warnings.

For public distribution without Gatekeeper warnings, install a valid **Developer ID Application** certificate and override the default identity with `APPLE_SIGNING_IDENTITY`. Tauri can notarize the same DMG build when either of these credential sets is supplied at build time:

```text
App Store Connect API:
APPLE_API_ISSUER
APPLE_API_KEY
APPLE_API_KEY_PATH

or Apple account:
APPLE_ID
APPLE_PASSWORD
APPLE_TEAM_ID
```

Do not commit signing certificates, private keys, app-specific passwords, or notarization credentials. With the Developer ID identity and notarization credentials present, run `npm run release:mac`; Tauri performs signing/notarization as part of the distribution build.

Primary Desktop functions:

- window-wide drag & drop / file picker for PNG, JPEG, WebP, AVIF, and JXL
- single-image replace mode or multi-image queue mode with sequential batch processing
- Before / After preview with per-format switching when multiple output formats are produced
- Enhance / Compress / Optimize / **Custom** / **Remove BG** / **Object Edit** / **Vectorize**
- x1 / x2 / x4
- Custom with target-pixel framing, drag / wheel / keyboard / nudge controls
- one-click source-size matching plus source-relative 1× / 2× / 4× and editable multiplier sizing
- reusable custom-size presets with local persistence, hover/dropdown selection, and deletion
- optional maximum output file-size cap for Custom; lossy formats reduce quality as needed, while PNG fails explicitly when Exact output cannot meet the requested cap
- multi-format output: choose multiple final formats in one run across Enhance / Compress / Optimize / Custom
- Remove BG uses FeyNoBg and supports transparent PNG plus lossless transparent WebP, including sequential multi-image processing and the normal Before / After view
- Object Edit uses SAM 2.1 Base+ with `+ Click`, `− Click`, and Box prompts; mask range can expand/contract and feather, while actions can keep only the selection, make the selection transparent, or remove-and-fill it with Big-LaMa
- Enhance uses lossless PNG internally where appropriate but is no longer restricted to PNG as the final format
- Mode / Model selection with contextual hover guidance and aligned Scale / Mode / Model controls
- PNG Exact / WebP Lossless / JXL Lossless / AVIF Preserve / JPEG High Quality, plus target-size Compact encoding in Custom
- cross-format conversion through the shared Rust Core
- single-image output location selection or automatic per-input batch output
- asynchronous jobs
- progress display
- real cancellation of NCNN / cwebp / cjxl / ffmpeg child processes
- partial-output cleanup
- output size / elapsed time / pixel-exact result

## Vectorize to SVG

SVG export is intentionally treated as **vectorization**, not ordinary super resolution. `Vectorize` uses the in-process VTracer Rust pipeline and targets logos, icons, line art, flat illustrations, and other shape-driven raster inputs. Output is verified to contain real SVG `<path>` geometry and no embedded raster `<image>` element.

Desktop exposes `Illustration`, `Logo / Icon`, and `Line Art` presets plus `Clean`, `Balanced`, and `Detailed` path/detail levels. Logo and illustration modes expose a maximum-color control; line art uses adaptive monochrome thresholding by default. High-color/photo-like inputs receive a non-recommended warning rather than being presented as "infinite-resolution photography".

CLI example:

```bash
cargo run -p agent2d-cli -- vectorize input.png output.svg --preset logo --detail balanced --max-colors 8
```

The implementation and validation contract are recorded in `Dev/VECTORIZE_SVG_PLAN.md`.

## MCP

```bash
cd mcp/server
npm install
npm run typecheck
npm run build
npm run acceptance
```

Current tools:

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

`agent2d_custom` mirrors Desktop Custom through AI-friendly numeric arguments: `targetWidth`, `targetHeight` or `sourceScale`, `zoom`, normalized `x` / `y` offsets, `formats[]`, and optional `maxBytes`. `agent2d_remove_background` runs the installed FeyNoBg runtime and writes transparent `png` or `webp` output. `agent2d_object_select` accepts include/exclude points, an optional box, expand/contract pixels, and feathering and returns a SAM mask; `agent2d_object_edit` applies the same selection to keep/transparent/remove-and-fill actions. `agent2d_vectorize` exposes `preset`, `detail`, optional `maxColors`, and optional line-art `threshold`, writing a single SVG. `agent2d_enhance`, `agent2d_compress`, and `agent2d_optimize` accept either legacy `format` or multi-output `formats[]`; existing single-format MCP calls remain valid. Compress/Optimize also accept `targetBytes`, while Enhance accepts `targetBytes` for a capped final encode.

## Validation

Core quality checks include:

- exact PNG/WebP/JXL pixel-digest fixtures and AVIF/JPEG preserve fixtures
- extended PNG/JPEG/WebP/AVIF/JXL input inspection and conversion paths
- all managed Real-ESRGAN logical models
- actual NCNN cancellation and partial-output cleanup
- 1536×1024 → 3072×2048 M3 Air benchmark
- Desktop build and app launch
- real path-based SVG vectorization (no embedded raster image) plus MCP vectorize acceptance
- FeyNoBg transparent-output verification (dimensions + alpha channel + model identity) when the managed background runtime is installed
- SAM 2.1 object-selection mask verification plus transparent object-edit and Big-LaMa erase-and-fill E2E when the managed Object Edit runtime is installed
- MCP stdio client acceptance

## License

Agent-2D's own source code is released under the **MIT License**. See [`LICENSE`](LICENSE).

Third-party libraries, command-line codecs, runtime binaries, and AI model weights remain subject to their own upstream licenses and terms. Agent-2D does not relicense those components. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for the current dependency and runtime boundary.

## Distribution boundary

The source tree does not vendor Upscayl code or models.

The Real-ESRGAN runtime, FeyNoBg model/runtime dependencies, SAM 2.1 weights, and Big-LaMa checkpoint are downloaded from their upstream distribution channels only after an explicit user install action. Before distributing third-party binaries, Python packages, or model weights inside a future installer/package rather than downloading them at user request, include the applicable upstream license texts and notices. See `THIRD_PARTY_NOTICES.md`.
