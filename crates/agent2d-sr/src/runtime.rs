use std::{
    env,
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    process::Command,
};

use agent2d_core::Agent2DError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub const RUNTIME_RELEASE_ID: &str = "realesrgan-ncnn-vulkan-20220424";
pub const RUNTIME_SOURCE_URL: &str = "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-macos.zip";
pub const RUNTIME_ARCHIVE_SHA256: &str =
    "e0ad05580abfeb25f8d8fb55aaf7bedf552c375b5b4d9bd3c8d59764d2cc333a";
pub const DEFAULT_MODEL: &str = "realesrgan-x4plus";

#[derive(Debug, Clone)]
pub(crate) struct RuntimePaths {
    pub backend: PathBuf,
    pub model_dir: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub installed: bool,
    pub managed: bool,
    pub release_id: String,
    pub root: PathBuf,
    pub backend_path: PathBuf,
    pub model_dir: PathBuf,
    pub source_url: String,
    pub source_archive_sha256: String,
}

pub fn runtime_status() -> Result<RuntimeStatus, Agent2DError> {
    if let Some(overridden) = environment_override()? {
        return Ok(RuntimeStatus {
            installed: overridden.backend.is_file() && overridden.model_dir.is_dir(),
            managed: false,
            release_id: "environment-override".into(),
            root: overridden
                .backend
                .parent()
                .unwrap_or_else(|| Path::new("/"))
                .to_path_buf(),
            backend_path: overridden.backend,
            model_dir: overridden.model_dir,
            source_url: "environment override".into(),
            source_archive_sha256: String::new(),
        });
    }

    let root = managed_runtime_root()?;
    let backend_path = root.join("realesrgan-ncnn-vulkan");
    let model_dir = root.join("models");
    Ok(RuntimeStatus {
        installed: backend_path.is_file() && model_dir.is_dir() && has_model_pairs(&model_dir),
        managed: true,
        release_id: RUNTIME_RELEASE_ID.into(),
        root,
        backend_path,
        model_dir,
        source_url: RUNTIME_SOURCE_URL.into(),
        source_archive_sha256: RUNTIME_ARCHIVE_SHA256.into(),
    })
}

pub fn install_runtime() -> Result<RuntimeStatus, Agent2DError> {
    let existing = runtime_status()?;
    if existing.installed && existing.managed {
        return Ok(existing);
    }

    let root = managed_runtime_root()?;
    let parent = root
        .parent()
        .ok_or_else(|| install_error("invalid managed runtime root"))?;
    fs::create_dir_all(parent).map_err(|error| install_error(error.to_string()))?;

    let install_id = Uuid::new_v4().to_string();
    let temp_root = env::temp_dir().join(format!("agent2d-runtime-install-{install_id}"));
    let archive = temp_root.join("runtime.zip");
    let extracted = temp_root.join("extracted");
    let staging = parent.join(format!(".{RUNTIME_RELEASE_ID}.staging-{install_id}"));

    let result = (|| {
        fs::create_dir_all(&temp_root).map_err(|error| install_error(error.to_string()))?;
        fs::create_dir_all(&extracted).map_err(|error| install_error(error.to_string()))?;

        run_checked(
            "curl",
            &[
                "-fL",
                "--retry",
                "2",
                "--connect-timeout",
                "20",
                "-o",
                archive.to_string_lossy().as_ref(),
                RUNTIME_SOURCE_URL,
            ],
        )?;
        verify_sha256(&archive, RUNTIME_ARCHIVE_SHA256)?;
        run_checked(
            "ditto",
            &[
                "-x",
                "-k",
                archive.to_string_lossy().as_ref(),
                extracted.to_string_lossy().as_ref(),
            ],
        )?;

        let source_backend = extracted.join("realesrgan-ncnn-vulkan");
        let source_models = extracted.join("models");
        if !source_backend.is_file() || !source_models.is_dir() || !has_model_pairs(&source_models)
        {
            return Err(install_error(
                "official runtime archive is missing the expected binary or model pairs",
            ));
        }

        let _ = fs::remove_dir_all(&staging);
        fs::create_dir_all(staging.join("models"))
            .map_err(|error| install_error(error.to_string()))?;
        fs::copy(&source_backend, staging.join("realesrgan-ncnn-vulkan"))
            .map_err(|error| install_error(error.to_string()))?;
        copy_dir_files(&source_models, &staging.join("models"))?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(
                staging.join("realesrgan-ncnn-vulkan"),
                fs::Permissions::from_mode(0o755),
            )
            .map_err(|error| install_error(error.to_string()))?;
        }

        let notice = format!(
            "Agent-2D managed super-resolution runtime\n\nSource: {RUNTIME_SOURCE_URL}\nArchive SHA-256: {RUNTIME_ARCHIVE_SHA256}\nRelease: {RUNTIME_RELEASE_ID}\n\nRuntime implementation: Real-ESRGAN-ncnn-vulkan (MIT)\nInference framework: ncnn (BSD-3-Clause, plus listed third-party notices)\nModels: Real-ESRGAN project release assets (Real-ESRGAN repository is BSD-3-Clause)\n\nSee Agent-2D THIRD_PARTY_NOTICES.md for upstream references and distribution notes.\n"
        );
        fs::write(staging.join("SOURCE.txt"), notice)
            .map_err(|error| install_error(error.to_string()))?;

        if root.exists() {
            fs::remove_dir_all(&root).map_err(|error| install_error(error.to_string()))?;
        }
        fs::rename(&staging, &root).map_err(|error| install_error(error.to_string()))?;
        Ok(())
    })();

    let _ = fs::remove_dir_all(&temp_root);
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result?;

    let installed = runtime_status()?;
    if !installed.installed {
        return Err(install_error(
            "managed runtime verification failed after installation",
        ));
    }
    Ok(installed)
}

pub(crate) fn discover_runtime() -> Result<RuntimePaths, Agent2DError> {
    if let Some(overridden) = environment_override()? {
        validate_runtime(&overridden)?;
        return Ok(overridden);
    }

    let status = runtime_status()?;
    if !status.installed {
        return Err(Agent2DError::BackendUnavailable {
            backend: format!(
                "Agent-2D managed runtime is not installed at {}. Install it from the Desktop app or run the runtime installer.",
                status.root.to_string_lossy()
            ),
        });
    }
    let runtime = RuntimePaths {
        backend: status.backend_path,
        model_dir: status.model_dir,
    };
    validate_runtime(&runtime)?;
    Ok(runtime)
}

fn environment_override() -> Result<Option<RuntimePaths>, Agent2DError> {
    match (
        env::var_os("AGENT2D_SR_BACKEND"),
        env::var_os("AGENT2D_SR_MODEL_DIR"),
    ) {
        (None, None) => Ok(None),
        (Some(backend), Some(model_dir)) => Ok(Some(RuntimePaths {
            backend: PathBuf::from(backend),
            model_dir: PathBuf::from(model_dir),
        })),
        _ => Err(Agent2DError::BackendUnavailable {
            backend: "AGENT2D_SR_BACKEND and AGENT2D_SR_MODEL_DIR must be set together".into(),
        }),
    }
}

fn managed_runtime_root() -> Result<PathBuf, Agent2DError> {
    if let Some(root) = env::var_os("AGENT2D_RUNTIME_ROOT") {
        return Ok(PathBuf::from(root).join(RUNTIME_RELEASE_ID));
    }
    let home = env::var_os("HOME").ok_or_else(|| Agent2DError::BackendUnavailable {
        backend: "HOME is unavailable; cannot resolve Agent-2D managed runtime directory".into(),
    })?;
    Ok(PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join("Agent-2D")
        .join("runtime")
        .join(RUNTIME_RELEASE_ID))
}

fn validate_runtime(runtime: &RuntimePaths) -> Result<(), Agent2DError> {
    if !runtime.backend.is_file() {
        return Err(Agent2DError::BackendUnavailable {
            backend: runtime.backend.to_string_lossy().into_owned(),
        });
    }
    if !runtime.model_dir.is_dir() || !has_model_pairs(&runtime.model_dir) {
        return Err(Agent2DError::BackendUnavailable {
            backend: format!("model directory {}", runtime.model_dir.to_string_lossy()),
        });
    }
    Ok(())
}

fn has_model_pairs(model_dir: &Path) -> bool {
    let Ok(entries) = fs::read_dir(model_dir) else {
        return false;
    };
    entries.flatten().any(|entry| {
        let path = entry.path();
        path.extension().and_then(|extension| extension.to_str()) == Some("param")
            && path.with_extension("bin").is_file()
    })
}

fn copy_dir_files(source: &Path, destination: &Path) -> Result<(), Agent2DError> {
    for entry in fs::read_dir(source).map_err(|error| install_error(error.to_string()))? {
        let entry = entry.map_err(|error| install_error(error.to_string()))?;
        let source_path = entry.path();
        if !source_path.is_file() {
            continue;
        }
        let destination_path = destination.join(entry.file_name());
        fs::copy(&source_path, destination_path)
            .map_err(|error| install_error(error.to_string()))?;
    }
    Ok(())
}

fn verify_sha256(path: &Path, expected: &str) -> Result<(), Agent2DError> {
    let mut file = File::open(path).map_err(|error| install_error(error.to_string()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| install_error(error.to_string()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let actual = format!("{:x}", hasher.finalize());
    if actual != expected {
        return Err(install_error(format!(
            "runtime archive SHA-256 mismatch: expected {expected}, got {actual}"
        )));
    }
    Ok(())
}

fn run_checked(program: &str, args: &[&str]) -> Result<(), Agent2DError> {
    let output = Command::new(program)
        .args(args)
        .output()
        .map_err(|error| install_error(format!("{program}: {error}")))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(install_error(format!(
        "{program} failed: {}",
        stderr
            .chars()
            .rev()
            .take(2000)
            .collect::<String>()
            .chars()
            .rev()
            .collect::<String>()
    )))
}

fn install_error(message: impl Into<String>) -> Agent2DError {
    Agent2DError::BackendFailed {
        backend: "agent2d_runtime_installer".into(),
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn runtime_source_is_pinned_by_sha256() {
        assert_eq!(RUNTIME_ARCHIVE_SHA256.len(), 64);
        assert!(RUNTIME_SOURCE_URL.starts_with("https://github.com/xinntao/Real-ESRGAN/"));
        assert_eq!(DEFAULT_MODEL, "realesrgan-x4plus");
    }

    #[test]
    fn sha256_verifier_accepts_expected_content_and_rejects_mismatch() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("payload");
        fs::write(&path, b"hello").unwrap();
        verify_sha256(
            &path,
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
        )
        .unwrap();
        assert!(verify_sha256(&path, RUNTIME_ARCHIVE_SHA256).is_err());
    }
}
