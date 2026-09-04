use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use agent2d_core::{
    Agent2DError, Agent2DResult, CancellationToken, InspectRequest, SuperResolutionMode,
    SuperResolutionPreset, UpscaleRequest, UpscaleScale, cleanup_output, inspect_image,
    validate_output_path,
};
use image::{GenericImageView, imageops::FilterType};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

mod runtime;
use runtime::{DEFAULT_MODEL, discover_runtime};
pub use runtime::{
    RUNTIME_ARCHIVE_SHA256, RUNTIME_RELEASE_ID, RUNTIME_SOURCE_URL, RuntimeStatus, install_runtime,
    runtime_status,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDescriptor {
    pub id: String,
    pub native_scale: u8,
    pub family: String,
    pub runtime: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SrCapabilities {
    pub backend: String,
    pub backend_path: PathBuf,
    pub model_dir: PathBuf,
    pub models: Vec<ModelDescriptor>,
}

pub fn capabilities() -> Result<SrCapabilities, Agent2DError> {
    let runtime = discover_runtime()?;
    let models = discover_models(&runtime.model_dir)?;
    Ok(SrCapabilities {
        backend: "realesrgan-ncnn-vulkan-managed".to_owned(),
        backend_path: runtime.backend,
        model_dir: runtime.model_dir,
        models,
    })
}

pub fn upscale_image(request: &UpscaleRequest) -> Result<Agent2DResult, Agent2DError> {
    upscale_image_with_cancel(request, &CancellationToken::new())
}

pub fn upscale_image_with_cancel(
    request: &UpscaleRequest,
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

    let runtime = discover_runtime()?;
    let models = discover_models(&runtime.model_dir)?;
    let model_id = resolve_model_id(request, &models)?;
    let requested_scale = request.scale.unwrap_or(UpscaleScale::X2).get();
    if requested_scale == 1 {
        return Err(Agent2DError::UnsupportedUpscale {
            message: "scale 1 is a no-SR conversion path and must be handled by the caller without starting the NCNN runtime".into(),
        });
    }
    let output_format = output_format_for_path(&request.output_path)?;
    if request.target_width.is_some() || request.target_height.is_some() {
        return Err(Agent2DError::UnsupportedUpscale {
            message: "custom target dimensions are not supported by the managed official NCNN runtime; use scale 2/3/4".into(),
        });
    }

    let model_native_scale = models
        .iter()
        .find(|model| model.id == model_id)
        .map(|model| model.native_scale)
        .unwrap_or(requested_scale);
    let backend_scale = if model_native_scale > 0 && requested_scale < model_native_scale {
        model_native_scale
    } else {
        requested_scale
    };
    let needs_downsample = backend_scale != requested_scale;
    let backend_output = if needs_downsample {
        std::env::temp_dir().join(format!(
            "agent2d-sr-native-{backend_scale}x-{}.png",
            Uuid::new_v4()
        ))
    } else {
        request.output_path.clone()
    };
    let backend_format = if needs_downsample { "png" } else { output_format };

    let prepared_input = prepare_sr_input(&request.input_path, &input.format, cancellation)?;
    let backend_input = prepared_input.as_deref().unwrap_or(&request.input_path);
    let args: Vec<OsString> = vec![
        "-i".into(),
        backend_input.as_os_str().into(),
        "-o".into(),
        backend_output.as_os_str().into(),
        "-m".into(),
        runtime.model_dir.as_os_str().into(),
        "-n".into(),
        model_id.clone().into(),
        "-s".into(),
        backend_scale.to_string().into(),
        "-t".into(),
        "0".into(),
        "-f".into(),
        backend_format.into(),
    ];

    let expected = Some((
        input.width * requested_scale as u32,
        input.height * requested_scale as u32,
    ));

    let run_result = run_ncnn(&runtime.backend, &args, &backend_output, cancellation);
    if let Some(path) = prepared_input.as_ref() {
        cleanup_output(path);
    }
    if let Err(error) = run_result {
        if needs_downsample {
            cleanup_output(&backend_output);
        }
        return Err(error);
    }

    if needs_downsample {
        if cancellation.is_cancelled() {
            cleanup_output(&backend_output);
            cleanup_output(&request.output_path);
            return Err(Agent2DError::Cancelled);
        }
        let native = match image::open(&backend_output) {
            Ok(image) => image,
            Err(source) => {
                cleanup_output(&backend_output);
                cleanup_output(&request.output_path);
                return Err(Agent2DError::ImageDecode {
                    path: display_path(&backend_output),
                    source,
                });
            }
        };
        let target_width = input.width * requested_scale as u32;
        let target_height = input.height * requested_scale as u32;
        let resized = native.resize_exact(target_width, target_height, FilterType::Lanczos3);
        if let Err(error) = resized.save(&request.output_path) {
            cleanup_output(&backend_output);
            cleanup_output(&request.output_path);
            return Err(Agent2DError::ImageWrite {
                path: display_path(&request.output_path),
                message: error.to_string(),
            });
        }
        cleanup_output(&backend_output);
    }

    let output_bytes = fs::metadata(&request.output_path)
        .map_err(|error| Agent2DError::ImageWrite {
            path: display_path(&request.output_path),
            message: error.to_string(),
        })?
        .len();
    let decoded =
        image::open(&request.output_path).map_err(|source| Agent2DError::ImageDecode {
            path: display_path(&request.output_path),
            source,
        })?;
    let (output_width, output_height) = decoded.dimensions();

    if let Some((expected_width, expected_height)) = expected {
        if (output_width, output_height) != (expected_width, expected_height) {
            cleanup_output(&request.output_path);
            return Err(Agent2DError::ProbeFailed {
                message: format!(
                    "upscale dimensions expected {expected_width}x{expected_height}, got {output_width}x{output_height}"
                ),
            });
        }
    }

    if cancellation.is_cancelled() {
        cleanup_output(&request.output_path);
        return Err(Agent2DError::Cancelled);
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
        model_id: Some(model_id),
        codec: None,
        pixel_exact: Some(false),
        elapsed_ms: started.elapsed().as_millis() as u64,
        warnings: {
            let mut warnings = vec![
                "super_resolution_may_generate_plausible_details".into(),
                format!("managed_runtime_{}", RUNTIME_RELEASE_ID),
            ];
            if needs_downsample {
                warnings.push(format!(
                    "native_scale_{backend_scale}_downsampled_to_{requested_scale}_lanczos3"
                ));
            }
            warnings
        },
    })
}

fn prepare_sr_input(
    input: &Path,
    format: &str,
    cancellation: &CancellationToken,
) -> Result<Option<PathBuf>, Agent2DError> {
    if !matches!(format, "avif" | "jxl") {
        return Ok(None);
    }
    let temp = std::env::temp_dir().join(format!("agent2d-sr-input-{}.png", Uuid::new_v4()));
    let mut child = Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-n", "-i"])
        .arg(input)
        .args(["-frames:v", "1", "-c:v", "png"])
        .arg(&temp)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                Agent2DError::BackendUnavailable {
                    backend: "ffmpeg".into(),
                }
            } else {
                Agent2DError::BackendFailed {
                    backend: "ffmpeg".into(),
                    message: error.to_string(),
                }
            }
        })?;

    loop {
        if cancellation.is_cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            cleanup_output(&temp);
            return Err(Agent2DError::Cancelled);
        }
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(Some(temp)),
            Ok(Some(_)) => {
                cleanup_output(&temp);
                return Err(Agent2DError::BackendFailed {
                    backend: "ffmpeg".into(),
                    message: "input conversion for super-resolution failed".into(),
                });
            }
            Ok(None) => thread::sleep(Duration::from_millis(25)),
            Err(error) => {
                cleanup_output(&temp);
                return Err(Agent2DError::BackendFailed {
                    backend: "ffmpeg".into(),
                    message: error.to_string(),
                });
            }
        }
    }
}

fn run_ncnn(
    backend: &Path,
    args: &[OsString],
    output_path: &Path,
    cancellation: &CancellationToken,
) -> Result<(), Agent2DError> {
    let backend_label = "realesrgan-ncnn-vulkan-managed";
    let mut child = Command::new(backend)
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                Agent2DError::BackendUnavailable {
                    backend: display_path(backend),
                }
            } else {
                Agent2DError::BackendFailed {
                    backend: backend_label.into(),
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
                    backend: backend_label.into(),
                    message: "backend exited with a non-zero status".into(),
                });
            }
            Ok(None) => thread::sleep(Duration::from_millis(25)),
            Err(error) => {
                cleanup_output(output_path);
                return Err(Agent2DError::BackendFailed {
                    backend: backend_label.into(),
                    message: error.to_string(),
                });
            }
        }
    }
}

fn discover_models(model_dir: &Path) -> Result<Vec<ModelDescriptor>, Agent2DError> {
    let entries = fs::read_dir(model_dir).map_err(|error| Agent2DError::BackendFailed {
        backend: "model_registry".into(),
        message: error.to_string(),
    })?;
    let mut models: Vec<ModelDescriptor> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("param") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        let bin = model_dir.join(format!("{stem}.bin"));
        if !bin.is_file() {
            continue;
        }
        let (id, native_scale) = if stem.starts_with("realesr-animevideov3-x") {
            ("realesr-animevideov3".to_owned(), 0)
        } else {
            (stem.to_owned(), native_scale_from_id(stem))
        };
        if models.iter().any(|model| model.id == id) {
            continue;
        }
        models.push(ModelDescriptor {
            id,
            native_scale,
            family: "real-esrgan-official".into(),
            runtime: "realesrgan-ncnn-vulkan".into(),
        });
    }
    models.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(models)
}

fn resolve_model_id(
    request: &UpscaleRequest,
    models: &[ModelDescriptor],
) -> Result<String, Agent2DError> {
    let desired =
        request
            .model_id
            .clone()
            .unwrap_or_else(|| match (request.mode, request.preset) {
                (_, Some(SuperResolutionPreset::Illustration)) => "realesrgan-x4plus-anime".into(),
                (SuperResolutionMode::Fidelity, _) => "realesrgan-x4plus".into(),
                (SuperResolutionMode::Perceptual, _) => "realesrgan-x4plus".into(),
                _ => DEFAULT_MODEL.into(),
            });
    if models.iter().any(|model| model.id == desired) {
        Ok(desired)
    } else {
        Err(Agent2DError::ModelNotFound { model: desired })
    }
}

fn native_scale_from_id(id: &str) -> u8 {
    if id.ends_with("-x2") || id.ends_with("-2x") {
        2
    } else if id.ends_with("-x3") || id.ends_with("-3x") {
        3
    } else {
        4
    }
}

fn output_format_for_path(path: &Path) -> Result<&'static str, Agent2DError> {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => Ok("png"),
        Some("jpg") | Some("jpeg") => Ok("jpg"),
        Some("webp") => Ok("webp"),
        other => Err(Agent2DError::UnsupportedUpscale {
            message: format!("unsupported output extension: {other:?}"),
        }),
    }
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageFormat, Rgb, RgbImage};
    use tempfile::tempdir;

    #[test]
    fn capability_registry_discovers_managed_models_when_available() {
        let Ok(capabilities) = capabilities() else {
            return;
        };
        assert!(
            capabilities
                .models
                .iter()
                .any(|model| model.id == DEFAULT_MODEL)
        );
    }

    #[test]
    fn actual_x2_upscale_uses_ncnn_backend_when_available() {
        if capabilities().is_err() {
            return;
        }
        let dir = tempdir().unwrap();
        let input = dir.path().join("input.png");
        let output = dir.path().join("output.png");
        let mut image = RgbImage::new(24, 16);
        for (x, y, pixel) in image.enumerate_pixels_mut() {
            *pixel = Rgb([
                ((x * 11 + y * 3) % 256) as u8,
                ((x * 5 + y * 13) % 256) as u8,
                ((x * 7 + y * 17) % 256) as u8,
            ]);
        }
        image.save_with_format(&input, ImageFormat::Png).unwrap();

        let result = upscale_image(&UpscaleRequest {
            input_path: input,
            output_path: output,
            scale: Some(UpscaleScale::X2),
            target_width: None,
            target_height: None,
            mode: SuperResolutionMode::Balanced,
            preset: Some(SuperResolutionPreset::General),
            model_id: Some(DEFAULT_MODEL.into()),
        })
        .unwrap();

        assert_eq!((result.output_width, result.output_height), (48, 32));
        assert_eq!(result.model_id.as_deref(), Some(DEFAULT_MODEL));
        assert!(result.output_bytes > 0);
        if DEFAULT_MODEL == "realesrgan-x4plus" {
            assert!(
                result
                    .warnings
                    .iter()
                    .any(|warning| warning == "native_scale_4_downsampled_to_2_lanczos3")
            );
        }
    }

    #[test]
    fn actual_x4plus_x4_uses_native_scale_without_downsample_when_available() {
        if capabilities().is_err() {
            return;
        }
        let dir = tempdir().unwrap();
        let input = dir.path().join("input-x4.png");
        let output = dir.path().join("output-x4.png");
        RgbImage::from_pixel(12, 8, Rgb([24, 80, 160]))
            .save_with_format(&input, ImageFormat::Png)
            .unwrap();

        let result = upscale_image(&UpscaleRequest {
            input_path: input,
            output_path: output,
            scale: Some(UpscaleScale::X4),
            target_width: None,
            target_height: None,
            mode: SuperResolutionMode::Fidelity,
            preset: None,
            model_id: Some("realesrgan-x4plus".into()),
        })
        .unwrap();

        assert_eq!((result.output_width, result.output_height), (48, 32));
        assert!(!result.warnings.iter().any(|warning| warning.contains("downsampled")));
    }
}
