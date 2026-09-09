use std::{
    collections::HashMap,
    fs,
    io::Cursor,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use agent2d_compression::compress_image_with_cancel;
use agent2d_core::{
    Agent2DError, Agent2DResult, BackgroundRemovalRequest, CancellationToken, CompressRequest,
    CompressionMode, CompressionOptions, CustomRequest, ErrorPayload, InspectRequest, InspectResult,
    JobState, ObjectEditAction, ObjectEditRequest, ObjectSelection, ObjectSelectionRequest,
    ObjectSelectionResult, OptimizeRequest, OutputFormat, SuperResolutionMode, SuperResolutionPreset,
    UpscaleOptions, UpscaleRequest, UpscaleScale, VectorizeDetail, VectorizePreset, VectorizeRequest,
    backend_available, backend_command_path, cleanup_output, inspect_image, validate_output_path,
};
use agent2d_pipeline::{
    BackgroundRuntimeStatus, ObjectEditRuntimeStatus, background_runtime_status,
    custom_image_with_cancel, edit_object_with_cancel, install_background_runtime,
    install_object_edit_runtime, object_edit_runtime_status, optimize_image_with_cancel,
    remove_background_with_cancel, segment_object_mask, vectorize_image_with_cancel,
    warm_object_edit_runtime,
};
use agent2d_sr::{SrCapabilities, capabilities, install_runtime, upscale_image_with_cancel};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use image::{DynamicImage, ImageFormat, Rgba, RgbaImage};
use serde::{Deserialize, Serialize};
use tauri::{
    Emitter, State,
    menu::{Menu, MenuItem},
};
use uuid::Uuid;

const MAX_PREVIEW_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendCapabilities {
    ffmpeg: bool,
    ffprobe: bool,
    cwebp: bool,
    cjxl: bool,
    standard_formats: Vec<&'static str>,
    compact_formats: Vec<&'static str>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum DesktopOperation {
    Enhance,
    Compress,
    Optimize,
    Crop,
    Resize,
    Vectorize,
    #[serde(rename = "remove-bg")]
    RemoveBg,
    #[serde(rename = "object-edit")]
    ObjectEdit,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopJobRequest {
    operation: DesktopOperation,
    input_path: String,
    output_path: String,
    scale: u8,
    sr_mode: String,
    compression_mode: String,
    format: String,
    model_id: Option<String>,
    sr_preset: Option<String>,
    target_width: Option<u32>,
    target_height: Option<u32>,
    crop_zoom: Option<f64>,
    crop_x: Option<f64>,
    crop_y: Option<f64>,
    target_bytes: Option<u64>,
    vector_preset: Option<String>,
    vector_detail: Option<String>,
    vector_max_colors: Option<u16>,
    vector_threshold: Option<u8>,
    object_action: Option<ObjectEditAction>,
    object_selection: Option<ObjectSelection>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopJobStatus {
    job_id: String,
    state: JobState,
    fraction: f32,
    stage: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Agent2DResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ErrorPayload>,
}

#[derive(Debug, Clone)]
struct JobRecord {
    status: DesktopJobStatus,
    cancellation: CancellationToken,
}

#[derive(Clone, Default)]
struct JobManager {
    jobs: Arc<Mutex<HashMap<String, JobRecord>>>,
}

fn internal_error(message: impl Into<String>) -> ErrorPayload {
    ErrorPayload {
        code: "desktop_internal_error".into(),
        message: message.into(),
    }
}

fn parse_scale(value: u8) -> Result<UpscaleScale, Agent2DError> {
    match value {
        1 => Ok(UpscaleScale::X1),
        2 => Ok(UpscaleScale::X2),
        4 => Ok(UpscaleScale::X4),
        other => Err(Agent2DError::UnsupportedUpscale {
            message: format!("desktop scale {other} is unsupported; expected 1, 2, or 4"),
        }),
    }
}

fn parse_sr_mode(value: &str) -> Result<SuperResolutionMode, Agent2DError> {
    match value {
        "fidelity" => Ok(SuperResolutionMode::Fidelity),
        "balanced" => Ok(SuperResolutionMode::Balanced),
        "perceptual" => Ok(SuperResolutionMode::Perceptual),
        other => Err(Agent2DError::UnsupportedUpscale {
            message: format!("unsupported SR mode: {other}"),
        }),
    }
}

fn parse_format(value: &str) -> Result<OutputFormat, Agent2DError> {
    match value {
        "png" => Ok(OutputFormat::Png),
        "jpg" | "jpeg" => Ok(OutputFormat::Jpeg),
        "webp" => Ok(OutputFormat::Webp),
        "avif" => Ok(OutputFormat::Avif),
        "jxl" => Ok(OutputFormat::Jxl),
        "tif" | "tiff" => Ok(OutputFormat::Tiff),
        "bmp" => Ok(OutputFormat::Bmp),
        other => Err(Agent2DError::UnsupportedCompression {
            mode: "desktop".into(),
            format: other.into(),
        }),
    }
}

fn parse_sr_preset(value: Option<&str>) -> Result<Option<SuperResolutionPreset>, Agent2DError> {
    match value {
        None | Some("") => Ok(None),
        Some("general") => Ok(Some(SuperResolutionPreset::General)),
        Some("photo") => Ok(Some(SuperResolutionPreset::Photo)),
        Some("illustration") => Ok(Some(SuperResolutionPreset::Illustration)),
        Some("ai-art") => Ok(Some(SuperResolutionPreset::AiArt)),
        Some("graphics") => Ok(Some(SuperResolutionPreset::Graphics)),
        Some(other) => Err(Agent2DError::UnsupportedUpscale { message: format!("unsupported SR preset: {other}") }),
    }
}

fn parse_vector_preset(value: Option<&str>) -> Result<VectorizePreset, Agent2DError> {
    match value.unwrap_or("illustration") {
        "illustration" => Ok(VectorizePreset::Illustration),
        "logo" => Ok(VectorizePreset::Logo),
        "line-art" => Ok(VectorizePreset::LineArt),
        other => Err(Agent2DError::BackendFailed { backend: "vtracer".into(), message: format!("unsupported vector preset: {other}") }),
    }
}

fn parse_vector_detail(value: Option<&str>) -> Result<VectorizeDetail, Agent2DError> {
    match value.unwrap_or("balanced") {
        "clean" => Ok(VectorizeDetail::Clean),
        "balanced" => Ok(VectorizeDetail::Balanced),
        "detailed" => Ok(VectorizeDetail::Detailed),
        other => Err(Agent2DError::BackendFailed { backend: "vtracer".into(), message: format!("unsupported vector detail: {other}") }),
    }
}

fn parse_compression_mode(value: &str) -> Result<CompressionMode, Agent2DError> {
    match value {
        "exact" => Ok(CompressionMode::Exact),
        "preserve" => Ok(CompressionMode::Preserve),
        "compact" => Ok(CompressionMode::Compact),
        other => Err(Agent2DError::UnsupportedCompression {
            mode: other.into(),
            format: "desktop".into(),
        }),
    }
}

fn fit_within_dimensions(input_width: u32, input_height: u32, target_width: u32, target_height: u32) -> (u32, u32) {
    if input_width <= target_width && input_height <= target_height {
        return (input_width, input_height);
    }
    let scale = (target_width as f64 / input_width as f64)
        .min(target_height as f64 / input_height as f64)
        .min(1.0);
    let width = ((input_width as f64 * scale).round() as u32).clamp(1, target_width);
    let height = ((input_height as f64 * scale).round() as u32).clamp(1, target_height);
    (width, height)
}

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
    let ffmpeg = backend_command_path("ffmpeg").ok_or_else(|| Agent2DError::BackendUnavailable {
        backend: "ffmpeg".into(),
    })?;
    let mut child = Command::new(ffmpeg)
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
                    message: "transform backend exited with a non-zero status".into(),
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

fn transform_then_compress(
    request: &DesktopJobRequest,
    cancellation: &CancellationToken,
    crop: bool,
    format: OutputFormat,
    compression_mode: CompressionMode,
) -> Result<Agent2DResult, Agent2DError> {
    let started = Instant::now();
    let input_path = PathBuf::from(&request.input_path);
    let output_path = PathBuf::from(&request.output_path);
    validate_output_path(&input_path, &output_path)?;
    let input = inspect_image(&InspectRequest { input_path: input_path.clone() })?;
    let target_width = request.target_width.filter(|value| *value > 0).ok_or_else(|| Agent2DError::UnsupportedCompression {
        mode: if crop { "crop".into() } else { "resize".into() },
        format: "target_width_required".into(),
    })?;
    let target_height = request.target_height.filter(|value| *value > 0).ok_or_else(|| Agent2DError::UnsupportedCompression {
        mode: if crop { "crop".into() } else { "resize".into() },
        format: "target_height_required".into(),
    })?;
    let temp = std::env::temp_dir().join(format!("agent2d-transform-{}.png", Uuid::new_v4()));
    let (filter, expected_width, expected_height, mut warnings) = if crop {
        let zoom = request.crop_zoom.unwrap_or(1.0).clamp(1.0, 6.0);
        let (x, y, crop_width, crop_height) = crop_geometry(
            input.width,
            input.height,
            target_width,
            target_height,
            zoom,
            request.crop_x.unwrap_or(0.0),
            request.crop_y.unwrap_or(0.0),
        );
        let mut warnings = vec!["crop_to_size_applied".to_owned()];
        if crop_width < target_width || crop_height < target_height {
            warnings.push("crop_interpolated_to_target_size".to_owned());
        }
        (
            format!("crop={crop_width}:{crop_height}:{x}:{y},scale={target_width}:{target_height}:flags=lanczos"),
            target_width,
            target_height,
            warnings,
        )
    } else {
        let (width, height) = fit_within_dimensions(input.width, input.height, target_width, target_height);
        let mut warnings = vec!["resize_fit_within_aspect_preserved".to_owned()];
        if width == input.width && height == input.height {
            warnings.push("resize_no_upscale_source_already_within_bounds".to_owned());
        }
        (format!("scale={width}:{height}:flags=lanczos"), width, height, warnings)
    };

    let transform_result = run_transform_to_png(&input_path, &temp, &filter, cancellation);
    if let Err(error) = transform_result {
        cleanup_output(&temp);
        return Err(error);
    }
    let compressed = compress_image_with_cancel(
        &CompressRequest {
            input_path: temp.clone(),
            output_path: output_path.clone(),
            mode: compression_mode,
            format: Some(format),
            target_bytes: request.target_bytes,
            preserve_metadata: Some(false),
        },
        cancellation,
    );
    cleanup_output(&temp);
    let mut result = compressed?;
    if result.output_width != expected_width || result.output_height != expected_height {
        cleanup_output(&output_path);
        return Err(Agent2DError::ProbeFailed {
            message: format!("transform output dimension mismatch: expected {expected_width}x{expected_height}, got {}x{}", result.output_width, result.output_height),
        });
    }
    result.input_path = input_path;
    result.input_width = input.width;
    result.input_height = input.height;
    result.input_bytes = input.input_bytes;
    result.compression_ratio = if result.output_bytes == 0 { 0.0 } else { input.input_bytes as f64 / result.output_bytes as f64 };
    result.pixel_exact = Some(false);
    result.elapsed_ms = started.elapsed().as_millis() as u64;
    warnings.extend(result.warnings);
    result.warnings = warnings;
    Ok(result)
}

fn execute_job(
    request: &DesktopJobRequest,
    cancellation: &CancellationToken,
) -> Result<Agent2DResult, Agent2DError> {
    let input_path = request.input_path.clone().into();
    let output_path = request.output_path.clone().into();
    let scale = parse_scale(request.scale)?;
    let sr_mode = parse_sr_mode(&request.sr_mode)?;
    let sr_preset = parse_sr_preset(request.sr_preset.as_deref())?;
    let format = parse_format(&request.format)?;
    let compression_mode = parse_compression_mode(&request.compression_mode)?;

    match request.operation {
        DesktopOperation::Enhance => {
            if format != OutputFormat::Png {
                return Err(Agent2DError::UnsupportedCompression {
                    mode: "enhance_without_compression".into(),
                    format: "png_required".into(),
                });
            }
            if scale == UpscaleScale::X1 {
                compress_image_with_cancel(
                    &CompressRequest {
                        input_path,
                        output_path,
                        mode: CompressionMode::Exact,
                        format: Some(OutputFormat::Png),
                        target_bytes: None,
                        preserve_metadata: Some(false),
                    },
                    cancellation,
                ).map(|mut result| {
                    result.warnings.push("enhance_x1_sr_skipped".into());
                    result
                })
            } else {
                upscale_image_with_cancel(
                    &UpscaleRequest {
                        input_path,
                        output_path,
                        scale: Some(scale),
                        target_width: None,
                        target_height: None,
                        mode: sr_mode,
                        preset: sr_preset,
                        model_id: request.model_id.clone().filter(|value| !value.is_empty()),
                    },
                    cancellation,
                )
            }
        },
        DesktopOperation::Compress => compress_image_with_cancel(
            &CompressRequest {
                input_path,
                output_path,
                mode: compression_mode,
                format: Some(format),
                target_bytes: request.target_bytes,
                preserve_metadata: Some(false),
            },
            cancellation,
        ),
        DesktopOperation::Optimize => optimize_image_with_cancel(
            &OptimizeRequest {
                input_path,
                output_path,
                upscale: Some(UpscaleOptions {
                    scale: Some(scale),
                    target_width: None,
                    target_height: None,
                    mode: sr_mode,
                    preset: sr_preset,
                    model_id: request.model_id.clone().filter(|value| !value.is_empty()),
                }),
                compression: CompressionOptions {
                    mode: compression_mode,
                    format: Some(format),
                    target_bytes: request.target_bytes,
                },
            },
            cancellation,
        ),
        DesktopOperation::Crop => {
            let target_width = request.target_width.filter(|value| *value > 0).ok_or_else(|| Agent2DError::UnsupportedCompression {
                mode: "custom".into(),
                format: "target_width_required".into(),
            })?;
            let target_height = request.target_height.filter(|value| *value > 0).ok_or_else(|| Agent2DError::UnsupportedCompression {
                mode: "custom".into(),
                format: "target_height_required".into(),
            })?;
            custom_image_with_cancel(
                &CustomRequest {
                    input_path,
                    output_path,
                    target_width,
                    target_height,
                    zoom: request.crop_zoom.unwrap_or(1.0),
                    offset_x: request.crop_x.unwrap_or(0.0),
                    offset_y: request.crop_y.unwrap_or(0.0),
                    compression: CompressionOptions {
                        mode: compression_mode,
                        format: Some(format),
                        target_bytes: request.target_bytes,
                    },
                },
                cancellation,
            )
        },
        DesktopOperation::Resize => transform_then_compress(request, cancellation, false, format, compression_mode),
        DesktopOperation::Vectorize => vectorize_image_with_cancel(
            &VectorizeRequest {
                input_path,
                output_path,
                preset: parse_vector_preset(request.vector_preset.as_deref())?,
                detail: parse_vector_detail(request.vector_detail.as_deref())?,
                max_colors: request.vector_max_colors,
                threshold: request.vector_threshold,
            },
            cancellation,
        ),
        DesktopOperation::RemoveBg => remove_background_with_cancel(
            &BackgroundRemovalRequest {
                input_path,
                output_path,
                format,
            },
            cancellation,
        ),
        DesktopOperation::ObjectEdit => edit_object_with_cancel(
            &ObjectEditRequest {
                input_path,
                output_path,
                action: request.object_action.ok_or_else(|| Agent2DError::UnsupportedCompression {
                    mode: "object-edit".into(),
                    format: "object_action_required".into(),
                })?,
                format,
                selection: request.object_selection.clone().ok_or_else(|| Agent2DError::UnsupportedCompression {
                    mode: "object-edit".into(),
                    format: "object_selection_required".into(),
                })?,
            },
            cancellation,
        ),
    }
}

fn update_status(
    jobs: &Arc<Mutex<HashMap<String, JobRecord>>>,
    job_id: &str,
    updater: impl FnOnce(&mut DesktopJobStatus),
) {
    if let Ok(mut guard) = jobs.lock() {
        if let Some(record) = guard.get_mut(job_id) {
            updater(&mut record.status);
        }
    }
}

#[tauri::command]
fn inspect_image_command(path: String) -> Result<InspectResult, ErrorPayload> {
    inspect_image(&InspectRequest {
        input_path: path.into(),
    })
    .map_err(|error| error.payload())
}

#[tauri::command]
fn capabilities_command() -> Result<SrCapabilities, ErrorPayload> {
    capabilities().map_err(|error| error.payload())
}

#[tauri::command]
fn backend_capabilities_command() -> BackendCapabilities {
    let ffmpeg = backend_available("ffmpeg");
    let ffprobe = backend_available("ffprobe");
    let cwebp = backend_available("cwebp");
    let cjxl = backend_available("cjxl");
    let mut standard_formats = vec!["png", "jpeg", "webp", "tiff", "bmp"];
    let mut compact_formats = vec!["png", "jpeg", "tiff", "bmp"];
    if cwebp {
        compact_formats.push("webp");
    }
    if ffmpeg && ffprobe {
        standard_formats.push("avif");
        compact_formats.push("avif");
    }
    if cjxl && ffmpeg && ffprobe {
        standard_formats.push("jxl");
        compact_formats.push("jxl");
    }
    BackendCapabilities {
        ffmpeg,
        ffprobe,
        cwebp,
        cjxl,
        standard_formats,
        compact_formats,
    }
}

#[tauri::command]
fn install_runtime_command() -> Result<SrCapabilities, ErrorPayload> {
    install_runtime()
        .and_then(|_| capabilities())
        .map_err(|error| error.payload())
}

#[tauri::command]
fn background_runtime_status_command() -> Result<BackgroundRuntimeStatus, ErrorPayload> {
    background_runtime_status().map_err(|error| error.payload())
}

#[tauri::command]
fn object_edit_runtime_status_command() -> Result<ObjectEditRuntimeStatus, ErrorPayload> {
    object_edit_runtime_status().map_err(|error| error.payload())
}

#[tauri::command]
async fn install_background_runtime_command() -> Result<BackgroundRuntimeStatus, ErrorPayload> {
    tauri::async_runtime::spawn_blocking(install_background_runtime)
        .await
        .map_err(|error| internal_error(format!("background runtime installer task failed: {error}")))?
        .map_err(|error| error.payload())
}

#[tauri::command]
async fn install_object_edit_runtime_command() -> Result<ObjectEditRuntimeStatus, ErrorPayload> {
    tauri::async_runtime::spawn_blocking(install_object_edit_runtime)
        .await
        .map_err(|error| internal_error(format!("object edit runtime installer task failed: {error}")))?
        .map_err(|error| error.payload())
}

#[tauri::command]
async fn warm_object_edit_runtime_command() -> Result<(), ErrorPayload> {
    tauri::async_runtime::spawn_blocking(warm_object_edit_runtime)
        .await
        .map_err(|error| internal_error(format!("object edit runtime warm task failed: {error}")))?
        .map_err(|error| error.payload())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ObjectMaskPreview {
    preview: String,
    score: f64,
    width: u32,
    height: u32,
}

#[tauri::command]
async fn object_mask_preview_command(
    input_path: String,
    selection: ObjectSelection,
) -> Result<ObjectMaskPreview, ErrorPayload> {
    tauri::async_runtime::spawn_blocking(move || {
        let temp = tempfile::tempdir().map_err(|error| internal_error(error.to_string()))?;
        let mask_path = temp.path().join("object-mask-preview.png");
        let result: ObjectSelectionResult = segment_object_mask(&ObjectSelectionRequest {
            input_path: input_path.into(),
            output_mask_path: mask_path.clone(),
            selection,
        }).map_err(|error| error.payload())?;
        let mask = image::open(&mask_path)
            .map_err(|error| internal_error(format!("failed to decode object mask preview: {error}")))?
            .into_luma8();
        let (mask_width, mask_height) = mask.dimensions();
        let alpha_mask = RgbaImage::from_fn(mask_width, mask_height, |x, y| {
            Rgba([255, 255, 255, mask.get_pixel(x, y)[0]])
        });
        let mut encoded = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(alpha_mask)
            .write_to(&mut encoded, ImageFormat::Png)
            .map_err(|error| internal_error(format!("failed to encode object mask preview: {error}")))?;
        Ok(ObjectMaskPreview {
            preview: format!("data:image/png;base64,{}", STANDARD.encode(encoded.into_inner())),
            score: result.score,
            width: result.width,
            height: result.height,
        })
    })
    .await
    .map_err(|error| internal_error(format!("object mask preview task failed: {error}")))?
}

#[tauri::command]
fn preview_image_command(path: String) -> Result<String, ErrorPayload> {
    let path_ref = Path::new(&path);
    let metadata =
        fs::symlink_metadata(path_ref).map_err(|error| internal_error(error.to_string()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(internal_error(
            "preview path must be a regular non-symlink file",
        ));
    }
    if metadata.len() > MAX_PREVIEW_BYTES {
        return Err(internal_error(
            "preview file exceeds the 64 MiB desktop preview limit",
        ));
    }
    let extension = path_ref
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .ok_or_else(|| internal_error("unsupported preview image extension"))?;
    if matches!(extension.as_str(), "tif" | "tiff" | "bmp") {
        let decoded = image::open(path_ref).map_err(|error| internal_error(format!("failed to decode {extension} preview: {error}")))?;
        let mut encoded = Cursor::new(Vec::new());
        decoded.write_to(&mut encoded, ImageFormat::Png).map_err(|error| internal_error(format!("failed to encode preview PNG: {error}")))?;
        if encoded.get_ref().len() as u64 > MAX_PREVIEW_BYTES {
            return Err(internal_error("decoded preview exceeds the 64 MiB desktop preview limit"));
        }
        return Ok(format!("data:image/png;base64,{}", STANDARD.encode(encoded.into_inner())));
    }
    if extension == "jxl" {
        let ffmpeg = backend_command_path("ffmpeg")
            .ok_or_else(|| internal_error("JXL preview backend is unavailable: ffmpeg"))?;
        let output = Command::new(ffmpeg)
            .args(["-hide_banner", "-loglevel", "error", "-i"])
            .arg(path_ref)
            .args([
                "-frames:v",
                "1",
                "-f",
                "image2pipe",
                "-vcodec",
                "png",
                "pipe:1",
            ])
            .output()
            .map_err(|error| internal_error(format!("JXL preview failed to start ffmpeg: {error}")))?;
        if !output.status.success() {
            return Err(internal_error("failed to decode JXL preview"));
        }
        if output.stdout.len() as u64 > MAX_PREVIEW_BYTES {
            return Err(internal_error(
                "decoded JXL preview exceeds the 64 MiB desktop preview limit",
            ));
        }
        return Ok(format!(
            "data:image/png;base64,{}",
            STANDARD.encode(output.stdout)
        ));
    }
    if extension == "svg" {
        let bytes = fs::read(path_ref).map_err(|error| internal_error(error.to_string()))?;
        let svg = std::str::from_utf8(&bytes).map_err(|_| internal_error("SVG preview is not valid UTF-8"))?;
        let lower = svg.to_ascii_lowercase();
        if !lower.contains("<svg") || !lower.contains("<path") {
            return Err(internal_error("SVG preview must contain real vector paths"));
        }
        for unsafe_token in ["<script", "<foreignobject", "<image", "javascript:", "xlink:href", " href="] {
            if lower.contains(unsafe_token) {
                return Err(internal_error("SVG preview contains unsupported active or external content"));
            }
        }
        return Ok(format!("data:image/svg+xml;base64,{}", STANDARD.encode(bytes)));
    }
    let mime = match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "avif" => "image/avif",
        _ => return Err(internal_error("unsupported preview image extension")),
    };
    let bytes = fs::read(path_ref).map_err(|error| internal_error(error.to_string()))?;
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

fn extension_for_output_format(format: &str) -> Result<&'static str, ErrorPayload> {
    match format {
        "png" => Ok("png"),
        "jpg" | "jpeg" => Ok("jpg"),
        "webp" => Ok("webp"),
        "avif" => Ok("avif"),
        "jxl" => Ok("jxl"),
        "tif" | "tiff" => Ok("tiff"),
        "bmp" => Ok("bmp"),
        "svg" => Ok("svg"),
        other => Err(internal_error(format!("unsupported output format: {other}"))),
    }
}

fn unique_output_path(directory: &Path, filename: &str, format: &str) -> Result<PathBuf, ErrorPayload> {
    if !directory.is_dir() {
        return Err(internal_error("output directory does not exist or is not a directory"));
    }
    let trimmed = filename.trim();
    if trimmed.is_empty() {
        return Err(internal_error("output filename is empty"));
    }
    let stem = Path::new(trimmed)
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| internal_error("output filename is invalid"))?;
    let extension = extension_for_output_format(format)?;
    let base = directory.join(format!("{stem}.{extension}"));
    if !base.exists() {
        return Ok(base);
    }
    for index in 2..=9_999 {
        let candidate = directory.join(format!("{stem}_{index:02}.{extension}"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(internal_error("could not allocate a unique output filename"))
}

#[tauri::command]
fn resolve_output_path_command(
    directory: String,
    filename: String,
    format: String,
) -> Result<String, ErrorPayload> {
    unique_output_path(Path::new(&directory), &filename, &format)
        .map(|path| path.to_string_lossy().into_owned())
}

fn path_is_occupied(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

fn unique_alias_path(directory: &Path, source: &Path) -> Result<PathBuf, ErrorPayload> {
    let filename = source
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| internal_error("output path has no valid filename"))?;
    let base = directory.join(filename);
    if !path_is_occupied(&base) {
        return Ok(base);
    }
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| internal_error("output path has no valid filename stem"))?;
    let extension = source.extension().and_then(|value| value.to_str());
    for index in 2..=9_999 {
        let filename = match extension {
            Some(extension) if !extension.is_empty() => format!("{stem}_{index:02}.{extension}"),
            _ => format!("{stem}_{index:02}"),
        };
        let candidate = directory.join(filename);
        if !path_is_occupied(&candidate) {
            return Ok(candidate);
        }
    }
    Err(internal_error("could not allocate a unique output alias filename"))
}

fn create_output_alias_at(source: &Path, directory: &Path) -> Result<PathBuf, ErrorPayload> {
    if !source.is_file() {
        return Err(internal_error("saved output does not exist or is not a file"));
    }
    fs::create_dir_all(directory).map_err(|error| internal_error(format!("failed to create alias directory: {error}")))?;
    if source.parent() == Some(directory) {
        return Ok(source.to_path_buf());
    }
    let destination = unique_alias_path(directory, source)?;
    std::os::unix::fs::symlink(source, &destination)
        .map_err(|error| internal_error(format!("failed to create output alias: {error}")))?;
    Ok(destination)
}

#[tauri::command]
fn create_output_alias_command(output_path: String) -> Result<String, ErrorPayload> {
    let home = std::env::var_os("HOME").ok_or_else(|| internal_error("HOME is unavailable"))?;
    let directory = PathBuf::from(home).join("Pictures").join("Agent-2D");
    create_output_alias_at(Path::new(&output_path), &directory)
        .map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
fn start_job_command(
    request: DesktopJobRequest,
    state: State<'_, JobManager>,
) -> Result<String, ErrorPayload> {
    inspect_image(&InspectRequest {
        input_path: request.input_path.clone().into(),
    })
    .map_err(|error| error.payload())?;

    let job_id = Uuid::new_v4().to_string();
    let cancellation = CancellationToken::new();
    let record = JobRecord {
        status: DesktopJobStatus {
            job_id: job_id.clone(),
            state: JobState::Queued,
            fraction: 0.02,
            stage: "queued".into(),
            result: None,
            error: None,
        },
        cancellation: cancellation.clone(),
    };
    state
        .jobs
        .lock()
        .map_err(|_| internal_error("desktop job registry is unavailable"))?
        .insert(job_id.clone(), record);

    let jobs = state.jobs.clone();
    let thread_job_id = job_id.clone();
    thread::spawn(move || {
        update_status(&jobs, &thread_job_id, |status| {
            status.state = JobState::Running;
            status.fraction = 0.12;
            status.stage = match (request.operation, request.scale) {
                (DesktopOperation::Enhance, 1) => "conversion_only",
                (DesktopOperation::Optimize, 1) => "compression_conversion_only",
                (DesktopOperation::Enhance, _) => "super_resolution",
                (DesktopOperation::Compress, _) => "compression",
                (DesktopOperation::Optimize, _) => "super_resolution_then_compression",
                (DesktopOperation::Crop, _) => "crop_to_size",
                (DesktopOperation::Resize, _) => "resize_to_size",
                (DesktopOperation::Vectorize, _) => "vectorize_svg",
                (DesktopOperation::RemoveBg, _) => "background_removal_feynobg",
                (DesktopOperation::ObjectEdit, _) => "object_edit_sam2_lama",
            }
            .into();
        });

        let outcome = execute_job(&request, &cancellation);
        update_status(&jobs, &thread_job_id, |status| match outcome {
            Ok(result) if cancellation.is_cancelled() => {
                cleanup_output(&result.output_path);
                status.state = JobState::Cancelled;
                status.stage = "cancelled".into();
                status.fraction = 0.0;
            }
            Ok(result) => {
                status.state = JobState::Completed;
                status.stage = "completed".into();
                status.fraction = 1.0;
                status.result = Some(result);
            }
            Err(Agent2DError::Cancelled) => {
                status.state = JobState::Cancelled;
                status.stage = "cancelled".into();
                status.fraction = 0.0;
            }
            Err(error) => {
                status.state = JobState::Failed;
                status.stage = "failed".into();
                status.error = Some(error.payload());
            }
        });
    });

    Ok(job_id)
}

#[tauri::command]
fn job_status_command(
    job_id: String,
    state: State<'_, JobManager>,
) -> Result<DesktopJobStatus, ErrorPayload> {
    let guard = state
        .jobs
        .lock()
        .map_err(|_| internal_error("desktop job registry is unavailable"))?;
    guard
        .get(&job_id)
        .map(|record| record.status.clone())
        .ok_or_else(|| internal_error(format!("unknown job id: {job_id}")))
}

#[tauri::command]
fn cancel_job_command(
    job_id: String,
    state: State<'_, JobManager>,
) -> Result<DesktopJobStatus, ErrorPayload> {
    let mut guard = state
        .jobs
        .lock()
        .map_err(|_| internal_error("desktop job registry is unavailable"))?;
    let record = guard
        .get_mut(&job_id)
        .ok_or_else(|| internal_error(format!("unknown job id: {job_id}")))?;
    if matches!(record.status.state, JobState::Queued | JobState::Running) {
        record.cancellation.cancel();
        record.status.stage = "cancelling".into();
    }
    Ok(record.status.clone())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .menu(|app| {
            let menu = Menu::default(app)?;
            #[cfg(target_os = "macos")]
            if let Some(app_menu) = menu.items()?.first().and_then(|item| item.as_submenu()).cloned() {
                let settings = MenuItem::with_id(
                    app,
                    "agent2d-settings",
                    "Settings…",
                    true,
                    None::<&str>,
                )?;
                app_menu.insert(&settings, 1)?;
            }
            Ok(menu)
        })
        .on_menu_event(|app, event| {
            if event.id() == "agent2d-settings" {
                let _ = app.emit("agent2d://open-settings", ());
            }
        })
        .manage(JobManager::default())
        .invoke_handler(tauri::generate_handler![
            inspect_image_command,
            capabilities_command,
            backend_capabilities_command,
            install_runtime_command,
            background_runtime_status_command,
            install_background_runtime_command,
            object_edit_runtime_status_command,
            install_object_edit_runtime_command,
            warm_object_edit_runtime_command,
            object_mask_preview_command,
            preview_image_command,
            resolve_output_path_command,
            create_output_alias_command,
            start_job_command,
            job_status_command,
            cancel_job_command,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Agent-2D desktop");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_contract_rejects_unsupported_scale() {
        assert!(parse_scale(3).is_err());
        assert!(matches!(parse_scale(1), Ok(UpscaleScale::X1)));
        assert!(matches!(parse_scale(2), Ok(UpscaleScale::X2)));
        assert!(matches!(parse_scale(4), Ok(UpscaleScale::X4)));
    }

    #[test]
    fn collision_names_start_at_02_and_increment() {
        let dir = std::env::temp_dir().join(format!("agent2d-output-naming-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("image.png"), b"existing").unwrap();
        fs::write(dir.join("image_02.png"), b"existing").unwrap();
        let resolved = unique_output_path(&dir, "image", "png").unwrap();
        assert_eq!(resolved.file_name().and_then(|value| value.to_str()), Some("image_03.png"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn output_alias_creates_symlink_and_increments_collision_name() {
        let source_dir = tempfile::tempdir().unwrap();
        let alias_dir = tempfile::tempdir().unwrap();
        let source = source_dir.path().join("image.png");
        fs::write(&source, b"image").unwrap();

        let first = create_output_alias_at(&source, alias_dir.path()).unwrap();
        assert_eq!(first.file_name().and_then(|value| value.to_str()), Some("image.png"));
        assert_eq!(fs::read_link(&first).unwrap(), source);

        let second = create_output_alias_at(&source, alias_dir.path()).unwrap();
        assert_eq!(second.file_name().and_then(|value| value.to_str()), Some("image_02.png"));
        assert_eq!(fs::read_link(&second).unwrap(), source);
    }

    #[test]
    fn cancellation_token_drives_cancelled_error() {
        let token = CancellationToken::new();
        token.cancel();
        let request = DesktopJobRequest {
            operation: DesktopOperation::Enhance,
            input_path: "/tmp/missing.png".into(),
            output_path: "/tmp/output.png".into(),
            scale: 2,
            sr_mode: "balanced".into(),
            compression_mode: "exact".into(),
            format: "png".into(),
            model_id: None,
            sr_preset: None,
            target_width: None,
            target_height: None,
            crop_zoom: None,
            crop_x: None,
            crop_y: None,
            target_bytes: None,
            vector_preset: None,
            vector_detail: None,
            vector_max_colors: None,
            vector_threshold: None,
            object_action: None,
            object_selection: None,
        };
        assert!(matches!(
            execute_job(&request, &token),
            Err(Agent2DError::Cancelled)
        ));
    }

    #[test]
    fn fit_within_preserves_aspect_and_never_upscales() {
        assert_eq!(fit_within_dimensions(3000, 2000, 1024, 1024), (1024, 683));
        assert_eq!(fit_within_dimensions(640, 480, 1024, 1024), (640, 480));
        assert_eq!(fit_within_dimensions(2000, 3000, 1080, 1350), (900, 1350));
    }

    #[test]
    fn crop_geometry_maps_center_edges_and_zoom() {
        assert_eq!(crop_geometry(3000, 2000, 1024, 1024, 1.0, 0.0, 0.0), (500, 0, 2000, 2000));
        assert_eq!(crop_geometry(3000, 2000, 1024, 1024, 1.0, -1.0, 0.0), (0, 0, 2000, 2000));
        assert_eq!(crop_geometry(3000, 2000, 1024, 1024, 1.0, 1.0, 0.0), (1000, 0, 2000, 2000));
        assert_eq!(crop_geometry(3000, 2000, 1024, 1024, 2.0, 0.0, 0.0), (1000, 500, 1000, 1000));
    }

    fn make_ffmpeg_fixture(path: &Path, width: u32, height: u32) -> bool {
        Command::new("ffmpeg")
            .args(["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i"])
            .arg(format!("testsrc2=size={width}x{height}:rate=1"))
            .args(["-frames:v", "1", "-c:v", "png"])
            .arg(path)
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    fn transform_request(operation: DesktopOperation, input: &Path, output: &Path, width: u32, height: u32) -> DesktopJobRequest {
        DesktopJobRequest {
            operation,
            input_path: input.to_string_lossy().into_owned(),
            output_path: output.to_string_lossy().into_owned(),
            scale: 2,
            sr_mode: "balanced".into(),
            compression_mode: "exact".into(),
            format: "png".into(),
            model_id: None,
            sr_preset: None,
            target_width: Some(width),
            target_height: Some(height),
            crop_zoom: Some(1.0),
            crop_x: Some(0.0),
            crop_y: Some(0.0),
            target_bytes: None,
            vector_preset: None,
            vector_detail: None,
            vector_max_colors: None,
            vector_threshold: None,
            object_action: None,
            object_selection: None,
        }
    }

    #[test]
    fn crop_to_size_writes_exact_dimensions() {
        let dir = std::env::temp_dir().join(format!("agent2d-crop-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let input = dir.join("source.png");
        let output = dir.join("crop.png");
        if !make_ffmpeg_fixture(&input, 300, 200) {
            let _ = fs::remove_dir_all(&dir);
            return;
        }
        let result = execute_job(
            &transform_request(DesktopOperation::Crop, &input, &output, 100, 100),
            &CancellationToken::new(),
        ).unwrap();
        assert_eq!((result.output_width, result.output_height), (100, 100));
        assert!(output.is_file());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn crop_compact_jpeg_respects_requested_max_bytes() {
        let dir = std::env::temp_dir().join(format!("agent2d-crop-cap-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let input = dir.join("source.png");
        let output = dir.join("crop.jpeg");
        if !make_ffmpeg_fixture(&input, 300, 200) {
            let _ = fs::remove_dir_all(&dir);
            return;
        }
        let mut request = transform_request(DesktopOperation::Crop, &input, &output, 100, 100);
        request.format = "jpeg".into();
        request.compression_mode = "compact".into();
        request.target_bytes = Some(8_000);
        let result = execute_job(&request, &CancellationToken::new()).unwrap();
        assert_eq!((result.output_width, result.output_height), (100, 100));
        assert!(result.output_bytes <= 8_000);
        assert!(result.warnings.iter().any(|warning| warning == "compact_target_met"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn optimize_x1_can_finish_as_jpeg() {
        let dir = std::env::temp_dir().join(format!("agent2d-enhance-format-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let input = dir.join("source.png");
        let output = dir.join("enhanced.jpeg");
        if !make_ffmpeg_fixture(&input, 160, 90) {
            let _ = fs::remove_dir_all(&dir);
            return;
        }
        let request = DesktopJobRequest {
            operation: DesktopOperation::Optimize,
            input_path: input.to_string_lossy().into_owned(),
            output_path: output.to_string_lossy().into_owned(),
            scale: 1,
            sr_mode: "balanced".into(),
            compression_mode: "preserve".into(),
            format: "jpeg".into(),
            model_id: None,
            sr_preset: None,
            target_width: None,
            target_height: None,
            crop_zoom: None,
            crop_x: None,
            crop_y: None,
            target_bytes: None,
            vector_preset: None,
            vector_detail: None,
            vector_max_colors: None,
            vector_threshold: None,
            object_action: None,
            object_selection: None,
        };
        let result = execute_job(&request, &CancellationToken::new()).unwrap();
        assert_eq!((result.output_width, result.output_height), (160, 90));
        assert_eq!(result.codec.as_deref(), Some("jpeg"));
        assert!(output.is_file());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn enhance_x1_outputs_png_without_compression_pipeline() {
        let dir = std::env::temp_dir().join(format!("agent2d-enhance-png-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let input = dir.join("source.png");
        let output = dir.join("enhanced.png");
        if !make_ffmpeg_fixture(&input, 160, 90) {
            let _ = fs::remove_dir_all(&dir);
            return;
        }
        let request = DesktopJobRequest {
            operation: DesktopOperation::Enhance,
            input_path: input.to_string_lossy().into_owned(),
            output_path: output.to_string_lossy().into_owned(),
            scale: 1,
            sr_mode: "balanced".into(),
            compression_mode: "exact".into(),
            format: "png".into(),
            model_id: None,
            sr_preset: None,
            target_width: None,
            target_height: None,
            crop_zoom: None,
            crop_x: None,
            crop_y: None,
            target_bytes: None,
            vector_preset: None,
            vector_detail: None,
            vector_max_colors: None,
            vector_threshold: None,
            object_action: None,
            object_selection: None,
        };
        let result = execute_job(&request, &CancellationToken::new()).unwrap();
        assert_eq!((result.output_width, result.output_height), (160, 90));
        assert_eq!(result.codec.as_deref(), Some("png"));
        assert!(result.warnings.iter().any(|warning| warning == "enhance_x1_sr_skipped"));
        assert!(output.is_file());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn resize_to_size_fits_within_and_does_not_upscale() {
        let dir = std::env::temp_dir().join(format!("agent2d-resize-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let input = dir.join("source.png");
        if !make_ffmpeg_fixture(&input, 300, 200) {
            let _ = fs::remove_dir_all(&dir);
            return;
        }
        let output = dir.join("resize.png");
        let result = execute_job(
            &transform_request(DesktopOperation::Resize, &input, &output, 100, 100),
            &CancellationToken::new(),
        ).unwrap();
        assert_eq!((result.output_width, result.output_height), (100, 67));

        let large_output = dir.join("resize-large.png");
        let large = execute_job(
            &transform_request(DesktopOperation::Resize, &input, &large_output, 1000, 1000),
            &CancellationToken::new(),
        ).unwrap();
        assert_eq!((large.output_width, large.output_height), (300, 200));
        assert!(large.warnings.iter().any(|warning| warning == "resize_no_upscale_source_already_within_bounds"));
        let _ = fs::remove_dir_all(&dir);
    }
}
