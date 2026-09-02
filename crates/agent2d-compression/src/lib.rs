use std::{
    fs::{self, File},
    path::Path,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use agent2d_core::{
    Agent2DError, Agent2DResult, CancellationToken, CompressRequest, CompressionMode,
    InspectRequest, OutputFormat, cleanup_output, inspect_image, validate_output_path,
};
use image::{
    ColorType, GenericImageView, ImageEncoder,
    codecs::png::{CompressionType, FilterType, PngEncoder},
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
            if input.bit_depth != 8 {
                return Err(Agent2DError::UnsupportedCompression {
                    mode: "exact".into(),
                    format: "png_non_8_bit".into(),
                });
            }
            encode_png_exact(&request.input_path, &request.output_path)?;
            if cancellation.is_cancelled() {
                cleanup_output(&request.output_path);
                return Err(Agent2DError::Cancelled);
            }
            verify_pixel_exact(&request.input_path, &request.output_path)?;
            Some(true)
        }
        (CompressionMode::Exact, OutputFormat::Webp) => {
            run_cwebp_lossless(&request.input_path, &request.output_path, cancellation)?;
            verify_pixel_exact(&request.input_path, &request.output_path)?;
            Some(true)
        }
        (CompressionMode::Preserve, OutputFormat::Avif) => {
            run_ffmpeg_avif_preserve(&request.input_path, &request.output_path, cancellation)?;
            warnings.push("avif_preserve_is_visually_lossless_not_pixel_exact".to_owned());
            Some(false)
        }
        (mode, format) => {
            return Err(Agent2DError::UnsupportedCompression {
                mode: compression_mode_name(mode).into(),
                format: output_format_name(format).into(),
            });
        }
    };

    let output_bytes = fs::metadata(&request.output_path)
        .map_err(|error| Agent2DError::ImageWrite {
            path: display_path(&request.output_path),
            message: error.to_string(),
        })?
        .len();

    let (output_width, output_height) = match format {
        OutputFormat::Png | OutputFormat::Webp => {
            let decoded =
                image::open(&request.output_path).map_err(|source| Agent2DError::ImageDecode {
                    path: display_path(&request.output_path),
                    source,
                })?;
            decoded.dimensions()
        }
        OutputFormat::Avif => probe_dimensions(&request.output_path)?,
        OutputFormat::Jpeg => unreachable!("JPEG compression is not enabled in F2"),
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
    let decoded = image::open(path).map_err(|source| Agent2DError::ImageDecode {
        path: display_path(path),
        source,
    })?;
    let rgba = decoded.to_rgba8();
    let (width, height) = rgba.dimensions();
    let mut hasher = Sha256::new();
    hasher.update(width.to_le_bytes());
    hasher.update(height.to_le_bytes());
    hasher.update(rgba.as_raw());
    Ok(PixelDigest {
        width,
        height,
        sha256: format!("{:x}", hasher.finalize()),
    })
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

fn encode_png_exact(input: &Path, output: &Path) -> Result<(), Agent2DError> {
    let decoded = image::open(input).map_err(|source| Agent2DError::ImageDecode {
        path: display_path(input),
        source,
    })?;
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

fn run_cwebp_lossless(
    input: &Path,
    output: &Path,
    cancellation: &CancellationToken,
) -> Result<(), Agent2DError> {
    run_backend(
        "cwebp",
        [
            "-quiet".into(),
            "-lossless".into(),
            "-z".into(),
            "9".into(),
            input.as_os_str().into(),
            "-o".into(),
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
        [
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

fn run_backend<const N: usize>(
    backend: &str,
    args: [std::ffi::OsString; N],
    output_path: &Path,
    cancellation: &CancellationToken,
) -> Result<(), Agent2DError> {
    let mut child = Command::new(backend)
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
    let output = Command::new("ffprobe")
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
