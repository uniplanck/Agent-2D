use std::{
    env,
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use agent2d_core::{
    Agent2DError, Agent2DResult, BackgroundRemovalRequest, CancellationToken, InspectRequest,
    OutputFormat, cleanup_output, inspect_image, validate_output_path,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tempfile::tempdir;
use uuid::Uuid;

use super::run_transform_to_png;

pub const BACKGROUND_MODEL_ID: &str = "feyninc/FeyNobg";
pub const BACKGROUND_MODEL_REVISION: &str = "c1fd67fbefe3efeb78fe2a003270fb5350a0bb1c";
pub const BACKGROUND_RUNTIME_RELEASE_ID: &str = "feynobg-nobg-0.3.1-torch-2.14.0";
pub const BACKGROUND_NOBG_VERSION: &str = "0.3.1";
pub const BACKGROUND_TORCH_VERSION: &str = "2.14.0";
pub const BACKGROUND_TORCHVISION_VERSION: &str = "0.29.0";
pub const BACKGROUND_PYTHON_RELEASE_ID: &str = "cpython-3.10.21+20260901-aarch64-apple-darwin-install_only";
pub const BACKGROUND_PYTHON_SOURCE_URL: &str = "https://github.com/astral-sh/python-build-standalone/releases/download/20260901/cpython-3.10.21%2B20260901-aarch64-apple-darwin-install_only.tar.gz";
pub const BACKGROUND_PYTHON_ARCHIVE_SHA256: &str = "cee232aabfb6790eec78f3cca935caeb7bd4eedca4dcb0a10dbcdb4302320b38";

const RUNNER_NAME: &str = "remove_bg.py";
const READY_NAME: &str = "READY";

const RUNNER_SCRIPT: &str = r#"#!/usr/bin/env python3
import argparse
import os
import sys

os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

import torch
from loadimg import load_img
from nobg.birefnet.modeling_birefnet import BiRefNet
from nobg.birefnet.image_processing_birefnet import BiRefNetImageProcessor

MODEL_ID = "feyninc/FeyNobg"
MODEL_REVISION = "c1fd67fbefe3efeb78fe2a003270fb5350a0bb1c"


def device_from_env():
    requested = os.environ.get("AGENT2D_BG_DEVICE", "auto").lower()
    if requested == "cpu":
        return torch.device("cpu")
    if requested == "mps":
        if not (hasattr(torch.backends, "mps") and torch.backends.mps.is_available()):
            raise RuntimeError("AGENT2D_BG_DEVICE=mps requested but MPS is unavailable")
        return torch.device("mps")
    if requested != "auto":
        raise RuntimeError("AGENT2D_BG_DEVICE must be auto, mps, or cpu")
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def load_components(device):
    # Use the concrete NoBg classes here instead of AutoModel/AutoProcessor.
    # NoBg AutoModel probes Hugging Face repo metadata on every call; the concrete
    # classes let normal Agent-2D inference stay truly offline after installation.
    model = BiRefNet.from_pretrained(MODEL_ID, revision=MODEL_REVISION).eval()
    processor = BiRefNetImageProcessor.from_pretrained(MODEL_ID, revision=MODEL_REVISION)
    model = model.to(device)
    return model, processor


def infer(input_path, output_path, output_format, device):
    model, processor = load_components(device)
    image = load_img(input_path).convert("RGB")
    inputs = processor(image, return_tensors="pt")
    pixel_values = inputs["pixel_values"].to(device)
    with torch.inference_mode():
        outputs = model(pixel_values=pixel_values)
    alpha = processor.post_process_alpha_matting(
        outputs,
        target_sizes=[(image.height, image.width)],
    )[0]
    if hasattr(alpha, "detach"):
        alpha = alpha.detach().cpu()
    cutout = processor.cutout(image, alpha).convert("RGBA")
    if output_format == "png":
        cutout.save(output_path, format="PNG", optimize=True)
    elif output_format == "webp":
        cutout.save(output_path, format="WEBP", lossless=True, quality=100, method=6)
    else:
        raise RuntimeError(f"unsupported transparent output format: {output_format}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--prepare", action="store_true")
    parser.add_argument("--input")
    parser.add_argument("--output")
    parser.add_argument("--format", choices=["png", "webp"], default="png")
    args = parser.parse_args()

    if args.prepare:
        model = BiRefNet.from_pretrained(MODEL_ID, revision=MODEL_REVISION).eval()
        BiRefNetImageProcessor.from_pretrained(MODEL_ID, revision=MODEL_REVISION)
        del model
        print("ready")
        return

    if not args.input or not args.output:
        parser.error("--input and --output are required unless --prepare is used")

    device = device_from_env()
    try:
        infer(args.input, args.output, args.format, device)
    except Exception:
        if device.type == "mps" and os.environ.get("AGENT2D_BG_DEVICE", "auto").lower() == "auto":
            # Some model operators can lag behind on MPS. Auto mode retries once on CPU.
            try:
                if hasattr(torch.mps, "empty_cache"):
                    torch.mps.empty_cache()
            except Exception:
                pass
            infer(args.input, args.output, args.format, torch.device("cpu"))
        else:
            raise


if __name__ == "__main__":
    main()
"#;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundRuntimeStatus {
    pub installed: bool,
    pub managed: bool,
    pub release_id: String,
    pub root: PathBuf,
    pub python_path: PathBuf,
    pub runner_path: PathBuf,
    pub model_cache_dir: PathBuf,
    pub model_id: String,
    pub model_revision: String,
    pub nobg_version: String,
    pub torch_version: String,
}

#[derive(Debug, Clone)]
struct BackgroundRuntimePaths {
    root: PathBuf,
    python: PathBuf,
    runner: PathBuf,
    model_cache_dir: PathBuf,
}

pub fn background_runtime_status() -> Result<BackgroundRuntimeStatus, Agent2DError> {
    if let Some(root) = env::var_os("AGENT2D_BG_RUNTIME_ROOT") {
        let paths = runtime_paths(PathBuf::from(root));
        return Ok(status_from_paths(&paths, false));
    }
    let paths = runtime_paths(managed_background_runtime_root()?);
    Ok(status_from_paths(&paths, true))
}

pub fn install_background_runtime() -> Result<BackgroundRuntimeStatus, Agent2DError> {
    let existing = background_runtime_status()?;
    if existing.installed && existing.managed {
        fs::write(&existing.runner_path, RUNNER_SCRIPT)
            .map_err(|error| install_error(format!("failed to refresh background runner: {error}")))?;
        fs::write(existing.root.join("SOURCE.txt"), runtime_notice())
            .map_err(|error| install_error(format!("failed to refresh background runtime notice: {error}")))?;
        fs::write(existing.root.join(READY_NAME), runtime_ready_marker())
            .map_err(|error| install_error(format!("failed to refresh background runtime marker: {error}")))?;
        return background_runtime_status();
    }

    let root = managed_background_runtime_root()?;
    let parent = root
        .parent()
        .ok_or_else(|| install_error("invalid background runtime root"))?;
    fs::create_dir_all(parent).map_err(|error| install_error(error.to_string()))?;

    // The model is large enough that interrupted installs must be resumable. A
    // deterministic staging directory lets pip and Hugging Face continue from
    // their existing local files rather than discarding gigabytes of progress.
    let staging = parent.join(format!(".{BACKGROUND_RUNTIME_RELEASE_ID}.staging"));
    let paths = runtime_paths(staging.clone());
    let result = (|| {
        fs::create_dir_all(&staging).map_err(|error| install_error(error.to_string()))?;

        if !paths.python.is_file() {
            install_portable_python(&staging)?;
        }
        if !paths.python.is_file() {
            return Err(install_error("portable Python runtime did not provide bin/python"));
        }
        run_checked(
            &paths.python,
            &[
                "-m",
                "pip",
                "install",
                "--no-input",
                "--disable-pip-version-check",
                "--no-cache-dir",
                &format!("torch=={BACKGROUND_TORCH_VERSION}"),
                &format!("torchvision=={BACKGROUND_TORCHVISION_VERSION}"),
                &format!("nobg=={BACKGROUND_NOBG_VERSION}"),
            ],
            &[],
        )?;

        fs::write(&paths.runner, RUNNER_SCRIPT).map_err(|error| install_error(error.to_string()))?;
        fs::create_dir_all(&paths.model_cache_dir).map_err(|error| install_error(error.to_string()))?;
        let hf_home = paths.model_cache_dir.to_string_lossy().into_owned();
        run_checked(
            &paths.python,
            &[paths.runner.to_string_lossy().as_ref(), "--prepare"],
            &[("HF_HOME", hf_home.as_str()), ("HF_HUB_DISABLE_TELEMETRY", "1")],
        )?;

        fs::write(staging.join("SOURCE.txt"), runtime_notice())
            .map_err(|error| install_error(error.to_string()))?;
        fs::write(staging.join(READY_NAME), runtime_ready_marker())
            .map_err(|error| install_error(error.to_string()))?;

        if root.exists() {
            fs::remove_dir_all(&root).map_err(|error| install_error(error.to_string()))?;
        }
        fs::rename(&staging, &root).map_err(|error| install_error(error.to_string()))?;
        Ok(())
    })();

    // Keep staging on failure/interruption so the explicit install action can
    // resume large dependency/model downloads on the next attempt.
    result?;

    let installed = background_runtime_status()?;
    if !installed.installed {
        return Err(install_error("background runtime verification failed after installation"));
    }
    Ok(installed)
}

pub fn remove_background(request: &BackgroundRemovalRequest) -> Result<Agent2DResult, Agent2DError> {
    remove_background_with_cancel(request, &CancellationToken::new())
}

pub fn remove_background_with_cancel(
    request: &BackgroundRemovalRequest,
    cancellation: &CancellationToken,
) -> Result<Agent2DResult, Agent2DError> {
    if cancellation.is_cancelled() {
        return Err(Agent2DError::Cancelled);
    }
    let output_format = match request.format {
        OutputFormat::Png => "png",
        OutputFormat::Webp => "webp",
        other => {
            return Err(Agent2DError::UnsupportedCompression {
                mode: "background-removal".into(),
                format: format!("{other:?}"),
            });
        }
    };

    let started = Instant::now();
    validate_output_path(&request.input_path, &request.output_path)?;
    let input = inspect_image(&InspectRequest { input_path: request.input_path.clone() })?;
    let runtime = discover_background_runtime()?;
    let temp = tempdir().map_err(|error| Agent2DError::ImageWrite {
        path: "temporary_directory".into(),
        message: error.to_string(),
    })?;

    let prepared_input = if matches!(input.format.as_str(), "png" | "jpeg" | "jpg" | "webp") {
        request.input_path.clone()
    } else {
        let path = temp.path().join("agent2d-background-input.png");
        run_transform_to_png(&request.input_path, &path, "null", cancellation)?;
        path
    };

    let log_path = temp.path().join("feynobg.stderr.log");
    let log = File::create(&log_path).map_err(|error| Agent2DError::ImageWrite {
        path: log_path.to_string_lossy().into_owned(),
        message: error.to_string(),
    })?;
    let mut child = Command::new(&runtime.python)
        .arg(&runtime.runner)
        .args(["--input"])
        .arg(&prepared_input)
        .args(["--output"])
        .arg(&request.output_path)
        .args(["--format", output_format])
        .env("HF_HOME", &runtime.model_cache_dir)
        .env("HF_HUB_OFFLINE", "1")
        .env("HF_HUB_DISABLE_TELEMETRY", "1")
        .env("PYTORCH_ENABLE_MPS_FALLBACK", "1")
        .env("TOKENIZERS_PARALLELISM", "false")
        .stdout(Stdio::null())
        .stderr(Stdio::from(log))
        .spawn()
        .map_err(|error| Agent2DError::BackendUnavailable {
            backend: format!("FeyNoBg managed Python runtime: {error}"),
        })?;

    loop {
        if cancellation.is_cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            cleanup_output(&request.output_path);
            return Err(Agent2DError::Cancelled);
        }
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) => {
                cleanup_output(&request.output_path);
                let message = fs::read_to_string(&log_path)
                    .unwrap_or_else(|_| "FeyNoBg process exited with a non-zero status".into());
                return Err(Agent2DError::BackendFailed {
                    backend: "feynobg".into(),
                    message: tail_chars(&message, 4000),
                });
            }
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(error) => {
                cleanup_output(&request.output_path);
                return Err(Agent2DError::BackendFailed {
                    backend: "feynobg".into(),
                    message: error.to_string(),
                });
            }
        }
    }

    if cancellation.is_cancelled() {
        cleanup_output(&request.output_path);
        return Err(Agent2DError::Cancelled);
    }
    let output = inspect_image(&InspectRequest { input_path: request.output_path.clone() })?;
    if (output.width, output.height) != (input.width, input.height) {
        cleanup_output(&request.output_path);
        return Err(Agent2DError::ProbeFailed {
            message: format!(
                "background removal dimensions expected {}x{}, got {}x{}",
                input.width, input.height, output.width, output.height
            ),
        });
    }
    if !output.has_alpha {
        cleanup_output(&request.output_path);
        return Err(Agent2DError::ProbeFailed {
            message: "background removal output does not contain an alpha channel".into(),
        });
    }

    Ok(Agent2DResult {
        job_id: Uuid::new_v4().to_string(),
        input_path: request.input_path.clone(),
        output_path: request.output_path.clone(),
        input_width: input.width,
        input_height: input.height,
        output_width: output.width,
        output_height: output.height,
        input_bytes: input.input_bytes,
        output_bytes: output.input_bytes,
        compression_ratio: if output.input_bytes == 0 { 0.0 } else { input.input_bytes as f64 / output.input_bytes as f64 },
        model_id: Some(BACKGROUND_MODEL_ID.into()),
        codec: Some(format!("{output_format}-alpha")),
        pixel_exact: Some(false),
        elapsed_ms: started.elapsed().as_millis() as u64,
        warnings: vec![
            "background_removed_with_feynobg".into(),
            "alpha_channel_preserved".into(),
            format!("managed_background_runtime_{BACKGROUND_RUNTIME_RELEASE_ID}"),
        ],
    })
}

fn discover_background_runtime() -> Result<BackgroundRuntimePaths, Agent2DError> {
    let status = background_runtime_status()?;
    if !status.installed {
        return Err(Agent2DError::BackendUnavailable {
            backend: format!(
                "FeyNoBg background runtime is not installed at {}. Install it from the Desktop Background Removal tab or run `agent2d bg-runtime-install`.",
                status.root.to_string_lossy()
            ),
        });
    }
    Ok(runtime_paths(status.root))
}

fn runtime_paths(root: PathBuf) -> BackgroundRuntimePaths {
    BackgroundRuntimePaths {
        python: root.join("bin").join("python"),
        runner: root.join(RUNNER_NAME),
        model_cache_dir: root.join("hf"),
        root,
    }
}

fn managed_python_is_self_contained(paths: &BackgroundRuntimePaths) -> bool {
    let Ok(root) = fs::canonicalize(&paths.root) else {
        return false;
    };
    let Ok(python) = fs::canonicalize(&paths.python) else {
        return false;
    };
    python.starts_with(root)
}

fn status_from_paths(paths: &BackgroundRuntimePaths, managed: bool) -> BackgroundRuntimeStatus {
    BackgroundRuntimeStatus {
        installed: paths.python.is_file()
            && (!managed || managed_python_is_self_contained(paths))
            && paths.runner.is_file()
            && paths.model_cache_dir.is_dir()
            && paths.root.join(READY_NAME).is_file(),
        managed,
        release_id: BACKGROUND_RUNTIME_RELEASE_ID.into(),
        root: paths.root.clone(),
        python_path: paths.python.clone(),
        runner_path: paths.runner.clone(),
        model_cache_dir: paths.model_cache_dir.clone(),
        model_id: BACKGROUND_MODEL_ID.into(),
        model_revision: BACKGROUND_MODEL_REVISION.into(),
        nobg_version: BACKGROUND_NOBG_VERSION.into(),
        torch_version: BACKGROUND_TORCH_VERSION.into(),
    }
}

fn managed_background_runtime_root() -> Result<PathBuf, Agent2DError> {
    if let Some(root) = env::var_os("AGENT2D_RUNTIME_ROOT") {
        return Ok(PathBuf::from(root).join(BACKGROUND_RUNTIME_RELEASE_ID));
    }
    let home = env::var_os("HOME").ok_or_else(|| Agent2DError::BackendUnavailable {
        backend: "HOME is unavailable; cannot resolve FeyNoBg runtime directory".into(),
    })?;
    Ok(PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join("Agent-2D")
        .join("runtime")
        .join(BACKGROUND_RUNTIME_RELEASE_ID))
}

pub(crate) fn install_portable_python(staging: &Path) -> Result<(), Agent2DError> {
    if !cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        return Err(install_error("the managed portable Python runtime currently supports Apple Silicon macOS"));
    }
    let temp = tempdir().map_err(|error| install_error(error.to_string()))?;
    let archive = temp.path().join("python.tar.gz");
    run_checked(
        Path::new("/usr/bin/curl"),
        &[
            "-fL",
            "--retry",
            "2",
            "--connect-timeout",
            "20",
            "-o",
            archive.to_string_lossy().as_ref(),
            BACKGROUND_PYTHON_SOURCE_URL,
        ],
        &[],
    )?;
    verify_file_sha256(&archive, BACKGROUND_PYTHON_ARCHIVE_SHA256)?;
    run_checked(
        Path::new("/usr/bin/tar"),
        &[
            "-xzf",
            archive.to_string_lossy().as_ref(),
            "-C",
            staging.to_string_lossy().as_ref(),
            "--strip-components",
            "1",
        ],
        &[],
    )?;
    let python = staging.join("bin").join("python");
    let status = Command::new(&python)
        .args(["-c", "import sys; raise SystemExit(0 if sys.version_info >= (3,10) else 1)"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| install_error(format!("portable Python verification failed: {error}")))?;
    if !status.success() {
        return Err(install_error("portable Python verification failed"));
    }
    Ok(())
}

fn verify_file_sha256(path: &Path, expected: &str) -> Result<(), Agent2DError> {
    let mut file = File::open(path).map_err(|error| install_error(error.to_string()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| install_error(error.to_string()))?;
        if read == 0 { break; }
        hasher.update(&buffer[..read]);
    }
    let actual = format!("{:x}", hasher.finalize());
    if actual != expected {
        return Err(install_error(format!("portable Python SHA-256 mismatch: expected {expected}, got {actual}")));
    }
    Ok(())
}

fn run_checked(program: &Path, args: &[&str], envs: &[(&str, &str)]) -> Result<(), Agent2DError> {
    let mut command = Command::new(program);
    command.args(args);
    for (key, value) in envs {
        command.env(key, value);
    }
    let output = command.output().map_err(|error| install_error(format!("{}: {error}", program.to_string_lossy())))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    Err(install_error(format!(
        "{} failed: {}{}",
        program.to_string_lossy(),
        tail_chars(&stderr, 3000),
        tail_chars(&stdout, 1000)
    )))
}

fn tail_chars(value: &str, max: usize) -> String {
    let count = value.chars().count();
    if count <= max {
        return value.to_owned();
    }
    value.chars().skip(count - max).collect()
}

fn runtime_notice() -> String {
    format!(
        "Agent-2D managed background-removal runtime\n\nModel: {BACKGROUND_MODEL_ID}\nModel revision: {BACKGROUND_MODEL_REVISION}\nModel/project license: Apache-2.0\nNoBg: {BACKGROUND_NOBG_VERSION}\nPyTorch: {BACKGROUND_TORCH_VERSION}\nTorchVision: {BACKGROUND_TORCHVISION_VERSION}\n\nPortable Python: {BACKGROUND_PYTHON_RELEASE_ID}\nPortable Python source: {BACKGROUND_PYTHON_SOURCE_URL}\nPortable Python archive SHA-256: {BACKGROUND_PYTHON_ARCHIVE_SHA256}\n\nThe app bootstraps its own portable Python runtime, so users do not need a system Python, Homebrew, Xcode, Rust, or Node.js. The model and Python dependencies are downloaded by Agent-2D during installation. Normal background removal runs with HF_HUB_OFFLINE=1.\nSee Agent-2D THIRD_PARTY_NOTICES.md for upstream references and distribution notes.\n"
    )
}

fn runtime_ready_marker() -> String {
    format!("{BACKGROUND_MODEL_ID}\nrevision={BACKGROUND_MODEL_REVISION}\n")
}

fn install_error(message: impl Into<String>) -> Agent2DError {
    Agent2DError::BackendFailed {
        backend: "feynobg_runtime_installer".into(),
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_background_runtime_contract_is_pinned() {
        assert_eq!(BACKGROUND_MODEL_ID, "feyninc/FeyNobg");
        assert_eq!(BACKGROUND_MODEL_REVISION, "c1fd67fbefe3efeb78fe2a003270fb5350a0bb1c");
        assert_eq!(BACKGROUND_NOBG_VERSION, "0.3.1");
        assert_eq!(BACKGROUND_TORCH_VERSION, "2.14.0");
        assert_eq!(BACKGROUND_PYTHON_RELEASE_ID, "cpython-3.10.21+20260901-aarch64-apple-darwin-install_only");
        assert_eq!(BACKGROUND_PYTHON_ARCHIVE_SHA256.len(), 64);
        assert!(BACKGROUND_PYTHON_SOURCE_URL.starts_with("https://github.com/astral-sh/python-build-standalone/releases/download/"));
        assert!(RUNNER_SCRIPT.contains("post_process_alpha_matting"));
        assert!(RUNNER_SCRIPT.contains("feyninc/FeyNobg"));
    }

    #[test]
    fn portable_python_checksum_verifier_is_fail_closed() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("fixture.bin");
        fs::write(&file, b"agent2d-portable-python").unwrap();
        let expected = format!("{:x}", Sha256::digest(b"agent2d-portable-python"));
        verify_file_sha256(&file, &expected).unwrap();
        assert!(verify_file_sha256(&file, &"0".repeat(64)).is_err());
    }

    #[test]
    fn unsupported_transparent_format_is_rejected_before_runtime_lookup() {
        let request = BackgroundRemovalRequest {
            input_path: PathBuf::from("missing.png"),
            output_path: PathBuf::from("out.jpeg"),
            format: OutputFormat::Jpeg,
        };
        assert!(matches!(
            remove_background(&request),
            Err(Agent2DError::UnsupportedCompression { .. })
        ));
    }
}
