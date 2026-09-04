use std::path::PathBuf;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::ErrorPayload;

pub const SCHEMA_VERSION: &str = "0.1";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiEnvelope<T> {
    pub schema_version: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorPayload>,
}

impl<T> ApiEnvelope<T> {
    pub fn success(data: T) -> Self {
        Self {
            schema_version: SCHEMA_VERSION.to_owned(),
            ok: true,
            data: Some(data),
            error: None,
        }
    }

    pub fn failure(error: ErrorPayload) -> Self {
        Self {
            schema_version: SCHEMA_VERSION.to_owned(),
            ok: false,
            data: None,
            error: Some(error),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectRequest {
    pub input_path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectResult {
    pub job_id: String,
    pub input_path: PathBuf,
    pub format: String,
    pub width: u32,
    pub height: u32,
    pub input_bytes: u64,
    pub has_alpha: bool,
    pub bit_depth: u8,
    pub color_type: String,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpscaleScale {
    X1,
    X2,
    X3,
    X4,
}

impl UpscaleScale {
    pub const fn get(self) -> u8 {
        match self {
            Self::X1 => 1,
            Self::X2 => 2,
            Self::X3 => 3,
            Self::X4 => 4,
        }
    }
}

impl Serialize for UpscaleScale {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_u8(self.get())
    }
}

impl<'de> Deserialize<'de> for UpscaleScale {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        match u8::deserialize(deserializer)? {
            1 => Ok(Self::X1),
            2 => Ok(Self::X2),
            3 => Ok(Self::X3),
            4 => Ok(Self::X4),
            other => Err(serde::de::Error::custom(format!(
                "unsupported upscale scale {other}; expected 1, 2, 3, or 4"
            ))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SuperResolutionMode {
    Fidelity,
    Balanced,
    Perceptual,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SuperResolutionPreset {
    General,
    Photo,
    Illustration,
    AiArt,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CompressionMode {
    Exact,
    Preserve,
    Compact,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OutputFormat {
    Png,
    Jpeg,
    Webp,
    Avif,
    Jxl,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpscaleRequest {
    pub input_path: PathBuf,
    pub output_path: PathBuf,
    pub scale: Option<UpscaleScale>,
    pub target_width: Option<u32>,
    pub target_height: Option<u32>,
    pub mode: SuperResolutionMode,
    pub preset: Option<SuperResolutionPreset>,
    pub model_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressRequest {
    pub input_path: PathBuf,
    pub output_path: PathBuf,
    pub mode: CompressionMode,
    pub format: Option<OutputFormat>,
    pub target_bytes: Option<u64>,
    pub preserve_metadata: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpscaleOptions {
    pub scale: Option<UpscaleScale>,
    pub target_width: Option<u32>,
    pub target_height: Option<u32>,
    pub mode: SuperResolutionMode,
    pub model_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressionOptions {
    pub mode: CompressionMode,
    pub format: Option<OutputFormat>,
    pub target_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OptimizeRequest {
    pub input_path: PathBuf,
    pub output_path: PathBuf,
    pub upscale: Option<UpscaleOptions>,
    pub compression: CompressionOptions,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Agent2DResult {
    pub job_id: String,
    pub input_path: PathBuf,
    pub output_path: PathBuf,
    pub input_width: u32,
    pub input_height: u32,
    pub output_width: u32,
    pub output_height: u32,
    pub input_bytes: u64,
    pub output_bytes: u64,
    pub compression_ratio: f64,
    pub model_id: Option<String>,
    pub codec: Option<String>,
    pub pixel_exact: Option<bool>,
    pub elapsed_ms: u64,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressSnapshot {
    pub job_id: String,
    pub state: JobState,
    pub fraction: f32,
    pub stage: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contract_serializes_with_camel_case_fields() {
        let request = InspectRequest {
            input_path: PathBuf::from("/tmp/example.png"),
        };
        let value = serde_json::to_value(request).expect("serialize inspect request");
        assert_eq!(value["inputPath"], "/tmp/example.png");
        assert!(value.get("input_path").is_none());
    }

    #[test]
    fn envelope_has_stable_schema_version() {
        let response = ApiEnvelope::success(InspectResult {
            job_id: "job-1".into(),
            input_path: PathBuf::from("image.png"),
            format: "png".into(),
            width: 1,
            height: 1,
            input_bytes: 10,
            has_alpha: true,
            bit_depth: 8,
            color_type: "rgba8".into(),
            warnings: vec![],
        });
        let value = serde_json::to_value(response).expect("serialize envelope");
        assert_eq!(value["schemaVersion"], SCHEMA_VERSION);
        assert_eq!(value["ok"], true);
        assert!(value.get("error").is_none());
    }

    #[test]
    fn future_operation_enums_have_stable_wire_values() {
        assert_eq!(
            serde_json::to_string(&SuperResolutionMode::Perceptual).unwrap(),
            "\"perceptual\""
        );
        assert_eq!(
            serde_json::to_string(&SuperResolutionPreset::AiArt).unwrap(),
            "\"ai-art\""
        );
        assert_eq!(
            serde_json::to_string(&CompressionMode::Exact).unwrap(),
            "\"exact\""
        );
        assert_eq!(serde_json::to_string(&UpscaleScale::X2).unwrap(), "2");
        assert_eq!(UpscaleScale::X4.get(), 4);
        assert!(serde_json::from_str::<UpscaleScale>("5").is_err());
    }
}
