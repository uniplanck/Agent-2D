use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use agent2d_compression::compress_image_with_cancel;
use agent2d_core::{
    Agent2DError, Agent2DResult, CancellationToken, CompressRequest, CompressionMode,
    CompressionOptions, CustomRequest, ErrorPayload, InspectRequest, InspectResult, JobState, OptimizeRequest,
    OutputFormat, SuperResolutionMode, UpscaleOptions, UpscaleScale,
    cleanup_output, inspect_image, validate_output_path,
};
use agent2d_pipeline::{custom_image_with_cancel, optimize_image_with_cancel};
use agent2d_sr::{SrCapabilities, capabilities, install_runtime};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;

const MAX_PREVIEW_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum DesktopOperation {
    Enhance,
    Compress,
    Optimize,
    Crop,
    Resize,
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
    target_width: Option<u32>,
    target_height: Option<u32>,
    crop_zoom: Option<f64>,
    crop_x: Option<f64>,
    crop_y: Option<f64>,
    target_bytes: Option<u64>,
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
        other => Err(Agent2DError::UnsupportedCompression {
            mode: "desktop".into(),
            format: other.into(),
        }),
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
    let format = parse_format(&request.format)?;
    let compression_mode = parse_compression_mode(&request.compression_mode)?;

    match request.operation {
        DesktopOperation::Enhance => optimize_image_with_cancel(
            &OptimizeRequest {
                input_path,
                output_path,
                upscale: Some(UpscaleOptions {
                    scale: Some(scale),
                    target_width: None,
                    target_height: None,
                    mode: sr_mode,
                    model_id: request.model_id.clone().filter(|value| !value.is_empty()),
                }),
                compression: CompressionOptions {
                    mode: compression_mode,
                    format: Some(format),
                    target_bytes: request.target_bytes,
                },
            },
            cancellation,
        ).map(|mut result| {
            result.warnings.push("enhance_final_format_applied".into());
            result
        }),
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
fn install_runtime_command() -> Result<SrCapabilities, ErrorPayload> {
    install_runtime()
        .and_then(|_| capabilities())
        .map_err(|error| error.payload())
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
    if extension == "jxl" {
        let output = Command::new("ffmpeg")
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
            .map_err(|error| internal_error(format!("JXL preview requires ffmpeg: {error}")))?;
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
        .manage(JobManager::default())
        .invoke_handler(tauri::generate_handler![
            inspect_image_command,
            capabilities_command,
            install_runtime_command,
            preview_image_command,
            resolve_output_path_command,
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
            target_width: None,
            target_height: None,
            crop_zoom: None,
            crop_x: None,
            crop_y: None,
            target_bytes: None,
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
            target_width: Some(width),
            target_height: Some(height),
            crop_zoom: Some(1.0),
            crop_x: Some(0.0),
            crop_y: Some(0.0),
            target_bytes: None,
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
    fn enhance_x1_can_finish_as_jpeg() {
        let dir = std::env::temp_dir().join(format!("agent2d-enhance-format-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let input = dir.join("source.png");
        let output = dir.join("enhanced.jpeg");
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
            compression_mode: "preserve".into(),
            format: "jpeg".into(),
            model_id: None,
            target_width: None,
            target_height: None,
            crop_zoom: None,
            crop_x: None,
            crop_y: None,
            target_bytes: None,
        };
        let result = execute_job(&request, &CancellationToken::new()).unwrap();
        assert_eq!((result.output_width, result.output_height), (160, 90));
        assert_eq!(result.codec.as_deref(), Some("jpeg"));
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
