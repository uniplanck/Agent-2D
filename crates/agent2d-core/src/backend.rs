use std::{env, path::{Path, PathBuf}};

const COMMON_BACKEND_DIRS: &[&str] = &[
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
];

pub fn backend_command_path(backend: &str) -> Option<PathBuf> {
    if backend.is_empty() {
        return None;
    }

    let direct = Path::new(backend);
    if direct.components().count() > 1 && direct.is_file() {
        return Some(direct.to_path_buf());
    }

    let override_key = format!(
        "AGENT2D_{}_PATH",
        backend
            .chars()
            .map(|ch| if ch.is_ascii_alphanumeric() { ch.to_ascii_uppercase() } else { '_' })
            .collect::<String>()
    );
    if let Some(path) = env::var_os(&override_key).map(PathBuf::from).filter(|path| path.is_file()) {
        return Some(path);
    }

    if let Some(path) = env::var_os("PATH").and_then(|paths| {
        env::split_paths(&paths)
            .map(|directory| directory.join(backend))
            .find(|candidate| candidate.is_file())
    }) {
        return Some(path);
    }

    for directory in COMMON_BACKEND_DIRS {
        let candidate = Path::new(directory).join(backend);
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    if let Ok(executable) = env::current_exe() {
        if let Some(macos_dir) = executable.parent() {
            for candidate in [
                macos_dir.join(backend),
                macos_dir.join("bin").join(backend),
                macos_dir.join("../Resources/bin").join(backend),
            ] {
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }

    None
}

pub fn backend_available(backend: &str) -> bool {
    backend_command_path(backend).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_backend_is_reported_as_unavailable() {
        assert!(!backend_available("agent2d-definitely-not-a-real-backend-7f43a6"));
    }
}
