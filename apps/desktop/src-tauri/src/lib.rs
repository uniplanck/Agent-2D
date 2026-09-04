use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex},
    thread,
};

use agent2d_compression::compress_image_with_cancel;
use agent2d_core::{
    Agent2DError, Agent2DResult, CancellationToken, CompressRequest, CompressionMode,
    CompressionOptions, ErrorPayload, InspectRequest, InspectResult, JobState, OptimizeRequest,
    OutputFormat, SuperResolutionMode, UpscaleOptions, UpscaleRequest, UpscaleScale,
    cleanup_output, inspect_image,
};
use agent2d_pipeline::optimize_image_with_cancel;
use agent2d_sr::{SrCapabilities, capabilities, install_runtime, upscale_image_with_cancel};
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
        other => Err(Agent2DError::UnsupportedCompression {
            mode: other.into(),
            format: "desktop".into(),
        }),
    }
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
        DesktopOperation::Enhance if scale == UpscaleScale::X1 => compress_image_with_cancel(
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
            result.warnings.push("sr_skipped_scale_1_dimensions_preserved".into());
            result
        }),
        DesktopOperation::Enhance => upscale_image_with_cancel(
            &UpscaleRequest {
                input_path,
                output_path,
                scale: Some(scale),
                target_width: None,
                target_height: None,
                mode: sr_mode,
                preset: None,
                model_id: request.model_id.clone().filter(|value| !value.is_empty()),
            },
            cancellation,
        ),
        DesktopOperation::Compress => compress_image_with_cancel(
            &CompressRequest {
                input_path,
                output_path,
                mode: compression_mode,
                format: Some(format),
                target_bytes: None,
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
                    target_bytes: None,
                },
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
        "jpg" | "jpeg" => Ok("jpeg"),
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
        };
        assert!(matches!(
            execute_job(&request, &token),
            Err(Agent2DError::Cancelled)
        ));
    }
}
