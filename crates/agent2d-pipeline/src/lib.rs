use std::time::Instant;

use agent2d_compression::compress_image_with_cancel;
use agent2d_core::{
    Agent2DError, Agent2DResult, CancellationToken, CompressRequest, InspectRequest,
    OptimizeRequest, UpscaleRequest, inspect_image,
};
use agent2d_sr::upscale_image_with_cancel;
use tempfile::tempdir;
use uuid::Uuid;

pub fn optimize_image(request: &OptimizeRequest) -> Result<Agent2DResult, Agent2DError> {
    optimize_image_with_cancel(request, &CancellationToken::new())
}

pub fn optimize_image_with_cancel(
    request: &OptimizeRequest,
    cancellation: &CancellationToken,
) -> Result<Agent2DResult, Agent2DError> {
    if cancellation.is_cancelled() {
        return Err(Agent2DError::Cancelled);
    }
    let started = Instant::now();
    let original = inspect_image(&InspectRequest {
        input_path: request.input_path.clone(),
    })?;

    let Some(upscale) = &request.upscale else {
        return compress_image_with_cancel(
            &CompressRequest {
                input_path: request.input_path.clone(),
                output_path: request.output_path.clone(),
                mode: request.compression.mode,
                format: request.compression.format,
                target_bytes: request.compression.target_bytes,
                preserve_metadata: Some(false),
            },
            cancellation,
        );
    };

    let temp = tempdir().map_err(|error| Agent2DError::ImageWrite {
        path: "temporary_directory".into(),
        message: error.to_string(),
    })?;
    let intermediate = temp.path().join("agent2d-sr-intermediate.png");

    let sr_result = upscale_image_with_cancel(
        &UpscaleRequest {
            input_path: request.input_path.clone(),
            output_path: intermediate.clone(),
            scale: upscale.scale,
            target_width: upscale.target_width,
            target_height: upscale.target_height,
            mode: upscale.mode,
            preset: None,
            model_id: None,
        },
        cancellation,
    )?;

    let compression_result = compress_image_with_cancel(
        &CompressRequest {
            input_path: intermediate,
            output_path: request.output_path.clone(),
            mode: request.compression.mode,
            format: request.compression.format,
            target_bytes: request.compression.target_bytes,
            preserve_metadata: Some(false),
        },
        cancellation,
    )?;

    let mut warnings = sr_result.warnings;
    warnings.extend(compression_result.warnings);
    warnings.push("combined_pipeline_sr_then_compression".into());

    Ok(Agent2DResult {
        job_id: Uuid::new_v4().to_string(),
        input_path: request.input_path.clone(),
        output_path: request.output_path.clone(),
        input_width: original.width,
        input_height: original.height,
        output_width: compression_result.output_width,
        output_height: compression_result.output_height,
        input_bytes: original.input_bytes,
        output_bytes: compression_result.output_bytes,
        compression_ratio: if compression_result.output_bytes == 0 {
            0.0
        } else {
            original.input_bytes as f64 / compression_result.output_bytes as f64
        },
        model_id: sr_result.model_id,
        codec: compression_result.codec,
        pixel_exact: Some(false),
        elapsed_ms: started.elapsed().as_millis() as u64,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent2d_core::{
        CompressionMode, CompressionOptions, OutputFormat, SuperResolutionMode, UpscaleOptions,
        UpscaleScale,
    };
    use agent2d_sr::capabilities;
    use image::{ImageFormat, Rgb, RgbImage};

    #[test]
    fn actual_optimize_runs_sr_then_exact_png_compression() {
        if capabilities().is_err() {
            return;
        }
        let dir = tempdir().unwrap();
        let input = dir.path().join("input.png");
        let output = dir.path().join("optimized.png");
        let mut image = RgbImage::new(24, 16);
        for (x, y, pixel) in image.enumerate_pixels_mut() {
            *pixel = Rgb([
                ((x * 3 + y * 7) % 256) as u8,
                ((x * 11 + y * 5) % 256) as u8,
                ((x * 17 + y * 13) % 256) as u8,
            ]);
        }
        image.save_with_format(&input, ImageFormat::Png).unwrap();

        let result = optimize_image(&OptimizeRequest {
            input_path: input.clone(),
            output_path: output.clone(),
            upscale: Some(UpscaleOptions {
                scale: Some(UpscaleScale::X2),
                target_width: None,
                target_height: None,
                mode: SuperResolutionMode::Balanced,
            }),
            compression: CompressionOptions {
                mode: CompressionMode::Exact,
                format: Some(OutputFormat::Png),
                target_bytes: None,
            },
        })
        .unwrap();

        assert_eq!((result.input_width, result.input_height), (24, 16));
        assert_eq!((result.output_width, result.output_height), (48, 32));
        assert_eq!(result.codec.as_deref(), Some("png"));
        assert!(result.model_id.is_some());
        assert_eq!(result.pixel_exact, Some(false));
        assert!(output.is_file());
        assert!(
            result
                .warnings
                .iter()
                .any(|warning| warning == "combined_pipeline_sr_then_compression")
        );
    }

    #[test]
    fn compression_only_path_reuses_compression_engine() {
        let dir = tempdir().unwrap();
        let input = dir.path().join("input.png");
        let output = dir.path().join("compressed.png");
        RgbImage::from_pixel(16, 8, Rgb([12, 34, 56]))
            .save_with_format(&input, ImageFormat::Png)
            .unwrap();

        let result = optimize_image(&OptimizeRequest {
            input_path: input,
            output_path: output,
            upscale: None,
            compression: CompressionOptions {
                mode: CompressionMode::Exact,
                format: Some(OutputFormat::Png),
                target_bytes: None,
            },
        })
        .unwrap();

        assert_eq!((result.output_width, result.output_height), (16, 8));
        assert_eq!(result.pixel_exact, Some(true));
    }
}
