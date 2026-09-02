use std::{
    path::Path,
    thread,
    time::{Duration, Instant},
};

use agent2d_compression::{compress_image, pixel_digest};
use agent2d_core::{
    Agent2DError, CancellationToken, CompressRequest, CompressionMode, OutputFormat,
    SuperResolutionMode, UpscaleRequest, UpscaleScale,
};
use agent2d_sr::{capabilities, upscale_image, upscale_image_with_cancel};
use image::{ImageFormat, Rgb, RgbImage};
use tempfile::tempdir;

fn fixture(path: &Path, width: u32, height: u32, seed: u32) {
    let mut image = RgbImage::new(width, height);
    for (x, y, pixel) in image.enumerate_pixels_mut() {
        let block = (((x / (3 + seed % 5)) + (y / (5 + seed % 7))) % 2) * 31;
        *pixel = Rgb([
            ((x * (seed + 3) + y * 5 + block) % 256) as u8,
            ((y * (seed + 7) + x * 3 + block * 2) % 256) as u8,
            (((x + y) * (seed + 11) + block * 3) % 256) as u8,
        ]);
    }
    image.save_with_format(path, ImageFormat::Png).unwrap();
}

#[test]
fn quality_compression_fixture_suite_5_exact_pngs() {
    for index in 0..5_u32 {
        let dir = tempdir().unwrap();
        let input = dir.path().join(format!("compression-{index}.png"));
        let output = dir.path().join(format!("compression-{index}-out.png"));
        fixture(&input, 80 + index * 13, 60 + index * 9, index + 1);
        let before = pixel_digest(&input).unwrap();
        let result = compress_image(&CompressRequest {
            input_path: input.clone(),
            output_path: output.clone(),
            mode: CompressionMode::Exact,
            format: Some(OutputFormat::Png),
            target_bytes: None,
            preserve_metadata: Some(false),
        })
        .unwrap();
        assert_eq!(result.pixel_exact, Some(true));
        assert_eq!(before, pixel_digest(&output).unwrap());
        assert_eq!(
            (result.input_width, result.input_height),
            (result.output_width, result.output_height)
        );
    }
}

#[test]
fn quality_sr_fixture_suite_all_managed_models() {
    let Ok(caps) = capabilities() else {
        return;
    };
    assert!(caps.models.len() >= 3);
    for (index, model) in caps.models.iter().enumerate() {
        let dir = tempdir().unwrap();
        let input = dir.path().join(format!("sr-{index}.png"));
        let output = dir.path().join(format!("sr-{index}-out.png"));
        fixture(&input, 40, 28, index as u32 + 3);
        let result = upscale_image(&UpscaleRequest {
            input_path: input,
            output_path: output.clone(),
            scale: Some(UpscaleScale::X2),
            target_width: None,
            target_height: None,
            mode: SuperResolutionMode::Balanced,
            preset: None,
            model_id: Some(model.id.clone()),
        })
        .unwrap();
        assert_eq!((result.output_width, result.output_height), (80, 56));
        assert_eq!(result.model_id.as_deref(), Some(model.id.as_str()));
        assert!(output.is_file());
    }
}

#[test]
fn actual_cancellation_terminates_ncnn_and_removes_output() {
    if capabilities().is_err() {
        return;
    }
    let dir = tempdir().unwrap();
    let input = dir.path().join("cancel-input.png");
    let output = dir.path().join("cancel-output.png");
    fixture(&input, 1024, 768, 19);
    let cancellation = CancellationToken::new();
    let worker_token = cancellation.clone();
    let worker_input = input.clone();
    let worker_output = output.clone();
    let worker = thread::spawn(move || {
        upscale_image_with_cancel(
            &UpscaleRequest {
                input_path: worker_input,
                output_path: worker_output,
                scale: Some(UpscaleScale::X4),
                target_width: None,
                target_height: None,
                mode: SuperResolutionMode::Balanced,
                preset: None,
                model_id: Some("realesrgan-x4plus".into()),
            },
            &worker_token,
        )
    });
    thread::sleep(Duration::from_millis(80));
    cancellation.cancel();
    let result = worker.join().unwrap();
    assert!(matches!(result, Err(Agent2DError::Cancelled)));
    assert!(!output.exists());
}

#[test]
#[ignore = "explicit M3 Air benchmark: ~1536x1024 -> 3072x2048 actual NCNN/Vulkan work"]
fn benchmark_m3_air_1536x1024_x2() {
    if capabilities().is_err() {
        return;
    }
    let dir = tempdir().unwrap();
    let input = dir.path().join("benchmark-1536x1024.png");
    let output = dir.path().join("benchmark-3072x2048.png");
    fixture(&input, 1536, 1024, 23);
    let started = Instant::now();
    let result = upscale_image(&UpscaleRequest {
        input_path: input,
        output_path: output.clone(),
        scale: Some(UpscaleScale::X2),
        target_width: None,
        target_height: None,
        mode: SuperResolutionMode::Balanced,
        preset: None,
        model_id: Some("realesrgan-x4plus".into()),
    })
    .unwrap();
    let elapsed = started.elapsed();
    assert_eq!((result.output_width, result.output_height), (3072, 2048));

    let image = image::open(&output).unwrap().to_rgb8();
    let (width, height) = image.dimensions();
    for y in (128..height).step_by(128) {
        let mean = (0..width)
            .map(|x| {
                image
                    .get_pixel(x, y)
                    .0
                    .iter()
                    .map(|v| *v as u64)
                    .sum::<u64>()
            })
            .sum::<u64>()
            / (width as u64 * 3);
        assert!(mean > 2, "suspicious dark horizontal seam at y={y}");
    }
    for x in (128..width).step_by(128) {
        let mean = (0..height)
            .map(|y| {
                image
                    .get_pixel(x, y)
                    .0
                    .iter()
                    .map(|v| *v as u64)
                    .sum::<u64>()
            })
            .sum::<u64>()
            / (height as u64 * 3);
        assert!(mean > 2, "suspicious dark vertical seam at x={x}");
    }
    println!(
        "AGENT2D_BENCHMARK input=1536x1024 output=3072x2048 elapsed_ms={} output_bytes={}",
        elapsed.as_millis(),
        result.output_bytes
    );
}
