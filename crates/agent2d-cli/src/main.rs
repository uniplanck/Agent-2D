use std::{path::PathBuf, process::ExitCode};

use agent2d_compression::compress_image;
use agent2d_core::{
    Agent2DResult, ApiEnvelope, CompressRequest, CompressionMode, CompressionOptions,
    InspectRequest, InspectResult, OptimizeRequest, OutputFormat, SCHEMA_VERSION,
    SuperResolutionMode, SuperResolutionPreset, UpscaleOptions, UpscaleRequest, UpscaleScale,
    inspect_image,
};
use agent2d_pipeline::optimize_image;
use agent2d_sr::{
    RuntimeStatus, SrCapabilities, capabilities as sr_capabilities, install_runtime,
    runtime_status, upscale_image,
};
use clap::{Parser, Subcommand, ValueEnum};
use serde::Serialize;

#[derive(Debug, Parser)]
#[command(
    name = "agent2d",
    version,
    about = "Local-first image optimization core CLI"
)]
struct Cli {
    #[arg(long, global = true, help = "Pretty-print JSON output")]
    pretty: bool,

    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    #[command(about = "Inspect image metadata through the shared Agent-2D Core")]
    Inspect {
        #[arg(value_name = "IMAGE")]
        input: PathBuf,
    },
    #[command(about = "Compress an image through the shared Agent-2D Core")]
    Compress {
        #[arg(value_name = "IMAGE")]
        input: PathBuf,
        #[arg(value_name = "OUTPUT")]
        output: PathBuf,
        #[arg(long, value_enum, default_value_t = CompressionModeArg::Exact)]
        mode: CompressionModeArg,
        #[arg(long, value_enum)]
        format: OutputFormatArg,
    },
    #[command(about = "Upscale an image through the shared Agent-2D Core")]
    Upscale {
        #[arg(value_name = "IMAGE")]
        input: PathBuf,
        #[arg(value_name = "OUTPUT")]
        output: PathBuf,
        #[arg(long, value_enum, default_value_t = ScaleArg::X2)]
        scale: ScaleArg,
        #[arg(long, value_enum, default_value_t = SrModeArg::Balanced)]
        mode: SrModeArg,
        #[arg(long, value_enum)]
        preset: Option<SrPresetArg>,
        #[arg(long)]
        model: Option<String>,
        #[arg(long)]
        target_width: Option<u32>,
        #[arg(long)]
        target_height: Option<u32>,
    },
    #[command(about = "Run upscale + compression as one pipeline")]
    Optimize {
        #[arg(value_name = "IMAGE")]
        input: PathBuf,
        #[arg(value_name = "OUTPUT")]
        output: PathBuf,
        #[arg(long, value_enum, default_value_t = ScaleArg::X2)]
        scale: ScaleArg,
        #[arg(long, value_enum, default_value_t = SrModeArg::Balanced)]
        sr_mode: SrModeArg,
        #[arg(long)]
        model: Option<String>,
        #[arg(long, value_enum, default_value_t = CompressionModeArg::Exact)]
        compression_mode: CompressionModeArg,
        #[arg(long, value_enum, default_value_t = OutputFormatArg::Png)]
        format: OutputFormatArg,
        #[arg(long)]
        target_width: Option<u32>,
        #[arg(long)]
        target_height: Option<u32>,
    },
    #[command(about = "Report installed Agent-2D runtime capabilities")]
    Capabilities,
    #[command(about = "Report the managed Real-ESRGAN runtime installation state")]
    RuntimeStatus,
    #[command(about = "Install the pinned official Real-ESRGAN NCNN runtime locally")]
    RuntimeInstall,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum CompressionModeArg {
    Exact,
    Preserve,
    Compact,
}

impl From<CompressionModeArg> for CompressionMode {
    fn from(value: CompressionModeArg) -> Self {
        match value {
            CompressionModeArg::Exact => CompressionMode::Exact,
            CompressionModeArg::Preserve => CompressionMode::Preserve,
            CompressionModeArg::Compact => CompressionMode::Compact,
        }
    }
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum OutputFormatArg {
    Png,
    Jpeg,
    Webp,
    Avif,
    Jxl,
}

impl From<OutputFormatArg> for OutputFormat {
    fn from(value: OutputFormatArg) -> Self {
        match value {
            OutputFormatArg::Png => OutputFormat::Png,
            OutputFormatArg::Jpeg => OutputFormat::Jpeg,
            OutputFormatArg::Webp => OutputFormat::Webp,
            OutputFormatArg::Avif => OutputFormat::Avif,
            OutputFormatArg::Jxl => OutputFormat::Jxl,
        }
    }
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum ScaleArg {
    #[value(name = "1")]
    X1,
    #[value(name = "2")]
    X2,
    #[value(name = "3")]
    X3,
    #[value(name = "4")]
    X4,
}

impl From<ScaleArg> for UpscaleScale {
    fn from(value: ScaleArg) -> Self {
        match value {
            ScaleArg::X1 => UpscaleScale::X1,
            ScaleArg::X2 => UpscaleScale::X2,
            ScaleArg::X3 => UpscaleScale::X3,
            ScaleArg::X4 => UpscaleScale::X4,
        }
    }
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum SrModeArg {
    Fidelity,
    Balanced,
    Perceptual,
}

impl From<SrModeArg> for SuperResolutionMode {
    fn from(value: SrModeArg) -> Self {
        match value {
            SrModeArg::Fidelity => SuperResolutionMode::Fidelity,
            SrModeArg::Balanced => SuperResolutionMode::Balanced,
            SrModeArg::Perceptual => SuperResolutionMode::Perceptual,
        }
    }
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum SrPresetArg {
    General,
    Photo,
    Illustration,
    #[value(name = "ai-art")]
    AiArt,
}

impl From<SrPresetArg> for SuperResolutionPreset {
    fn from(value: SrPresetArg) -> Self {
        match value {
            SrPresetArg::General => SuperResolutionPreset::General,
            SrPresetArg::Photo => SuperResolutionPreset::Photo,
            SrPresetArg::Illustration => SuperResolutionPreset::Illustration,
            SrPresetArg::AiArt => SuperResolutionPreset::AiArt,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CapabilitiesResult {
    schema_version: &'static str,
    compression: CompressionCapabilities,
    super_resolution: SrCapabilities,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompressionCapabilities {
    png_exact: bool,
    webp_lossless: bool,
    avif_preserve: bool,
    jpeg_preserve: bool,
    jxl_lossless: bool,
}

fn main() -> ExitCode {
    let cli = Cli::parse();

    match cli.command {
        Command::Inspect { input } => {
            let request = InspectRequest { input_path: input };
            match inspect_image(&request) {
                Ok(result) => success(&result, cli.pretty),
                Err(error) => failure::<InspectResult>(error.payload(), cli.pretty),
            }
        }
        Command::Compress {
            input,
            output,
            mode,
            format,
        } => {
            let request = CompressRequest {
                input_path: input,
                output_path: output,
                mode: mode.into(),
                format: Some(format.into()),
                target_bytes: None,
                preserve_metadata: Some(false),
            };
            match compress_image(&request) {
                Ok(result) => success(&result, cli.pretty),
                Err(error) => failure::<Agent2DResult>(error.payload(), cli.pretty),
            }
        }
        Command::Upscale {
            input,
            output,
            scale,
            mode,
            preset,
            model,
            target_width,
            target_height,
        } => {
            if matches!(scale, ScaleArg::X1) {
                let (format, compression_mode) = conversion_format_for_output(&output);
                match format {
                    Some(format) => {
                        let request = CompressRequest {
                            input_path: input,
                            output_path: output,
                            mode: compression_mode,
                            format: Some(format),
                            target_bytes: None,
                            preserve_metadata: Some(false),
                        };
                        match compress_image(&request) {
                            Ok(mut result) => {
                                result.warnings.push("sr_skipped_scale_1_dimensions_preserved".into());
                                success(&result, cli.pretty)
                            }
                            Err(error) => failure::<Agent2DResult>(error.payload(), cli.pretty),
                        }
                    }
                    None => failure::<Agent2DResult>(
                        agent2d_core::Agent2DError::UnsupportedCompression {
                            mode: "x1_conversion".into(),
                            format: output.extension().and_then(|value| value.to_str()).unwrap_or("unknown").into(),
                        }.payload(),
                        cli.pretty,
                    ),
                }
            } else {
                let request = UpscaleRequest {
                    input_path: input,
                    output_path: output,
                    scale: Some(scale.into()),
                    target_width,
                    target_height,
                    mode: mode.into(),
                    preset: preset.map(Into::into),
                    model_id: model,
                };
                match upscale_image(&request) {
                    Ok(result) => success(&result, cli.pretty),
                    Err(error) => failure::<Agent2DResult>(error.payload(), cli.pretty),
                }
            }
        }
        Command::Optimize {
            input,
            output,
            scale,
            sr_mode,
            model,
            compression_mode,
            format,
            target_width,
            target_height,
        } => {
            let request = OptimizeRequest {
                input_path: input,
                output_path: output,
                upscale: Some(UpscaleOptions {
                    scale: Some(scale.into()),
                    target_width,
                    target_height,
                    mode: sr_mode.into(),
                    model_id: model,
                }),
                compression: CompressionOptions {
                    mode: compression_mode.into(),
                    format: Some(format.into()),
                    target_bytes: None,
                },
            };
            match optimize_image(&request) {
                Ok(result) => success(&result, cli.pretty),
                Err(error) => failure::<Agent2DResult>(error.payload(), cli.pretty),
            }
        }
        Command::Capabilities => match sr_capabilities() {
            Ok(super_resolution) => success(
                &CapabilitiesResult {
                    schema_version: SCHEMA_VERSION,
                    compression: CompressionCapabilities {
                        png_exact: true,
                        webp_lossless: command_exists("cwebp"),
                        avif_preserve: command_exists("ffmpeg") && command_exists("ffprobe"),
                        jpeg_preserve: command_exists("ffmpeg"),
                        jxl_lossless: command_exists("cjxl")
                            && command_exists("ffmpeg")
                            && command_exists("ffprobe"),
                    },
                    super_resolution,
                },
                cli.pretty,
            ),
            Err(error) => failure::<CapabilitiesResult>(error.payload(), cli.pretty),
        },
        Command::RuntimeStatus => match runtime_status() {
            Ok(status) => success(&status, cli.pretty),
            Err(error) => failure::<RuntimeStatus>(error.payload(), cli.pretty),
        },
        Command::RuntimeInstall => match install_runtime() {
            Ok(status) => success(&status, cli.pretty),
            Err(error) => failure::<RuntimeStatus>(error.payload(), cli.pretty),
        },
    }
}

fn conversion_format_for_output(path: &PathBuf) -> (Option<OutputFormat>, CompressionMode) {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => (Some(OutputFormat::Png), CompressionMode::Exact),
        Some("webp") => (Some(OutputFormat::Webp), CompressionMode::Exact),
        Some("jxl") => (Some(OutputFormat::Jxl), CompressionMode::Exact),
        Some("jpg") | Some("jpeg") => (Some(OutputFormat::Jpeg), CompressionMode::Preserve),
        Some("avif") => (Some(OutputFormat::Avif), CompressionMode::Preserve),
        _ => (None, CompressionMode::Exact),
    }
}

fn command_exists(name: &str) -> bool {
    std::process::Command::new(name)
        .arg("-version")
        .output()
        .or_else(|_| std::process::Command::new(name).arg("--version").output())
        .is_ok()
}

fn success<T: Serialize + Clone>(value: &T, pretty: bool) -> ExitCode {
    emit_stdout(&ApiEnvelope::success(value.clone()), pretty);
    ExitCode::SUCCESS
}

fn failure<T: Serialize>(error: agent2d_core::ErrorPayload, pretty: bool) -> ExitCode {
    emit_stderr(&ApiEnvelope::<T>::failure(error), pretty);
    ExitCode::from(2)
}

fn serialize<T: Serialize>(value: &T, pretty: bool) -> String {
    let serialized = if pretty {
        serde_json::to_string_pretty(value)
    } else {
        serde_json::to_string(value)
    };

    serialized.unwrap_or_else(|error| {
        format!(
            "{{\"schemaVersion\":\"0.1\",\"ok\":false,\"error\":{{\"code\":\"serialization_failed\",\"message\":{message:?}}}}}",
            message = error.to_string()
        )
    })
}

fn emit_stdout<T: Serialize>(value: &T, pretty: bool) {
    println!("{}", serialize(value, pretty));
}

fn emit_stderr<T: Serialize>(value: &T, pretty: bool) {
    eprintln!("{}", serialize(value, pretty));
}
