use std::fs;

use image::{ColorType, GenericImageView, ImageFormat, ImageReader};
use uuid::Uuid;

use crate::{Agent2DError, InspectRequest, InspectResult};

pub fn inspect_image(request: &InspectRequest) -> Result<InspectResult, Agent2DError> {
    let path = request.input_path.as_path();
    let display_path = Agent2DError::display_path(path);

    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
            return Err(Agent2DError::InputNotFound { path: display_path });
        }
        Err(source) => {
            return Err(Agent2DError::Metadata {
                path: display_path,
                source,
            });
        }
    };

    if metadata.file_type().is_symlink() {
        return Err(Agent2DError::SymlinkInput { path: display_path });
    }
    if !metadata.is_file() {
        return Err(Agent2DError::NotAFile { path: display_path });
    }

    let reader = ImageReader::open(path).map_err(|source| Agent2DError::ImageOpen {
        path: display_path.clone(),
        source,
    })?;
    let reader = reader
        .with_guessed_format()
        .map_err(|source| Agent2DError::ImageFormat {
            path: display_path.clone(),
            source,
        })?;
    let format = reader
        .format()
        .ok_or_else(|| Agent2DError::UnsupportedFormat {
            format: "unknown".to_owned(),
        })?;

    if !matches!(format, ImageFormat::Png | ImageFormat::Jpeg) {
        return Err(Agent2DError::UnsupportedFormat {
            format: canonical_format_name(format),
        });
    }

    let decoded = reader
        .decode()
        .map_err(|source| Agent2DError::ImageDecode {
            path: display_path.clone(),
            source,
        })?;
    let (width, height) = decoded.dimensions();
    let color = decoded.color();

    Ok(InspectResult {
        job_id: Uuid::new_v4().to_string(),
        input_path: request.input_path.clone(),
        format: canonical_format_name(format),
        width,
        height,
        input_bytes: metadata.len(),
        has_alpha: color.has_alpha(),
        bit_depth: bit_depth(color),
        color_type: canonical_color_name(color).to_owned(),
        warnings: vec![],
    })
}

fn canonical_format_name(format: ImageFormat) -> String {
    match format {
        ImageFormat::Png => "png".to_owned(),
        ImageFormat::Jpeg => "jpeg".to_owned(),
        other => format!("{other:?}").to_lowercase(),
    }
}

fn bit_depth(color: ColorType) -> u8 {
    match color {
        ColorType::L8 | ColorType::La8 | ColorType::Rgb8 | ColorType::Rgba8 => 8,
        ColorType::L16 | ColorType::La16 | ColorType::Rgb16 | ColorType::Rgba16 => 16,
        ColorType::Rgb32F | ColorType::Rgba32F => 32,
        _ => 0,
    }
}

fn canonical_color_name(color: ColorType) -> &'static str {
    match color {
        ColorType::L8 => "l8",
        ColorType::La8 => "la8",
        ColorType::Rgb8 => "rgb8",
        ColorType::Rgba8 => "rgba8",
        ColorType::L16 => "l16",
        ColorType::La16 => "la16",
        ColorType::Rgb16 => "rgb16",
        ColorType::Rgba16 => "rgba16",
        ColorType::Rgb32F => "rgb32f",
        ColorType::Rgba32F => "rgba32f",
        _ => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use image::{ImageFormat, Rgba, RgbaImage};
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn inspects_png_dimensions_alpha_and_bytes() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("sample.png");
        RgbaImage::from_pixel(3, 2, Rgba([10, 20, 30, 40]))
            .save_with_format(&path, ImageFormat::Png)
            .unwrap();

        let result = inspect_image(&InspectRequest {
            input_path: path.clone(),
        })
        .unwrap();

        assert_eq!(result.input_path, path);
        assert_eq!(result.format, "png");
        assert_eq!((result.width, result.height), (3, 2));
        assert_eq!(result.bit_depth, 8);
        assert!(result.has_alpha);
        assert!(result.input_bytes > 0);
        assert_eq!(result.color_type, "rgba8");
    }

    #[test]
    fn missing_input_has_stable_error_code() {
        let error = inspect_image(&InspectRequest {
            input_path: "/definitely/missing/agent2d.png".into(),
        })
        .unwrap_err();
        assert_eq!(error.code(), "input_not_found");
    }

    #[cfg(unix)]
    #[test]
    fn symlink_input_is_rejected() {
        use std::os::unix::fs::symlink;

        let dir = tempdir().unwrap();
        let target = dir.path().join("target.png");
        let link = dir.path().join("link.png");
        RgbaImage::from_pixel(1, 1, Rgba([0, 0, 0, 255]))
            .save_with_format(&target, ImageFormat::Png)
            .unwrap();
        symlink(&target, &link).unwrap();

        let error = inspect_image(&InspectRequest { input_path: link }).unwrap_err();
        assert_eq!(error.code(), "symlink_input_rejected");
    }
}
