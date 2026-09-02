use std::{io, path::Path};

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorPayload {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Error)]
pub enum Agent2DError {
    #[error("input path does not exist: {path}")]
    InputNotFound { path: String },

    #[error("symbolic links are not accepted as input: {path}")]
    SymlinkInput { path: String },

    #[error("input path is not a regular file: {path}")]
    NotAFile { path: String },

    #[error("failed to read metadata for {path}: {source}")]
    Metadata {
        path: String,
        #[source]
        source: io::Error,
    },

    #[error("failed to open image {path}: {source}")]
    ImageOpen {
        path: String,
        #[source]
        source: io::Error,
    },

    #[error("failed to determine image format for {path}: {source}")]
    ImageFormat {
        path: String,
        #[source]
        source: io::Error,
    },

    #[error("unsupported image format: {format}")]
    UnsupportedFormat { format: String },

    #[error("failed to decode image {path}: {source}")]
    ImageDecode {
        path: String,
        #[source]
        source: image::ImageError,
    },

    #[error("output path is the same as input path: {path}")]
    OutputEqualsInput { path: String },

    #[error("output path already exists: {path}")]
    OutputExists { path: String },

    #[error("output parent directory does not exist: {path}")]
    OutputParentMissing { path: String },

    #[error("symbolic links are not accepted as output parent directories: {path}")]
    SymlinkOutputParent { path: String },

    #[error("output parent path is not a directory: {path}")]
    OutputParentNotDirectory { path: String },

    #[error("failed to write image {path}: {message}")]
    ImageWrite { path: String, message: String },

    #[error("required backend is unavailable: {backend}")]
    BackendUnavailable { backend: String },

    #[error("backend {backend} failed: {message}")]
    BackendFailed { backend: String, message: String },

    #[error("compression mode/format combination is unsupported: {mode}/{format}")]
    UnsupportedCompression { mode: String, format: String },

    #[error("pixel-exact verification failed")]
    PixelMismatch,

    #[error("failed to probe output dimensions: {message}")]
    ProbeFailed { message: String },

    #[error("super-resolution model was not found: {model}")]
    ModelNotFound { model: String },

    #[error("unsupported upscale request: {message}")]
    UnsupportedUpscale { message: String },

    #[error("operation was cancelled")]
    Cancelled,
}

impl Agent2DError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InputNotFound { .. } => "input_not_found",
            Self::SymlinkInput { .. } => "symlink_input_rejected",
            Self::NotAFile { .. } => "input_not_file",
            Self::Metadata { .. } => "metadata_read_failed",
            Self::ImageOpen { .. } => "image_open_failed",
            Self::ImageFormat { .. } => "image_format_detection_failed",
            Self::UnsupportedFormat { .. } => "unsupported_image_format",
            Self::ImageDecode { .. } => "image_decode_failed",
            Self::OutputEqualsInput { .. } => "output_equals_input",
            Self::OutputExists { .. } => "output_exists",
            Self::OutputParentMissing { .. } => "output_parent_missing",
            Self::SymlinkOutputParent { .. } => "symlink_output_parent_rejected",
            Self::OutputParentNotDirectory { .. } => "output_parent_not_directory",
            Self::ImageWrite { .. } => "image_write_failed",
            Self::BackendUnavailable { .. } => "backend_unavailable",
            Self::BackendFailed { .. } => "backend_failed",
            Self::UnsupportedCompression { .. } => "unsupported_compression",
            Self::PixelMismatch => "pixel_mismatch",
            Self::ProbeFailed { .. } => "probe_failed",
            Self::ModelNotFound { .. } => "model_not_found",
            Self::UnsupportedUpscale { .. } => "unsupported_upscale",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn payload(&self) -> ErrorPayload {
        ErrorPayload {
            code: self.code().to_owned(),
            message: self.to_string(),
        }
    }

    pub(crate) fn display_path(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }
}
