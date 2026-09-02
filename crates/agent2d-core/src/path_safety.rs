use std::{fs, path::Path};

use crate::Agent2DError;

pub fn validate_output_path(input: &Path, output: &Path) -> Result<(), Agent2DError> {
    if input == output {
        return Err(Agent2DError::OutputEqualsInput {
            path: display_path(output),
        });
    }
    if output.exists() {
        return Err(Agent2DError::OutputExists {
            path: display_path(output),
        });
    }
    let parent = output.parent().unwrap_or_else(|| Path::new("."));
    let metadata = fs::symlink_metadata(parent).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            Agent2DError::OutputParentMissing {
                path: display_path(parent),
            }
        } else {
            Agent2DError::ImageWrite {
                path: display_path(parent),
                message: error.to_string(),
            }
        }
    })?;
    if metadata.file_type().is_symlink() {
        return Err(Agent2DError::SymlinkOutputParent {
            path: display_path(parent),
        });
    }
    if !metadata.is_dir() {
        return Err(Agent2DError::OutputParentNotDirectory {
            path: display_path(parent),
        });
    }
    Ok(())
}

pub fn cleanup_output(path: &Path) {
    let _ = fs::remove_file(path);
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn existing_output_is_rejected() {
        let dir = tempdir().unwrap();
        let input = dir.path().join("input.png");
        let output = dir.path().join("output.png");
        fs::write(&input, b"input").unwrap();
        fs::write(&output, b"output").unwrap();
        assert_eq!(
            validate_output_path(&input, &output).unwrap_err().code(),
            "output_exists"
        );
    }
}
