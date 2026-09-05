# Vectorize to SVG — implementation contract

## Status

Implemented in the Agent-2D shared Rust pipeline. Desktop / CLI / MCP all route through the same vectorization implementation.

## Purpose

`Vectorize to SVG` converts raster logos, icons, line art, flat illustrations, and other shape-driven artwork into real SVG vector paths. It is intentionally separate from Real-ESRGAN super resolution: it changes the representation from raster pixels to vector geometry rather than inventing photographic detail.

Recommended:
- logos
- icons
- line art
- flat illustrations
- simple diagrams and low-color artwork

Not recommended:
- photographs
- complex natural images
- noisy or texture-heavy material

## Backend

The implementation embeds `vtracer` `1.0.0-alpha.4` as an in-process Rust dependency. It does not require a separately installed tracing executable and does not wrap the original raster in an SVG `<image>` element.

Input decoding uses Rust `image` where supported and reuses Agent-2D's local ffmpeg normalization path for formats that require it. Normal processing remains local-first.

## Presets

- `Illustration`: poster/color clustering, default 24 colors at Balanced detail.
- `Logo`: poster/color clustering, default 8 colors and stronger simplification bias.
- `Line Art`: binary tracing with adaptive thresholding by default; an explicit 0–255 threshold is available through CLI/MCP.

Detail:
- `Clean`: stronger speckle removal and simplification, fewer/lighter paths.
- `Balanced`: default compromise between fidelity and editable path count.
- `Detailed`: preserves more small regions and curve detail.

Logo/Illustration expose an optional maximum color count. Line Art ignores color count and uses binary tracing.

## Shared contract

Core request fields:
- input/output path
- preset
- detail
- optional max colors
- optional binary threshold

CLI:

```bash
agent2d vectorize input.png output.svg --preset logo --detail balanced --max-colors 8
agent2d vectorize sketch.png sketch.svg --preset line-art --detail clean
```

MCP tool: `agent2d_vectorize` with `preset`, `detail`, optional `maxColors`, and optional `threshold`.

Desktop exposes Vectorize as its own operation rather than adding SVG to the raster output-format selector.

## Output safety / acceptance

A successful vectorization must:
- write `.svg`
- contain one or more real `<path>` elements
- contain no raster `<image>` element
- stay below the hard 50,000 path fail-closed limit
- preserve the source width/height as the SVG coordinate-space dimensions reported by Agent-2D
- support cancellation through the shared job cancellation token

A quantized sampled-color complexity heuristic adds `photo_like_or_high_color_input_vectorization_not_recommended` for high-color inputs. This is advisory: the operation remains available, but Agent-2D does not present it as photographic infinite-resolution enhancement.

Desktop SVG preview accepts only generated path-based SVG and rejects active/external content such as script, foreignObject, embedded image, javascript links, and href/xlink references.

## Validation

Regression coverage includes:
- logo-like raster fixture → real SVG paths
- no embedded raster `<image>`
- bounded path count
- CLI vectorization
- MCP vectorization acceptance
- Desktop type/build/bundle plus installed-app reflection

Future quality work can add perceptual raster-vs-vector scoring and a richer interactive preview/tuning loop without changing this contract.
