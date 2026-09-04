# Agent-2D

Agent-2D is a local-first 2D image optimization engine for macOS Apple Silicon.

The v0.1 product has two primary operations:

- **Super Resolution**: Real-ESRGAN / NCNN / Vulkan based image upscaling.
- **Super Compression**: exact or preserve-oriented image compression without changing pixel dimensions.

Both can be combined as **Optimize = Super Resolution → Compression**.

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

Environment overrides remain available for development/testing and must be supplied as a pair:

```text
AGENT2D_SR_BACKEND
AGENT2D_SR_MODEL_DIR
```

`AGENT2D_RUNTIME_ROOT` can override the parent directory used by the managed installer.

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
npm run tauri -- build --bundles app
```

Primary Desktop functions:

- window-wide drag & drop / file picker for PNG, JPEG, WebP, AVIF, and JXL
- single-image replace mode or multi-image queue mode with sequential batch processing
- Before / After preview
- Enhance / Compress / Optimize / **超カスタム**
- x1 / x2 / x4
- 超カスタム with target-pixel framing, drag / wheel / keyboard / nudge controls
- reusable custom-size presets with local persistence, hover/dropdown selection, and deletion
- optional maximum output file-size cap for 超カスタム; lossy formats reduce quality as needed, while PNG fails explicitly when Exact output cannot meet the requested cap
- multi-format output: choose multiple final formats in one run across Enhance / Compress / Optimize / 超カスタム
- Enhance uses lossless PNG internally where appropriate but is no longer restricted to PNG as the final format
- Mode / Model selection with contextual hover guidance and aligned Scale / Mode / Model controls
- PNG Exact / WebP Lossless / JXL Lossless / AVIF Preserve / JPEG High Quality, plus target-size Compact encoding in 超カスタム
- cross-format conversion through the shared Rust Core
- single-image output location selection or automatic per-input batch output
- asynchronous jobs
- progress display
- real cancellation of NCNN / cwebp / cjxl / ffmpeg child processes
- partial-output cleanup
- output size / elapsed time / pixel-exact result

## Future: Vectorize to SVG

SVG export is intentionally treated as **vectorization**, not ordinary super resolution. The planned `Vectorize to SVG` mode targets logos, icons, line art, flat illustrations, and other shape-driven raster inputs. It is not intended as a way to make photographs infinitely detailed. The scoped design is recorded in `Dev/VECTORIZE_SVG_PLAN.md`; full implementation is deferred to a separate sprint.

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
agent2d_optimize
agent2d_capabilities
```

## Validation

Core quality checks include:

- exact PNG/WebP/JXL pixel-digest fixtures and AVIF/JPEG preserve fixtures
- extended PNG/JPEG/WebP/AVIF/JXL input inspection and conversion paths
- all managed Real-ESRGAN logical models
- actual NCNN cancellation and partial-output cleanup
- 1536×1024 → 3072×2048 M3 Air benchmark
- Desktop build and app launch
- MCP stdio client acceptance

## Distribution boundary

The source tree does not vendor Upscayl code or models.

The Real-ESRGAN runtime is downloaded from the official upstream project at user request. Before distributing third-party binaries inside a future installer/package rather than downloading them from upstream, include the applicable upstream license texts and notices. See `THIRD_PARTY_NOTICES.md`.

The Agent-2D project's own public distribution license has not been declared yet; do not infer one from its dependencies.
