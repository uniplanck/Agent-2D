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
use image::GenericImageView;
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
    let scale = request.scale.unwrap_or(UpscaleScale::X2).get();
    let output_format = output_format_for_path(&request.output_path)?;

    let args: Vec<OsString> = vec![
        "-i".into(),
        request.input_path.as_os_str().into(),
        "-o".into(),
        request.output_path.as_os_str().into(),
        "-m".into(),
        runtime.model_dir.as_os_str().into(),
        "-n".into(),
        model_id.clone().into(),
        "-s".into(),
        scale.to_string().into(),
        "-t".into(),
        "0".into(),
        "-f".into(),
        output_format.into(),
    ];

    if request.target_width.is_some() || request.target_height.is_some() {
        return Err(Agent2DError::UnsupportedUpscale {
            message: "custom target dimensions are not supported by the managed official NCNN runtime; use scale 2/3/4".into(),
        });
    }
    let expected = Some((input.width * scale as u32, input.height * scale as u32));

    run_ncnn(&runtime.backend, &args, &request.output_path, cancellation)?;

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
        warnings: vec![
            "super_resolution_may_generate_plausible_details".into(),
            format!("managed_runtime_{}", RUNTIME_RELEASE_ID),
        ],
    })
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
    }
}
