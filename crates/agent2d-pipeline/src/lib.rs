use std::{
    collections::HashSet,
    fs,
    path::Path,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use agent2d_compression::compress_image_with_cancel;
use agent2d_core::{
    Agent2DError, Agent2DResult, CancellationToken, CompressRequest, CustomRequest, InspectRequest,
    OptimizeRequest, UpscaleRequest, UpscaleScale, VectorizeDetail, VectorizePreset, VectorizeRequest,
    cleanup_output, inspect_image, validate_output_path,
};
use agent2d_sr::upscale_image_with_cancel;
use tempfile::tempdir;
use uuid::Uuid;
use vtracer::{ColorImage, Config as VectorConfig, Hierarchical, Preset as VectorPreset};
use vtracer::progress::CancelToken as VectorCancelToken;

fn crop_geometry(
    input_width: u32,
    input_height: u32,
    target_width: u32,
    target_height: u32,
    zoom: f64,
    offset_x: f64,
    offset_y: f64,
) -> (u32, u32, u32, u32) {
    let source_aspect = input_width as f64 / input_height as f64;
    let target_aspect = target_width as f64 / target_height as f64;
    let (base_width, base_height) = if source_aspect >= target_aspect {
        (input_height as f64 * target_aspect, input_height as f64)
    } else {
        (input_width as f64, input_width as f64 / target_aspect)
    };
    let zoom = zoom.clamp(1.0, 6.0);
    let crop_width = ((base_width / zoom).round() as u32).clamp(1, input_width);
    let crop_height = ((base_height / zoom).round() as u32).clamp(1, input_height);
    let max_x = input_width.saturating_sub(crop_width);
    let max_y = input_height.saturating_sub(crop_height);
    let x = ((max_x as f64 * (offset_x.clamp(-1.0, 1.0) + 1.0) / 2.0).round() as u32).min(max_x);
    let y = ((max_y as f64 * (offset_y.clamp(-1.0, 1.0) + 1.0) / 2.0).round() as u32).min(max_y);
    (x, y, crop_width, crop_height)
}

fn run_transform_to_png(
    input: &Path,
    output: &Path,
    filter: &str,
    cancellation: &CancellationToken,
) -> Result<(), Agent2DError> {
    if cancellation.is_cancelled() {
        return Err(Agent2DError::Cancelled);
    }
    let mut child = Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-n", "-i"])
        .arg(input)
        .args(["-vf", filter, "-frames:v", "1", "-c:v", "png"])
        .arg(output)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                Agent2DError::BackendUnavailable { backend: "ffmpeg".into() }
            } else {
                Agent2DError::BackendFailed { backend: "ffmpeg".into(), message: error.to_string() }
            }
        })?;
    loop {
        if cancellation.is_cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            cleanup_output(output);
            return Err(Agent2DError::Cancelled);
        }
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(_)) => {
                cleanup_output(output);
                return Err(Agent2DError::BackendFailed {
                    backend: "ffmpeg".into(),
                    message: "custom transform backend exited with a non-zero status".into(),
                });
            }
            Ok(None) => thread::sleep(Duration::from_millis(25)),
            Err(error) => {
                cleanup_output(output);
                return Err(Agent2DError::BackendFailed { backend: "ffmpeg".into(), message: error.to_string() });
            }
        }
    }
}

pub fn custom_image(request: &CustomRequest) -> Result<Agent2DResult, Agent2DError> {
    custom_image_with_cancel(request, &CancellationToken::new())
}

pub fn custom_image_with_cancel(
    request: &CustomRequest,
    cancellation: &CancellationToken,
) -> Result<Agent2DResult, Agent2DError> {
    if cancellation.is_cancelled() {
        return Err(Agent2DError::Cancelled);
    }
    if request.target_width == 0 || request.target_height == 0 {
        return Err(Agent2DError::UnsupportedCompression {
            mode: "custom".into(),
            format: "target_dimensions_required".into(),
        });
    }
    let started = Instant::now();
    validate_output_path(&request.input_path, &request.output_path)?;
    let input = inspect_image(&InspectRequest { input_path: request.input_path.clone() })?;
    let (x, y, crop_width, crop_height) = crop_geometry(
        input.width,
        input.height,
        request.target_width,
        request.target_height,
        request.zoom,
        request.offset_x,
        request.offset_y,
    );
    let temp = tempdir().map_err(|error| Agent2DError::ImageWrite {
        path: "temporary_directory".into(),
        message: error.to_string(),
    })?;
    let intermediate = temp.path().join("agent2d-custom-intermediate.png");
    let filter = format!(
        "crop={crop_width}:{crop_height}:{x}:{y},scale={}:{}:flags=lanczos",
        request.target_width, request.target_height
    );
    run_transform_to_png(&request.input_path, &intermediate, &filter, cancellation)?;

    let compressed = compress_image_with_cancel(
        &CompressRequest {
            input_path: intermediate,
            output_path: request.output_path.clone(),
            mode: request.compression.mode,
            format: request.compression.format,
            target_bytes: request.compression.target_bytes,
            preserve_metadata: Some(false),
        },
        cancellation,
    )?;
    if compressed.output_width != request.target_width || compressed.output_height != request.target_height {
        cleanup_output(&request.output_path);
        return Err(Agent2DError::ProbeFailed {
            message: format!(
                "custom output dimension mismatch: expected {}x{}, got {}x{}",
                request.target_width, request.target_height, compressed.output_width, compressed.output_height
            ),
        });
    }

    let mut warnings = vec!["crop_to_size_applied".to_owned()];
    if crop_width < request.target_width || crop_height < request.target_height {
        warnings.push("crop_interpolated_to_target_size".to_owned());
    }
    warnings.extend(compressed.warnings);

    Ok(Agent2DResult {
        job_id: Uuid::new_v4().to_string(),
        input_path: request.input_path.clone(),
        output_path: request.output_path.clone(),
        input_width: input.width,
        input_height: input.height,
        output_width: compressed.output_width,
        output_height: compressed.output_height,
        input_bytes: input.input_bytes,
        output_bytes: compressed.output_bytes,
        compression_ratio: if compressed.output_bytes == 0 { 0.0 } else { input.input_bytes as f64 / compressed.output_bytes as f64 },
        model_id: None,
        codec: compressed.codec,
        pixel_exact: Some(false),
        elapsed_ms: started.elapsed().as_millis() as u64,
        warnings,
    })
}

fn vector_config(request: &VectorizeRequest) -> VectorConfig {
    let mut config = match request.preset {
        VectorizePreset::LineArt => VectorConfig::from_preset(VectorPreset::Bw),
        VectorizePreset::Logo | VectorizePreset::Illustration => VectorConfig::from_preset(VectorPreset::Poster),
    };
    config.hierarchical = Hierarchical::Cutout;
    config.optimize = 2;
    match request.detail {
        VectorizeDetail::Clean => {
            config.filter_speckle = 6;
            config.simplify = Some(1.6);
            config.path_precision = Some(1);
        }
        VectorizeDetail::Balanced => {
            config.filter_speckle = 3;
            config.simplify = Some(0.8);
            config.path_precision = Some(2);
        }
        VectorizeDetail::Detailed => {
            config.filter_speckle = 1;
            config.simplify = Some(0.3);
            config.path_precision = Some(3);
        }
    }
    match request.preset {
        VectorizePreset::LineArt => {
            config.binary_threshold = request.threshold.unwrap_or(128);
            config.binary_adaptive = request.threshold.is_none();
        }
        VectorizePreset::Logo => {
            config.max_colors = Some(request.max_colors.unwrap_or(8).clamp(2, 32) as usize);
        }
        VectorizePreset::Illustration => {
            let default_colors = match request.detail {
                VectorizeDetail::Clean => 12,
                VectorizeDetail::Balanced => 24,
                VectorizeDetail::Detailed => 48,
            };
            config.max_colors = Some(request.max_colors.unwrap_or(default_colors).clamp(2, 64) as usize);
        }
    }
    config
}

fn sampled_color_complexity(raw: &[u8]) -> usize {
    if raw.len() < 4 {
        return 0;
    }
    let pixels = raw.len() / 4;
    let step = (pixels / 4096).max(1);
    let mut colors = HashSet::new();
    for index in (0..pixels).step_by(step) {
        let offset = index * 4;
        let r = raw[offset] >> 4;
        let g = raw[offset + 1] >> 4;
        let b = raw[offset + 2] >> 4;
        colors.insert(((r as u16) << 8) | ((g as u16) << 4) | b as u16);
        if colors.len() > 512 {
            break;
        }
    }
    colors.len()
}

pub fn vectorize_image(request: &VectorizeRequest) -> Result<Agent2DResult, Agent2DError> {
    vectorize_image_with_cancel(request, &CancellationToken::new())
}

pub fn vectorize_image_with_cancel(
    request: &VectorizeRequest,
    cancellation: &CancellationToken,
) -> Result<Agent2DResult, Agent2DError> {
    if cancellation.is_cancelled() {
        return Err(Agent2DError::Cancelled);
    }
    if request.output_path.extension().and_then(|value| value.to_str()).map(|value| value.eq_ignore_ascii_case("svg")) != Some(true) {
        return Err(Agent2DError::UnsupportedCompression {
            mode: "vectorize".into(),
            format: "svg_output_required".into(),
        });
    }
    let started = Instant::now();
    validate_output_path(&request.input_path, &request.output_path)?;
    let input = inspect_image(&InspectRequest { input_path: request.input_path.clone() })?;
    let temp = tempdir().map_err(|error| Agent2DError::ImageWrite {
        path: "temporary_directory".into(),
        message: error.to_string(),
    })?;
    let decoded = match image::open(&request.input_path) {
        Ok(value) => value,
        Err(_) => {
            let normalized = temp.path().join("agent2d-vectorize-input.png");
            run_transform_to_png(&request.input_path, &normalized, "null", cancellation)?;
            image::open(&normalized).map_err(|source| Agent2DError::ImageDecode {
                path: request.input_path.to_string_lossy().into_owned(),
                source,
            })?
        }
    };
    let rgba = decoded.to_rgba8();
    let (width, height) = rgba.dimensions();
    let color_complexity = sampled_color_complexity(rgba.as_raw());
    let image = ColorImage {
        pixels: rgba.into_raw(),
        width: width as usize,
        height: height as usize,
    };
    let config = vector_config(request);
    let pipeline = config.build().map_err(|error| Agent2DError::BackendFailed {
        backend: "vtracer".into(),
        message: error.to_string(),
    })?;

    let vector_cancel = VectorCancelToken::new();
    let watcher_token = vector_cancel.clone();
    let agent_cancel = cancellation.clone();
    let watcher = thread::spawn(move || {
        while !watcher_token.is_cancelled() {
            if agent_cancel.is_cancelled() {
                watcher_token.cancel();
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
    });
    let run = pipeline.run_with_progress(&image, &vector_cancel, &mut |_| {});
    vector_cancel.cancel();
    let _ = watcher.join();
    let document = match run {
        Ok(value) => value,
        Err(vtracer::Error::Cancelled) => return Err(Agent2DError::Cancelled),
        Err(error) => {
            return Err(Agent2DError::BackendFailed {
                backend: "vtracer".into(),
                message: error.to_string(),
            })
        }
    };
    if cancellation.is_cancelled() {
        return Err(Agent2DError::Cancelled);
    }
    let svg = pipeline.writer.write(&document);
    let path_count = svg.matches("<path").count();
    if path_count == 0 || svg.contains("<image") {
        return Err(Agent2DError::BackendFailed {
            backend: "vtracer".into(),
            message: "vector output did not contain real SVG paths".into(),
        });
    }
    if path_count > 50_000 {
        return Err(Agent2DError::BackendFailed {
            backend: "vtracer".into(),
            message: format!("vector path count is unreasonably high: {path_count}"),
        });
    }
    fs::write(&request.output_path, svg.as_bytes()).map_err(|error| {
        cleanup_output(&request.output_path);
        Agent2DError::ImageWrite {
            path: request.output_path.to_string_lossy().into_owned(),
            message: error.to_string(),
        }
    })?;
    let output_bytes = fs::metadata(&request.output_path)
        .map(|metadata| metadata.len())
        .map_err(|error| Agent2DError::ImageWrite {
            path: request.output_path.to_string_lossy().into_owned(),
            message: error.to_string(),
        })?;
    let mut warnings = vec![
        "vectorized_svg_real_paths".into(),
        format!("vector_paths_{path_count}"),
        format!("vector_color_complexity_{color_complexity}"),
    ];
    if color_complexity > 192 {
        warnings.push("photo_like_or_high_color_input_vectorization_not_recommended".into());
    }
    Ok(Agent2DResult {
        job_id: Uuid::new_v4().to_string(),
        input_path: request.input_path.clone(),
        output_path: request.output_path.clone(),
        input_width: input.width,
        input_height: input.height,
        output_width: input.width,
        output_height: input.height,
        input_bytes: input.input_bytes,
        output_bytes,
        compression_ratio: if output_bytes == 0 { 0.0 } else { input.input_bytes as f64 / output_bytes as f64 },
        model_id: Some("vtracer-1.0.0-alpha.4".into()),
        codec: Some("svg".into()),
        pixel_exact: Some(false),
        elapsed_ms: started.elapsed().as_millis() as u64,
        warnings,
    })
}

pub fn optimize_image(request: &OptimizeRequest) -> Result<Agent2DResult, Agent2DError> {
    optimize_image_with_cancel(request, &CancellationToken::new())
}

pub fn optimize_image_with_cancel(
    request: &OptimizeRequest,
    cancellation: &CancellationToken,
) -> Result<Agent2DResult, Agent2DError> {
    if cancellation.is_cancelled() {
        return Err(Agent2DError::Cancelled);
    }
    let started = Instant::now();
    let original = inspect_image(&InspectRequest {
        input_path: request.input_path.clone(),
    })?;

    let Some(upscale) = &request.upscale else {
        return compress_image_with_cancel(
            &CompressRequest {
                input_path: request.input_path.clone(),
                output_path: request.output_path.clone(),
                mode: request.compression.mode,
                format: request.compression.format,
                target_bytes: request.compression.target_bytes,
                preserve_metadata: Some(false),
            },
            cancellation,
        );
    };

    if matches!(upscale.scale, Some(UpscaleScale::X1)) {
        let mut result = compress_image_with_cancel(
            &CompressRequest {
                input_path: request.input_path.clone(),
                output_path: request.output_path.clone(),
                mode: request.compression.mode,
                format: request.compression.format,
                target_bytes: request.compression.target_bytes,
                preserve_metadata: Some(false),
            },
            cancellation,
        )?;
        result.elapsed_ms = started.elapsed().as_millis() as u64;
        result.warnings.push("sr_skipped_scale_1_dimensions_preserved".into());
        return Ok(result);
    }

    let temp = tempdir().map_err(|error| Agent2DError::ImageWrite {
        path: "temporary_directory".into(),
        message: error.to_string(),
    })?;
    let intermediate = temp.path().join("agent2d-sr-intermediate.png");

    let sr_result = upscale_image_with_cancel(
        &UpscaleRequest {
            input_path: request.input_path.clone(),
            output_path: intermediate.clone(),
            scale: upscale.scale,
            target_width: upscale.target_width,
            target_height: upscale.target_height,
            mode: upscale.mode,
            preset: None,
            model_id: upscale.model_id.clone(),
        },
        cancellation,
    )?;

    let compression_result = compress_image_with_cancel(
        &CompressRequest {
            input_path: intermediate,
            output_path: request.output_path.clone(),
            mode: request.compression.mode,
            format: request.compression.format,
            target_bytes: request.compression.target_bytes,
            preserve_metadata: Some(false),
        },
        cancellation,
    )?;

    let mut warnings = sr_result.warnings;
    warnings.extend(compression_result.warnings);
    warnings.push("combined_pipeline_sr_then_compression".into());

    Ok(Agent2DResult {
        job_id: Uuid::new_v4().to_string(),
        input_path: request.input_path.clone(),
        output_path: request.output_path.clone(),
        input_width: original.width,
        input_height: original.height,
        output_width: compression_result.output_width,
        output_height: compression_result.output_height,
        input_bytes: original.input_bytes,
        output_bytes: compression_result.output_bytes,
        compression_ratio: if compression_result.output_bytes == 0 {
            0.0
        } else {
            original.input_bytes as f64 / compression_result.output_bytes as f64
        },
        model_id: sr_result.model_id,
        codec: compression_result.codec,
        pixel_exact: Some(false),
        elapsed_ms: started.elapsed().as_millis() as u64,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent2d_core::{
        CompressionMode, CompressionOptions, OutputFormat, SuperResolutionMode, UpscaleOptions,
        UpscaleScale, VectorizeDetail, VectorizePreset, VectorizeRequest,
    };
    use agent2d_sr::capabilities;
    use image::{ImageFormat, Rgb, RgbImage};

    #[test]
    fn actual_optimize_runs_sr_then_exact_png_compression() {
        if capabilities().is_err() {
            return;
        }
        let dir = tempdir().unwrap();
        let input = dir.path().join("input.png");
        let output = dir.path().join("optimized.png");
        let mut image = RgbImage::new(24, 16);
        for (x, y, pixel) in image.enumerate_pixels_mut() {
            *pixel = Rgb([
                ((x * 3 + y * 7) % 256) as u8,
                ((x * 11 + y * 5) % 256) as u8,
                ((x * 17 + y * 13) % 256) as u8,
            ]);
        }
        image.save_with_format(&input, ImageFormat::Png).unwrap();

        let result = optimize_image(&OptimizeRequest {
            input_path: input.clone(),
            output_path: output.clone(),
            upscale: Some(UpscaleOptions {
                scale: Some(UpscaleScale::X2),
                target_width: None,
                target_height: None,
                mode: SuperResolutionMode::Balanced,
                model_id: None,
            }),
            compression: CompressionOptions {
                mode: CompressionMode::Exact,
                format: Some(OutputFormat::Png),
                target_bytes: None,
            },
        })
        .unwrap();

        assert_eq!((result.input_width, result.input_height), (24, 16));
        assert_eq!((result.output_width, result.output_height), (48, 32));
        assert_eq!(result.codec.as_deref(), Some("png"));
        assert!(result.model_id.is_some());
        assert_eq!(result.pixel_exact, Some(false));
        assert!(output.is_file());
        assert!(
            result
                .warnings
                .iter()
                .any(|warning| warning == "combined_pipeline_sr_then_compression")
        );
    }

    #[test]
    fn x1_optimize_skips_sr_and_preserves_dimensions() {
        let dir = tempdir().unwrap();
        let input = dir.path().join("input.png");
        let output = dir.path().join("optimized-x1.png");
        RgbImage::from_pixel(16, 8, Rgb([32, 64, 96]))
            .save_with_format(&input, ImageFormat::Png)
            .unwrap();

        let result = optimize_image(&OptimizeRequest {
            input_path: input,
            output_path: output,
            upscale: Some(UpscaleOptions {
                scale: Some(UpscaleScale::X1),
                target_width: None,
                target_height: None,
                mode: SuperResolutionMode::Balanced,
                model_id: Some("realesrgan-x4plus".into()),
            }),
            compression: CompressionOptions {
                mode: CompressionMode::Exact,
                format: Some(OutputFormat::Png),
                target_bytes: None,
            },
        })
        .unwrap();

        assert_eq!((result.output_width, result.output_height), (16, 8));
        assert_eq!(result.model_id, None);
        assert_eq!(result.pixel_exact, Some(true));
        assert!(result.warnings.iter().any(|warning| warning == "sr_skipped_scale_1_dimensions_preserved"));
    }

    #[test]
    fn vectorize_logo_produces_real_svg_paths() {
        let dir = tempdir().unwrap();
        let input = dir.path().join("logo.png");
        let output = dir.path().join("logo.svg");
        let mut image = RgbImage::from_pixel(64, 64, Rgb([245, 245, 245]));
        for y in 12..52 {
            for x in 12..52 {
                if x < 22 || y < 22 || (x > 42 && y > 42) {
                    image.put_pixel(x, y, Rgb([20, 40, 180]));
                }
            }
        }
        image.save_with_format(&input, ImageFormat::Png).unwrap();

        let result = vectorize_image(&VectorizeRequest {
            input_path: input,
            output_path: output.clone(),
            preset: VectorizePreset::Logo,
            detail: VectorizeDetail::Balanced,
            max_colors: Some(4),
            threshold: None,
        }).unwrap();
        let svg = std::fs::read_to_string(&output).unwrap();
        let paths = svg.matches("<path").count();
        assert!(paths > 0);
        assert!(paths < 1000);
        assert!(!svg.contains("<image"));
        assert_eq!(result.codec.as_deref(), Some("svg"));
        assert_eq!((result.output_width, result.output_height), (64, 64));
        assert!(result.warnings.iter().any(|warning| warning == "vectorized_svg_real_paths"));
    }

    #[test]
    fn compression_only_path_reuses_compression_engine() {
        let dir = tempdir().unwrap();
        let input = dir.path().join("input.png");
        let output = dir.path().join("compressed.png");
        RgbImage::from_pixel(16, 8, Rgb([12, 34, 56]))
            .save_with_format(&input, ImageFormat::Png)
            .unwrap();

        let result = optimize_image(&OptimizeRequest {
            input_path: input,
            output_path: output,
            upscale: None,
            compression: CompressionOptions {
                mode: CompressionMode::Exact,
                format: Some(OutputFormat::Png),
                target_bytes: None,
            },
        })
        .unwrap();

        assert_eq!((result.output_width, result.output_height), (16, 8));
        assert_eq!(result.pixel_exact, Some(true));
    }

    #[test]
    fn custom_geometry_matches_desktop_center_edges_and_zoom() {
        assert_eq!(crop_geometry(3000, 2000, 1024, 1024, 1.0, 0.0, 0.0), (500, 0, 2000, 2000));
        assert_eq!(crop_geometry(3000, 2000, 1024, 1024, 1.0, -1.0, 0.0), (0, 0, 2000, 2000));
        assert_eq!(crop_geometry(3000, 2000, 1024, 1024, 1.0, 1.0, 0.0), (1000, 0, 2000, 2000));
        assert_eq!(crop_geometry(3000, 2000, 1024, 1024, 2.0, 0.0, 0.0), (1000, 500, 1000, 1000));
    }

    #[test]
    fn custom_image_writes_exact_target_dimensions() {
        if Command::new("ffmpeg").arg("-version").output().is_err() {
            return;
        }
        let dir = tempdir().unwrap();
        let input = dir.path().join("custom-input.png");
        let output = dir.path().join("custom-output.png");
        RgbImage::from_pixel(30, 20, Rgb([40, 80, 120]))
            .save_with_format(&input, ImageFormat::Png)
            .unwrap();
        let result = custom_image(&CustomRequest {
            input_path: input,
            output_path: output.clone(),
            target_width: 12,
            target_height: 12,
            zoom: 1.5,
            offset_x: 0.25,
            offset_y: -0.25,
            compression: CompressionOptions {
                mode: CompressionMode::Exact,
                format: Some(OutputFormat::Png),
                target_bytes: None,
            },
        })
        .unwrap();
        assert_eq!((result.output_width, result.output_height), (12, 12));
        assert!(output.is_file());
        assert!(result.warnings.iter().any(|warning| warning == "crop_to_size_applied"));
    }
}
