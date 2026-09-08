use std::{
    ffi::OsString,
    fs::{self, File},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use agent2d_core::{
    Agent2DError, Agent2DResult, CancellationToken, CompressRequest, CompressionMode,
    InspectRequest, OutputFormat, backend_command_path, cleanup_output, inspect_image,
    validate_output_path,
};
use image::{
    ColorType, GenericImageView, ImageEncoder, ImageFormat,
    codecs::{
        jpeg::JpegEncoder,
        png::{CompressionType, FilterType, PngEncoder},
    },
};
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PixelDigest {
    pub width: u32,
    pub height: u32,
    pub sha256: String,
}

pub fn compress_image(request: &CompressRequest) -> Result<Agent2DResult, Agent2DError> {
    compress_image_with_cancel(request, &CancellationToken::new())
}

pub fn compress_image_with_cancel(
    request: &CompressRequest,
    cancellation: &CancellationToken,
) -> Result<Agent2DResult, Agent2DError> {
    if cancellation.is_cancelled() {
        return Err(Agent2DError::Cancelled);
    }
    let started = Instant::now();
    let input = inspect_image(&InspectRequest {
        input_path: request.input_path.clone(),
    })?;
    validate_output_path(&request.input_path, &request.output_path)?;

    let format = resolve_output_format(request, &input.format)?;
    let mut warnings = Vec::new();
    if request.preserve_metadata.unwrap_or(false) {
        warnings.push("metadata_preservation_is_not_implemented_in_v0_1".to_owned());
    }

    let pixel_exact = match (request.mode, format) {
        (CompressionMode::Exact, OutputFormat::Png) => {
            if input.bit_depth > 8 && input.format == "png" {
                return Err(Agent2DError::UnsupportedCompression {
                    mode: "exact".into(),
                    format: "png_non_8_bit".into(),
                });
            }
            encode_png_exact(&request.input_path, &request.output_path, cancellation)?;
            verify_pixel_exact(&request.input_path, &request.output_path)?;
            Some(true)
        }
        (CompressionMode::Exact, OutputFormat::Webp) => {
            encode_lossless_raster(&request.input_path, &request.output_path, ImageFormat::WebP, cancellation)?;
            verify_pixel_exact(&request.input_path, &request.output_path)?;
            Some(true)
        }
        (CompressionMode::Exact, OutputFormat::Jxl) => {
            run_cjxl_lossless(&request.input_path, &request.output_path, cancellation)?;
            verify_pixel_exact(&request.input_path, &request.output_path)?;
            Some(true)
        }
        (CompressionMode::Exact, OutputFormat::Tiff) => {
            encode_lossless_raster(&request.input_path, &request.output_path, ImageFormat::Tiff, cancellation)?;
            verify_pixel_exact(&request.input_path, &request.output_path)?;
            Some(true)
        }
        (CompressionMode::Exact, OutputFormat::Bmp) => {
            encode_lossless_raster(&request.input_path, &request.output_path, ImageFormat::Bmp, cancellation)?;
            verify_pixel_exact(&request.input_path, &request.output_path)?;
            Some(true)
        }
        (CompressionMode::Preserve, OutputFormat::Avif) => {
            run_ffmpeg_avif_preserve(&request.input_path, &request.output_path, cancellation)?;
            warnings.push("avif_preserve_is_visually_lossless_not_pixel_exact".to_owned());
            Some(false)
        }
        (CompressionMode::Preserve, OutputFormat::Jpeg) => {
            encode_jpeg_quality(&request.input_path, &request.output_path, 95, cancellation)?;
            warnings.push("jpeg_preserve_is_high_quality_lossy_not_pixel_exact".to_owned());
            if input.has_alpha {
                warnings.push("jpeg_output_drops_alpha".to_owned());
            }
            Some(false)
        }
        (CompressionMode::Compact, format) => {
            let target_bytes = request.target_bytes.filter(|value| *value > 0).ok_or_else(|| {
                Agent2DError::UnsupportedCompression {
                    mode: "compact".into(),
                    format: "target_bytes_required".into(),
                }
            })?;
            let outcome = encode_compact_to_target(
                &request.input_path,
                &request.output_path,
                format,
                target_bytes,
                cancellation,
            )?;
            warnings.extend(outcome.warnings);
            if input.has_alpha && format == OutputFormat::Jpeg {
                warnings.push("jpeg_output_drops_alpha".to_owned());
            }
            outcome.pixel_exact
        }
        (mode, format) => {
            return Err(Agent2DError::UnsupportedCompression {
                mode: compression_mode_name(mode).into(),
                format: output_format_name(format).into(),
            });
        }
    };

    if cancellation.is_cancelled() {
        cleanup_output(&request.output_path);
        return Err(Agent2DError::Cancelled);
    }

    let output_bytes = fs::metadata(&request.output_path)
        .map_err(|error| Agent2DError::ImageWrite {
            path: display_path(&request.output_path),
            message: error.to_string(),
        })?
        .len();

    let (output_width, output_height) = match format {
        OutputFormat::Png | OutputFormat::Webp | OutputFormat::Jpeg | OutputFormat::Tiff | OutputFormat::Bmp => {
            let decoded =
                image::open(&request.output_path).map_err(|source| Agent2DError::ImageDecode {
                    path: display_path(&request.output_path),
                    source,
                })?;
            decoded.dimensions()
        }
        OutputFormat::Avif | OutputFormat::Jxl => probe_dimensions(&request.output_path)?,
    };

    if output_width != input.width || output_height != input.height {
        cleanup_output(&request.output_path);
        return Err(Agent2DError::ProbeFailed {
            message: format!(
                "dimensions changed from {}x{} to {}x{}",
                input.width, input.height, output_width, output_height
            ),
        });
    }

    Ok(Agent2DResult {
        job_id: Uuid::new_v4().to_string(),
        input_path: request.input_path.clone(),
        output_path: request.output_path.clone(),
        input_width: input.width,
        input_height: input.height,
        output_width,
        output_height,
        input_bytes: input.input_bytes,
        output_bytes,
        compression_ratio: if output_bytes == 0 {
            0.0
        } else {
            input.input_bytes as f64 / output_bytes as f64
        },
        model_id: None,
        codec: Some(output_format_name(format).to_owned()),
        pixel_exact,
        elapsed_ms: started.elapsed().as_millis() as u64,
        warnings,
    })
}

pub fn pixel_digest(path: &Path) -> Result<PixelDigest, Agent2DError> {
    match image::open(path) {
        Ok(decoded) => Ok(digest_decoded(decoded)),
        Err(_) => {
            let temp = temporary_png_path();
            let token = CancellationToken::new();
            let converted = run_ffmpeg_png_decode(path, &temp, &token);
            if let Err(error) = converted {
                cleanup_output(&temp);
                return Err(error);
            }
            let result = image::open(&temp).map(digest_decoded).map_err(|source| {
                Agent2DError::ImageDecode {
                    path: display_path(path),
                    source,
                }
            });
            cleanup_output(&temp);
            result
        }
    }
}

fn digest_decoded(decoded: image::DynamicImage) -> PixelDigest {
    let rgba = decoded.to_rgba8();
    let (width, height) = rgba.dimensions();
    let mut hasher = Sha256::new();
    hasher.update(width.to_le_bytes());
    hasher.update(height.to_le_bytes());
    hasher.update(rgba.as_raw());
    PixelDigest {
        width,
        height,
        sha256: format!("{:x}", hasher.finalize()),
    }
}

pub fn verify_pixel_exact(input: &Path, output: &Path) -> Result<(), Agent2DError> {
    if pixel_digest(input)? == pixel_digest(output)? {
        Ok(())
    } else {
        cleanup_output(output);
        Err(Agent2DError::PixelMismatch)
    }
}

fn resolve_output_format(
    request: &CompressRequest,
    input_format: &str,
) -> Result<OutputFormat, Agent2DError> {
    if let Some(format) = request.format {
        return Ok(format);
    }
    match (request.mode, input_format) {
        (CompressionMode::Exact, "png") => Ok(OutputFormat::Png),
        _ => Err(Agent2DError::UnsupportedCompression {
            mode: compression_mode_name(request.mode).into(),
            format: "format_required".into(),
        }),
    }
}

fn encode_lossless_raster(
    input: &Path,
    output: &Path,
    format: ImageFormat,
    cancellation: &CancellationToken,
) -> Result<(), Agent2DError> {
    if cancellation.is_cancelled() {
        return Err(Agent2DError::Cancelled);
    }
    let prepared = prepare_png_for_backend(input, cancellation, &["avif", "jxl"])?;
    let source = prepared.as_deref().unwrap_or(input);
    let decoded = image::open(source).map_err(|source_error| Agent2DError::ImageDecode {
        path: display_path(source),
        source: source_error,
    })?;
    let result = decoded.save_with_format(output, format).map_err(|error| Agent2DError::ImageWrite {
        path: display_path(output),
        message: error.to_string(),
    });
    if let Some(path) = prepared.as_ref() { cleanup_output(path); }
    result
}

fn encode_png_exact(
    input: &Path,
    output: &Path,
    cancellation: &CancellationToken,
) -> Result<(), Agent2DError> {
    if cancellation.is_cancelled() {
        return Err(Agent2DError::Cancelled);
    }
    let decoded = match image::open(input) {
        Ok(decoded) => decoded,
        Err(_) => return run_ffmpeg_png_decode(input, output, cancellation),
    };
    let (width, height) = decoded.dimensions();
    let file = File::create(output).map_err(|error| Agent2DError::ImageWrite {
        path: display_path(output),
        message: error.to_string(),
    })?;
    let encoder = PngEncoder::new_with_quality(file, CompressionType::Best, FilterType::Adaptive);

    let encoded = if decoded.color().has_alpha() {
        let rgba = decoded.to_rgba8();
        encoder.write_image(rgba.as_raw(), width, height, ColorType::Rgba8.into())
    } else {
        let rgb = decoded.to_rgb8();
        encoder.write_image(rgb.as_raw(), width, height, ColorType::Rgb8.into())
    };

    encoded.map_err(|error| {
        cleanup_output(output);
        Agent2DError::ImageWrite {
            path: display_path(output),
            message: error.to_string(),
        }
    })
}

fn encode_jpeg_quality(
    input: &Path,
    output: &Path,
    quality: u8,
    cancellation: &CancellationToken,
) -> Result<(), Agent2DError> {
    if cancellation.is_cancelled() {
        return Err(Agent2DError::Cancelled);
    }
    let prepared = prepare_png_for_backend(input, cancellation, &["avif", "jxl"])?;
    let source = prepared.as_deref().unwrap_or(input);
    let result = (|| {
        let decoded = image::open(source).map_err(|source_error| Agent2DError::ImageDecode {
            path: display_path(source),
            source: source_error,
        })?;
        let (width, height) = decoded.dimensions();
        let rgb = decoded.to_rgb8();
        let file = File::create(output).map_err(|error| Agent2DError::ImageWrite {
            path: display_path(output),
            message: error.to_string(),
        })?;
        let encoder = JpegEncoder::new_with_quality(file, quality.clamp(1, 100));
        encoder
            .write_image(rgb.as_raw(), width, height, ColorType::Rgb8.into())
            .map_err(|error| {
                cleanup_output(output);
                Agent2DError::ImageWrite {
                    path: display_path(output),
                    message: error.to_string(),
                }
            })
    })();
    if let Some(path) = prepared {
        cleanup_output(&path);
    }
    result
}

fn run_cjxl_lossless(
    input: &Path,
    output: &Path,
    cancellation: &CancellationToken,
) -> Result<(), Agent2DError> {
    let prepared = prepare_png_for_backend(input, cancellation, &["webp", "avif", "jxl"])?;
    let source = prepared.as_deref().unwrap_or(input);
    let result = run_backend(
        "cjxl",
        vec![
            source.as_os_str().into(),
            output.as_os_str().into(),
            "-d".into(),
            "0".into(),
            "-e".into(),
            "7".into(),
            "--quiet".into(),
        ],
        output,
        cancellation,
    );
    if let Some(path) = prepared {
        cleanup_output(&path);
    }
    result
}

fn run_ffmpeg_png_decode(
    input: &Path,
    output: &Path,
    cancellation: &CancellationToken,
) -> Result<(), Agent2DError> {
    run_backend(
        "ffmpeg",
        vec![
            "-hide_banner".into(),
            "-loglevel".into(),
            "error".into(),
            "-n".into(),
            "-i".into(),
            input.as_os_str().into(),
            "-frames:v".into(),
            "1".into(),
            "-c:v".into(),
            "png".into(),
            output.as_os_str().into(),
        ],
        output,
        cancellation,
    )
}

fn run_ffmpeg_avif_preserve(
    input: &Path,
    output: &Path,
    cancellation: &CancellationToken,
) -> Result<(), Agent2DError> {
    run_backend(
        "ffmpeg",
        vec![
            "-hide_banner".into(),
            "-loglevel".into(),
            "error".into(),
            "-n".into(),
            "-i".into(),
            input.as_os_str().into(),
            "-frames:v".into(),
            "1".into(),
            "-c:v".into(),
            "libaom-av1".into(),
            "-still-picture".into(),
            "1".into(),
            "-crf".into(),
            "12".into(),
            "-cpu-used".into(),
            "4".into(),
            "-pix_fmt".into(),
            "yuv444p10le".into(),
            "-f".into(),
            "avif".into(),
            output.as_os_str().into(),
        ],
        output,
        cancellation,
    )
}

#[derive(Debug)]
struct CompactOutcome {
    pixel_exact: Option<bool>,
    warnings: Vec<String>,
}

fn encoded_size(path: &Path) -> Result<u64, Agent2DError> {
    fs::metadata(path)
        .map(|metadata| metadata.len())
        .map_err(|error| Agent2DError::ImageWrite {
            path: display_path(path),
            message: error.to_string(),
        })
}

fn compact_accepts(output: &Path, target_bytes: u64) -> Result<bool, Agent2DError> {
    Ok(encoded_size(output)? <= target_bytes)
}

fn compact_success(target_bytes: u64, pixel_exact: Option<bool>, detail: String) -> CompactOutcome {
    CompactOutcome {
        pixel_exact,
        warnings: vec![
            "compact_target_met".to_owned(),
            format!("compact_target_bytes_{target_bytes}"),
            detail,
        ],
    }
}

fn compact_unreachable(output: &Path, format: OutputFormat, target_bytes: u64) -> Agent2DError {
    cleanup_output(output);
    Agent2DError::UnsupportedCompression {
        mode: format!("compact_target_unreachable_{target_bytes}_bytes"),
        format: output_format_name(format).into(),
    }
}

fn encode_compact_to_target(
    input: &Path,
    output: &Path,
    format: OutputFormat,
    target_bytes: u64,
    cancellation: &CancellationToken,
) -> Result<CompactOutcome, Agent2DError> {
    match format {
        OutputFormat::Png => {
            encode_png_exact(input, output, cancellation)?;
            if compact_accepts(output, target_bytes)? {
                return Ok(compact_success(target_bytes, Some(true), "compact_png_exact".into()));
            }
            Err(compact_unreachable(output, format, target_bytes))
        }
        OutputFormat::Webp => {
            encode_lossless_raster(input, output, ImageFormat::WebP, cancellation)?;
            if compact_accepts(output, target_bytes)? {
                return Ok(compact_success(target_bytes, Some(true), "compact_webp_lossless".into()));
            }
            cleanup_output(output);
            for quality in [95u8, 90, 85, 80, 70, 60, 50, 40, 30, 20, 10, 5] {
                run_cwebp_lossy(input, output, quality, cancellation)?;
                if compact_accepts(output, target_bytes)? {
                    return Ok(compact_success(target_bytes, Some(false), format!("compact_webp_quality_{quality}")));
                }
                cleanup_output(output);
            }
            Err(compact_unreachable(output, format, target_bytes))
        }
        OutputFormat::Jxl => {
            run_cjxl_lossless(input, output, cancellation)?;
            if compact_accepts(output, target_bytes)? {
                return Ok(compact_success(target_bytes, Some(true), "compact_jxl_lossless".into()));
            }
            cleanup_output(output);
            for distance in [0.5f32, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0, 8.0, 12.0, 15.0] {
                run_cjxl_lossy(input, output, distance, cancellation)?;
                if compact_accepts(output, target_bytes)? {
                    return Ok(compact_success(target_bytes, Some(false), format!("compact_jxl_distance_{distance:.1}")));
                }
                cleanup_output(output);
            }
            Err(compact_unreachable(output, format, target_bytes))
        }
        OutputFormat::Avif => {
            run_ffmpeg_avif_quality(input, output, 12, cancellation)?;
            if compact_accepts(output, target_bytes)? {
                return Ok(compact_success(target_bytes, Some(false), "compact_avif_crf_12".into()));
            }
            cleanup_output(output);
            for crf in [16u8, 20, 24, 28, 32, 36, 40, 45, 50, 55, 60, 63] {
                run_ffmpeg_avif_quality(input, output, crf, cancellation)?;
                if compact_accepts(output, target_bytes)? {
                    return Ok(compact_success(target_bytes, Some(false), format!("compact_avif_crf_{crf}")));
                }
                cleanup_output(output);
            }
            Err(compact_unreachable(output, format, target_bytes))
        }
        OutputFormat::Jpeg => {
            encode_jpeg_quality(input, output, 95, cancellation)?;
            if compact_accepts(output, target_bytes)? {
                return Ok(compact_success(target_bytes, Some(false), "compact_jpeg_quality_95".into()));
            }
            cleanup_output(output);
            for quality in [90u8, 85, 80, 70, 60, 50, 40, 30, 20, 10, 5] {
                encode_jpeg_quality(input, output, quality, cancellation)?;
                if compact_accepts(output, target_bytes)? {
                    return Ok(compact_success(target_bytes, Some(false), format!("compact_jpeg_quality_{quality}")));
                }
                cleanup_output(output);
            }
            Err(compact_unreachable(output, format, target_bytes))
        }
        OutputFormat::Tiff => {
            encode_lossless_raster(input, output, ImageFormat::Tiff, cancellation)?;
            if compact_accepts(output, target_bytes)? {
                Ok(compact_success(target_bytes, Some(true), "compact_tiff_lossless".into()))
            } else {
                Err(compact_unreachable(output, format, target_bytes))
            }
        }
        OutputFormat::Bmp => {
            encode_lossless_raster(input, output, ImageFormat::Bmp, cancellation)?;
            if compact_accepts(output, target_bytes)? {
                Ok(compact_success(target_bytes, Some(true), "compact_bmp_lossless".into()))
            } else {
                Err(compact_unreachable(output, format, target_bytes))
            }
        }
    }
}

fn run_cwebp_lossy(
    input: &Path,
    output: &Path,
    quality: u8,
    cancellation: &CancellationToken,
) -> Result<(), Agent2DError> {
    let prepared = prepare_png_for_backend(input, cancellation, &["avif", "jxl"])?;
    let source = prepared.as_deref().unwrap_or(input);
    let result = run_backend(
        "cwebp",
        vec![
            "-quiet".into(),
            "-q".into(),
            quality.to_string().into(),
            "-m".into(),
            "6".into(),
            source.as_os_str().into(),
            "-o".into(),
            output.as_os_str().into(),
        ],
        output,
        cancellation,
    );
    if let Some(path) = prepared {
        cleanup_output(&path);
    }
    result
}

fn run_cjxl_lossy(
    input: &Path,
    output: &Path,
    distance: f32,
    cancellation: &CancellationToken,
) -> Result<(), Agent2DError> {
    let prepared = prepare_png_for_backend(input, cancellation, &["webp", "avif", "jxl"])?;
    let source = prepared.as_deref().unwrap_or(input);
    let result = run_backend(
        "cjxl",
        vec![
            source.as_os_str().into(),
            output.as_os_str().into(),
            "-d".into(),
            format!("{distance:.1}").into(),
            "-e".into(),
            "7".into(),
            "--quiet".into(),
        ],
        output,
        cancellation,
    );
    if let Some(path) = prepared {
        cleanup_output(&path);
    }
    result
}

fn run_ffmpeg_avif_quality(
    input: &Path,
    output: &Path,
    crf: u8,
    cancellation: &CancellationToken,
) -> Result<(), Agent2DError> {
    run_backend(
        "ffmpeg",
        vec![
            "-hide_banner".into(),
            "-loglevel".into(),
            "error".into(),
            "-n".into(),
            "-i".into(),
            input.as_os_str().into(),
            "-frames:v".into(),
            "1".into(),
            "-c:v".into(),
            "libaom-av1".into(),
            "-still-picture".into(),
            "1".into(),
            "-crf".into(),
            crf.to_string().into(),
            "-cpu-used".into(),
            "4".into(),
            "-pix_fmt".into(),
            "yuv444p10le".into(),
            "-f".into(),
            "avif".into(),
            output.as_os_str().into(),
        ],
        output,
        cancellation,
    )
}

fn prepare_png_for_backend(
    input: &Path,
    cancellation: &CancellationToken,
    extensions: &[&str],
) -> Result<Option<PathBuf>, Agent2DError> {
    let extension = input
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .unwrap_or_default();
    if !extensions.contains(&extension.as_str()) {
        return Ok(None);
    }
    let temp = temporary_png_path();
    if let Err(error) = run_ffmpeg_png_decode(input, &temp, cancellation) {
        cleanup_output(&temp);
        return Err(error);
    }
    Ok(Some(temp))
}

fn temporary_png_path() -> PathBuf {
    std::env::temp_dir().join(format!("agent2d-codec-{}.png", Uuid::new_v4()))
}

fn run_backend(
    backend: &str,
    args: Vec<OsString>,
    output_path: &Path,
    cancellation: &CancellationToken,
) -> Result<(), Agent2DError> {
    let backend_path = backend_command_path(backend).ok_or_else(|| Agent2DError::BackendUnavailable {
        backend: backend.to_owned(),
    })?;
    let mut child = Command::new(backend_path)
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                Agent2DError::BackendUnavailable {
                    backend: backend.to_owned(),
                }
            } else {
                Agent2DError::BackendFailed {
                    backend: backend.to_owned(),
                    message: error.to_string(),
                }
            }
        })?;

    loop {
        if cancellation.is_cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            cleanup_output(output_path);
            return Err(Agent2DError::Cancelled);
        }
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(_)) => {
                cleanup_output(output_path);
                return Err(Agent2DError::BackendFailed {
                    backend: backend.to_owned(),
                    message: "backend exited with a non-zero status".into(),
                });
            }
            Ok(None) => thread::sleep(Duration::from_millis(25)),
            Err(error) => {
                cleanup_output(output_path);
                return Err(Agent2DError::BackendFailed {
                    backend: backend.to_owned(),
                    message: error.to_string(),
                });
            }
        }
    }
}

fn probe_dimensions(path: &Path) -> Result<(u32, u32), Agent2DError> {
    let ffprobe = backend_command_path("ffprobe").ok_or_else(|| Agent2DError::BackendUnavailable {
        backend: "ffprobe".into(),
    })?;
    let output = Command::new(ffprobe)
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-of",
            "csv=s=x:p=0",
        ])
        .arg(path)
        .output()
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                Agent2DError::BackendUnavailable {
                    backend: "ffprobe".into(),
                }
            } else {
                Agent2DError::ProbeFailed {
                    message: error.to_string(),
                }
            }
        })?;
    if !output.status.success() {
        return Err(Agent2DError::ProbeFailed {
            message: bounded_stderr(&output.stderr),
        });
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let (width, height) = text
        .trim()
        .split_once('x')
        .ok_or_else(|| Agent2DError::ProbeFailed {
            message: format!("unexpected ffprobe output: {}", text.trim()),
        })?;
    let width = width
        .parse::<u32>()
        .map_err(|error| Agent2DError::ProbeFailed {
            message: error.to_string(),
        })?;
    let height = height
        .parse::<u32>()
        .map_err(|error| Agent2DError::ProbeFailed {
            message: error.to_string(),
        })?;
    Ok((width, height))
}

fn bounded_stderr(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let chars: Vec<char> = text.chars().collect();
    let start = chars.len().saturating_sub(2000);
    chars[start..].iter().collect::<String>().trim().to_owned()
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn compression_mode_name(mode: CompressionMode) -> &'static str {
    match mode {
        CompressionMode::Exact => "exact",
        CompressionMode::Preserve => "preserve",
        CompressionMode::Compact => "compact",
    }
}

fn output_format_name(format: OutputFormat) -> &'static str {
    match format {
        OutputFormat::Png => "png",
        OutputFormat::Jpeg => "jpeg",
        OutputFormat::Webp => "webp",
        OutputFormat::Avif => "avif",
        OutputFormat::Jxl => "jxl",
        OutputFormat::Tiff => "tiff",
        OutputFormat::Bmp => "bmp",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageFormat, Rgb, RgbImage};
    use std::path::PathBuf;
    use tempfile::tempdir;

    fn write_fixture(path: &Path) {
        let mut image = RgbImage::new(96, 64);
        for (x, y, pixel) in image.enumerate_pixels_mut() {
            *pixel = Rgb([
                ((x * 3 + y) % 256) as u8,
                ((y * 5 + x) % 256) as u8,
                ((x + y * 2) % 256) as u8,
            ]);
        }
        image.save_with_format(path, ImageFormat::Png).unwrap();
    }

    fn request(
        input: PathBuf,
        output: PathBuf,
        mode: CompressionMode,
        format: OutputFormat,
    ) -> CompressRequest {
        CompressRequest {
            input_path: input,
            output_path: output,
            mode,
            format: Some(format),
            target_bytes: None,
            preserve_metadata: Some(false),
        }
    }

    fn command_exists(name: &str) -> bool {
        Command::new(name).arg("-version").output().is_ok()
            || Command::new(name).arg("--version").output().is_ok()
    }

    #[test]
    fn png_exact_round_trip_has_same_pixel_digest() {
        let dir = tempdir().unwrap();
        let input = dir.path().join("input.png");
        let output = dir.path().join("output.png");
        write_fixture(&input);
        let before = pixel_digest(&input).unwrap();
        let result = compress_image(&request(
            input.clone(),
            output.clone(),
            CompressionMode::Exact,
            OutputFormat::Png,
        ))
        .unwrap();
        assert_eq!(result.pixel_exact, Some(true));
        assert_eq!(result.input_width, result.output_width);
        assert_eq!(before, pixel_digest(&output).unwrap());
    }

    #[test]
    fn tiff_and_bmp_exact_round_trip_are_pixel_exact() {
        let dir = tempdir().unwrap();
        let input = dir.path().join("input.png");
        write_fixture(&input);
        let before = pixel_digest(&input).unwrap();
        for (format, extension) in [(OutputFormat::Tiff, "tiff"), (OutputFormat::Bmp, "bmp")] {
            let output = dir.path().join(format!("output.{extension}"));
            let result = compress_image(&request(
                input.clone(),
                output.clone(),
                CompressionMode::Exact,
                format,
            ))
            .unwrap();
            assert_eq!(result.pixel_exact, Some(true));
            assert_eq!((result.output_width, result.output_height), (96, 64));
            assert_eq!(before, pixel_digest(&output).unwrap());
        }
    }

    #[test]
    fn webp_lossless_round_trip_is_pixel_exact_when_cwebp_exists() {
        if !command_exists("cwebp") {
            return;
        }
        let dir = tempdir().unwrap();
        let input = dir.path().join("input.png");
        let output = dir.path().join("output.webp");
        write_fixture(&input);
        let result = compress_image(&request(
            input,
            output,
            CompressionMode::Exact,
            OutputFormat::Webp,
        ))
        .unwrap();
        assert_eq!(result.pixel_exact, Some(true));
        assert_eq!(result.codec.as_deref(), Some("webp"));
    }

    #[test]
    fn avif_preserve_keeps_dimensions_when_ffmpeg_exists() {
        if !command_exists("ffmpeg") || !command_exists("ffprobe") {
            return;
        }
        let dir = tempdir().unwrap();
        let input = dir.path().join("input.png");
        let output = dir.path().join("output.avif");
        write_fixture(&input);
        let result = compress_image(&request(
            input,
            output,
            CompressionMode::Preserve,
            OutputFormat::Avif,
        ))
        .unwrap();
        assert_eq!((result.output_width, result.output_height), (96, 64));
        assert_eq!(result.pixel_exact, Some(false));
        assert_eq!(result.codec.as_deref(), Some("avif"));
    }

    #[test]
    fn jpeg_preserve_accepts_png_input_when_ffmpeg_exists() {
        if !command_exists("ffmpeg") {
            return;
        }
        let dir = tempdir().unwrap();
        let input = dir.path().join("input.png");
        let output = dir.path().join("output.jpeg");
        write_fixture(&input);
        let result = compress_image(&request(
            input,
            output,
            CompressionMode::Preserve,
            OutputFormat::Jpeg,
        ))
        .unwrap();
        assert_eq!((result.output_width, result.output_height), (96, 64));
        assert_eq!(result.pixel_exact, Some(false));
        assert_eq!(result.codec.as_deref(), Some("jpeg"));
    }

    #[test]
    fn jxl_lossless_is_pixel_exact_when_cjxl_exists() {
        if !command_exists("cjxl") || !command_exists("ffmpeg") || !command_exists("ffprobe") {
            return;
        }
        let dir = tempdir().unwrap();
        let input = dir.path().join("input.png");
        let output = dir.path().join("output.jxl");
        write_fixture(&input);
        let result = compress_image(&request(
            input.clone(),
            output.clone(),
            CompressionMode::Exact,
            OutputFormat::Jxl,
        ))
        .unwrap();
        assert_eq!(result.pixel_exact, Some(true));
        assert_eq!(result.codec.as_deref(), Some("jxl"));
        assert_eq!(
            pixel_digest(&input).unwrap(),
            pixel_digest(&output).unwrap()
        );
    }

    #[test]
    fn avif_input_can_convert_back_to_pixel_exact_png() {
        if !command_exists("ffmpeg") || !command_exists("ffprobe") {
            return;
        }
        let dir = tempdir().unwrap();
        let source = dir.path().join("source.png");
        let avif = dir.path().join("source.avif");
        let png = dir.path().join("converted.png");
        write_fixture(&source);
        compress_image(&request(
            source,
            avif.clone(),
            CompressionMode::Preserve,
            OutputFormat::Avif,
        ))
        .unwrap();
        let result = compress_image(&request(
            avif,
            png,
            CompressionMode::Exact,
            OutputFormat::Png,
        ))
        .unwrap();
        assert_eq!(result.pixel_exact, Some(true));
        assert_eq!((result.output_width, result.output_height), (96, 64));
    }

    #[test]
    fn jpeg_compact_respects_target_bytes_when_ffmpeg_exists() {
        if !command_exists("ffmpeg") {
            return;
        }
        let dir = tempdir().unwrap();
        let input = dir.path().join("input.png");
        let output = dir.path().join("output.jpeg");
        write_fixture(&input);
        let mut compact = request(
            input,
            output.clone(),
            CompressionMode::Compact,
            OutputFormat::Jpeg,
        );
        compact.target_bytes = Some(4_000);
        let result = compress_image(&compact).unwrap();
        assert!(result.output_bytes <= 4_000);
        assert!(result.warnings.iter().any(|warning| warning == "compact_target_met"));
        assert_eq!((result.output_width, result.output_height), (96, 64));
        assert!(output.exists());
    }

    #[test]
    fn compact_png_fails_closed_when_exact_output_cannot_meet_cap() {
        let dir = tempdir().unwrap();
        let input = dir.path().join("input.png");
        let output = dir.path().join("output.png");
        write_fixture(&input);
        let mut compact = request(
            input,
            output.clone(),
            CompressionMode::Compact,
            OutputFormat::Png,
        );
        compact.target_bytes = Some(1);
        let error = compress_image(&compact).unwrap_err();
        assert_eq!(error.code(), "unsupported_compression");
        assert!(!output.exists());
    }

    #[test]
    fn existing_output_is_refused() {
        let dir = tempdir().unwrap();
        let input = dir.path().join("input.png");
        let output = dir.path().join("output.png");
        write_fixture(&input);
        fs::write(&output, b"occupied").unwrap();
        let error = compress_image(&request(
            input,
            output,
            CompressionMode::Exact,
            OutputFormat::Png,
        ))
        .unwrap_err();
        assert_eq!(error.code(), "output_exists");
    }
}
