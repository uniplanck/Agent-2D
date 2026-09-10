use std::{
    env, fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use agent2d_compression::compress_image_with_cancel;
use agent2d_core::{
    Agent2DError, Agent2DResult, CancellationToken, CompressRequest, CompressionMode,
    InspectRequest, OutputFormat, RestoreMode, RestoreRequest, cleanup_output, inspect_image,
    validate_output_path,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::background::{
    BACKGROUND_TORCH_VERSION, BACKGROUND_TORCHVISION_VERSION, install_portable_python,
};
use crate::background_runtime_status;

pub const RESTORATION_RUNTIME_RELEASE_ID: &str = "restoration-gfpgan-1.4-nafnet32-v2";
pub const GFPGAN_MODEL_ID: &str = "TencentARC/GFPGANv1.4";
pub const NAFNET_DENOISE_MODEL_ID: &str = "megvii-research/NAFNet-SIDD-width32";
pub const NAFNET_DEBLUR_MODEL_ID: &str = "megvii-research/NAFNet-GoPro-width32";
pub const GFPGAN_MODEL_URL: &str = "https://github.com/TencentARC/GFPGAN/releases/download/v1.3.0/GFPGANv1.4.pth";
pub const NAFNET_DENOISE_MODEL_URL: &str = "https://drive.usercontent.google.com/download?id=1lsByk21Xw-6aW7epCwOQxvm6HYCQZPHZ&export=download&confirm=t";
pub const NAFNET_DEBLUR_MODEL_URL: &str = "https://drive.usercontent.google.com/download?id=1Fr2QadtDCEXg6iwWX8OzeZLbHOx2t5Bj&export=download&confirm=t";
const GFPGAN_DETECTION_MODEL_URL: &str = "https://github.com/xinntao/facexlib/releases/download/v0.1.0/detection_Resnet50_Final.pth";
const GFPGAN_PARSING_MODEL_URL: &str = "https://github.com/xinntao/facexlib/releases/download/v0.2.2/parsing_parsenet.pth";
const GFPGAN_SHA256: &str = "e2cd4703ab14f4d01fd1383a8a8b266f9a5833dacee8e6a79d3bf21a1b6be5ad";
const NAFNET_DENOISE_SHA256: &str = "89c70e808d1783b6c07911306e106aaf0d4f7f3da8c61078b99ff7f8929a26f4";
const NAFNET_DEBLUR_SHA256: &str = "19394e6155d12ef6371d1d57496f87f0ec88f92bdffa27c0792690722d5d1a5c";
const GFPGAN_DETECTION_SHA256: &str = "6d1de9c2944f2ccddca5f5e010ea5ae64a39845a86311af6fdf30841b0a5a16d";
const GFPGAN_PARSING_SHA256: &str = "3d558d8d0e42c20224f13cf5a29c79eba2d59913419f945545d8cf7b72920de2";
const GFPGAN_PACKAGE_VERSION: &str = "1.3.8";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorationRuntimeStatus {
    pub installed: bool,
    pub managed: bool,
    pub release_id: String,
    pub root: PathBuf,
    pub python_path: PathBuf,
    pub runner_path: PathBuf,
    pub site_packages_path: PathBuf,
    pub gfpgan_model_path: PathBuf,
    pub nafnet_denoise_model_path: PathBuf,
    pub nafnet_deblur_model_path: PathBuf,
    pub models: Vec<String>,
    pub shared_python_runtime: bool,
    pub size_bytes: u64,
}

fn app_support_dir() -> PathBuf {
    env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Library/Application Support/Agent-2D")
}

fn runtime_root() -> PathBuf {
    app_support_dir().join("runtime").join(RESTORATION_RUNTIME_RELEASE_ID)
}

fn runner_path(root: &Path) -> PathBuf { root.join("restore.py") }
fn site_path(root: &Path) -> PathBuf { root.join("site") }
fn gfpgan_path(root: &Path) -> PathBuf { root.join("GFPGANv1.4.pth") }
fn nafnet_denoise_path(root: &Path) -> PathBuf { root.join("NAFNet-SIDD-width32.pth") }
fn nafnet_deblur_path(root: &Path) -> PathBuf { root.join("NAFNet-GoPro-width32.pth") }
fn gfpgan_weights_dir(root: &Path) -> PathBuf { root.join("gfpgan/weights") }
fn gfpgan_detection_path(root: &Path) -> PathBuf { gfpgan_weights_dir(root).join("detection_Resnet50_Final.pth") }
fn gfpgan_parsing_path(root: &Path) -> PathBuf { gfpgan_weights_dir(root).join("parsing_parsenet.pth") }
fn ready_path(root: &Path) -> PathBuf { root.join("READY") }
fn private_python_root(root: &Path) -> PathBuf { root.join("python") }
fn private_python_path(root: &Path) -> PathBuf { private_python_root(root).join("bin/python") }

fn directory_size(path: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(path) else { return 0 };
    entries.flatten().map(|entry| {
        let path = entry.path();
        match entry.metadata() {
            Ok(metadata) if metadata.is_file() => metadata.len(),
            Ok(metadata) if metadata.is_dir() => directory_size(&path),
            _ => 0,
        }
    }).sum()
}

fn sha256_file(path: &Path) -> Result<String, Agent2DError> {
    let mut file = fs::File::open(path).map_err(|error| Agent2DError::BackendFailed {
        backend: "restoration-runtime".into(),
        message: format!("failed to open {}: {error}", path.display()),
    })?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 1024 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|error| Agent2DError::BackendFailed {
            backend: "restoration-runtime".into(),
            message: format!("failed to hash {}: {error}", path.display()),
        })?;
        if count == 0 { break; }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn verify_sha256(path: &Path, expected: &str) -> Result<(), Agent2DError> {
    let actual = sha256_file(path)?;
    if actual != expected {
        return Err(Agent2DError::BackendFailed {
            backend: "restoration-runtime".into(),
            message: format!("checksum mismatch for {}: expected {expected}, got {actual}", path.display()),
        });
    }
    Ok(())
}

fn run_checked(command: &mut Command, backend: &str) -> Result<(), Agent2DError> {
    let status = command.status().map_err(|error| Agent2DError::BackendFailed {
        backend: backend.into(),
        message: error.to_string(),
    })?;
    if !status.success() {
        return Err(Agent2DError::BackendFailed {
            backend: backend.into(),
            message: format!("command exited with status {status}"),
        });
    }
    Ok(())
}

fn download_checked(url: &str, output: &Path, expected_sha256: &str) -> Result<(), Agent2DError> {
    if output.is_file() && verify_sha256(output, expected_sha256).is_ok() {
        return Ok(());
    }
    cleanup_output(output);
    let temp = output.with_extension(format!("download-{}", Uuid::new_v4()));
    let result = run_checked(
        Command::new("/usr/bin/curl")
            .args(["-fL", "--retry", "3", "--retry-delay", "2", "--connect-timeout", "20", "-o"])
            .arg(&temp)
            .arg(url)
            .stdout(Stdio::null()),
        "restoration-download",
    );
    if let Err(error) = result {
        cleanup_output(&temp);
        return Err(error);
    }
    if let Err(error) = verify_sha256(&temp, expected_sha256) {
        cleanup_output(&temp);
        return Err(error);
    }
    fs::rename(&temp, output).map_err(|error| Agent2DError::BackendFailed {
        backend: "restoration-runtime".into(),
        message: format!("failed to install {}: {error}", output.display()),
    })?;
    Ok(())
}

fn patch_basicsr(site: &Path) -> Result<(), Agent2DError> {
    let degradation = site.join("basicsr/data/degradations.py");
    let Ok(source) = fs::read_to_string(&degradation) else { return Ok(()) };
    let old = "from torchvision.transforms.functional_tensor import rgb_to_grayscale";
    if !source.contains(old) { return Ok(()) }
    let patched = source.replace(old, "from torchvision.transforms.functional import rgb_to_grayscale");
    fs::write(&degradation, patched).map_err(|error| Agent2DError::BackendFailed {
        backend: "restoration-runtime".into(),
        message: format!("failed to apply torchvision compatibility patch: {error}"),
    })
}

fn install_python_packages(python: &Path, site: &Path) -> Result<(), Agent2DError> {
    if site.join("gfpgan").is_dir() && site.join("basicsr").is_dir() && site.join("facexlib").is_dir() {
        patch_basicsr(site)?;
        return Ok(());
    }
    fs::create_dir_all(site).map_err(|error| Agent2DError::BackendFailed {
        backend: "restoration-runtime".into(), message: error.to_string(),
    })?;
    run_checked(
        Command::new(python)
            .args(["-m", "pip", "install", "--disable-pip-version-check", "--no-input", "--target"])
            .arg(site)
            .args([
                "gfpgan==1.3.8",
                "basicsr==1.4.2",
                "facexlib==0.3.0",
                "opencv-python-headless==5.0.0.93",
                "scipy==1.15.3",
                "pyyaml==6.0.3",
                "lmdb==2.3.0",
                "tqdm==4.70.0",
                "yapf==0.43.0",
                "filterpy==1.4.5",
                "addict==2.4.0",
                "future==1.0.0",
                "requests==2.32.5",
                "scikit-image==0.25.2",
                "numba==0.63.1",
            ])
            .stdout(Stdio::null()),
        "restoration-python-deps",
    )?;
    patch_basicsr(site)
}

fn runner_source() -> &'static str {
    r#"import argparse
import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image
import torch
import torch.nn as nn
import torch.nn.functional as F


def choose_device():
    if hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
        return torch.device('mps')
    return torch.device('cpu')


class LayerNorm2d(nn.Module):
    def __init__(self, channels, eps=1e-6):
        super().__init__()
        self.weight = nn.Parameter(torch.ones(channels))
        self.bias = nn.Parameter(torch.zeros(channels))
        self.eps = eps

    def forward(self, x):
        y = x.permute(0, 2, 3, 1)
        y = F.layer_norm(y, (y.shape[-1],), self.weight, self.bias, self.eps)
        return y.permute(0, 3, 1, 2)


class SimpleGate(nn.Module):
    def forward(self, x):
        a, b = x.chunk(2, dim=1)
        return a * b


class LocalPool(nn.Module):
    def __init__(self, kernel=384):
        super().__init__()
        self.kernel = kernel

    def forward(self, x):
        h, w = x.shape[-2:]
        kh, kw = min(self.kernel, h), min(self.kernel, w)
        if kh >= h and kw >= w:
            return F.adaptive_avg_pool2d(x, 1)
        pooled = F.avg_pool2d(x, (kh, kw), stride=1)
        pad_h, pad_w = h - pooled.shape[-2], w - pooled.shape[-1]
        return F.pad(pooled, (pad_w // 2, pad_w - pad_w // 2, pad_h // 2, pad_h - pad_h // 2), mode='replicate')


class NAFBlock(nn.Module):
    def __init__(self, channels, local_pool=False):
        super().__init__()
        expanded = channels * 2
        self.conv1 = nn.Conv2d(channels, expanded, 1)
        self.conv2 = nn.Conv2d(expanded, expanded, 3, padding=1, groups=expanded)
        self.conv3 = nn.Conv2d(expanded // 2, channels, 1)
        self.sca = nn.Sequential(LocalPool() if local_pool else nn.AdaptiveAvgPool2d(1), nn.Conv2d(expanded // 2, expanded // 2, 1))
        self.sg = SimpleGate()
        ffn = channels * 2
        self.conv4 = nn.Conv2d(channels, ffn, 1)
        self.conv5 = nn.Conv2d(ffn // 2, channels, 1)
        self.norm1 = LayerNorm2d(channels)
        self.norm2 = LayerNorm2d(channels)
        self.dropout1 = nn.Identity()
        self.dropout2 = nn.Identity()
        self.beta = nn.Parameter(torch.zeros((1, channels, 1, 1)))
        self.gamma = nn.Parameter(torch.zeros((1, channels, 1, 1)))

    def forward(self, inp):
        x = self.conv1(self.norm1(inp))
        x = self.sg(self.conv2(x))
        x = self.conv3(x * self.sca(x))
        y = inp + self.dropout1(x) * self.beta
        x = self.conv5(self.sg(self.conv4(self.norm2(y))))
        return y + self.dropout2(x) * self.gamma


class NAFNet(nn.Module):
    def __init__(self, width, enc_blocks, middle_blocks, dec_blocks, local_pool=False):
        super().__init__()
        self.intro = nn.Conv2d(3, width, 3, padding=1)
        self.ending = nn.Conv2d(width, 3, 3, padding=1)
        self.encoders = nn.ModuleList()
        self.downs = nn.ModuleList()
        self.decoders = nn.ModuleList()
        self.ups = nn.ModuleList()
        channels = width
        for count in enc_blocks:
            self.encoders.append(nn.Sequential(*[NAFBlock(channels, local_pool) for _ in range(count)]))
            self.downs.append(nn.Conv2d(channels, channels * 2, 2, 2))
            channels *= 2
        self.middle_blks = nn.Sequential(*[NAFBlock(channels, local_pool) for _ in range(middle_blocks)])
        for count in dec_blocks:
            self.ups.append(nn.Sequential(nn.Conv2d(channels, channels * 2, 1, bias=False), nn.PixelShuffle(2)))
            channels //= 2
            self.decoders.append(nn.Sequential(*[NAFBlock(channels, local_pool) for _ in range(count)]))
        self.padder_size = 2 ** len(self.encoders)

    def forward(self, inp):
        h, w = inp.shape[-2:]
        pad_h = (self.padder_size - h % self.padder_size) % self.padder_size
        pad_w = (self.padder_size - w % self.padder_size) % self.padder_size
        padded = F.pad(inp, (0, pad_w, 0, pad_h))
        x = self.intro(padded)
        skips = []
        for encoder, down in zip(self.encoders, self.downs):
            x = encoder(x)
            skips.append(x)
            x = down(x)
        x = self.middle_blks(x)
        for decoder, up, skip in zip(self.decoders, self.ups, reversed(skips)):
            x = decoder(up(x) + skip)
        return (self.ending(x) + padded)[:, :, :h, :w]


def load_checkpoint(path):
    try:
        checkpoint = torch.load(path, map_location='cpu', weights_only=True)
    except TypeError:
        checkpoint = torch.load(path, map_location='cpu')
    if isinstance(checkpoint, dict):
        for key in ('params', 'params_ema', 'state_dict'):
            if key in checkpoint and isinstance(checkpoint[key], dict):
                return checkpoint[key]
    return checkpoint


def naf_model(mode, model_path, device):
    if mode == 'denoise':
        model = NAFNet(32, [2, 2, 4, 8], 12, [2, 2, 2, 2], local_pool=False)
    else:
        model = NAFNet(32, [1, 1, 1, 28], 1, [1, 1, 1, 1], local_pool=True)
    model.load_state_dict(load_checkpoint(model_path), strict=True)
    model.eval().to(device)
    return model


def tile_starts(length, tile, overlap):
    if length <= tile:
        return [0]
    stride = tile - overlap
    values = list(range(0, max(1, length - tile + 1), stride))
    last = length - tile
    if not values or values[-1] != last:
        values.append(last)
    return values


def feather_weights(height, width, top, left, full_h, full_w, overlap):
    weight = np.ones((height, width), dtype=np.float32)
    ramp_h = min(overlap, height // 3)
    ramp_w = min(overlap, width // 3)
    if top > 0 and ramp_h:
        weight[:ramp_h, :] *= np.linspace(0.05, 1.0, ramp_h, dtype=np.float32)[:, None]
    if top + height < full_h and ramp_h:
        weight[-ramp_h:, :] *= np.linspace(1.0, 0.05, ramp_h, dtype=np.float32)[:, None]
    if left > 0 and ramp_w:
        weight[:, :ramp_w] *= np.linspace(0.05, 1.0, ramp_w, dtype=np.float32)[None, :]
    if left + width < full_w and ramp_w:
        weight[:, -ramp_w:] *= np.linspace(1.0, 0.05, ramp_w, dtype=np.float32)[None, :]
    return weight


def run_naf(rgb, mode, model_path, device):
    model = naf_model(mode, model_path, device)
    full_h, full_w = rgb.shape[:2]
    tile, overlap = 512, 48
    accum = np.zeros((full_h, full_w, 3), dtype=np.float32)
    weights = np.zeros((full_h, full_w, 1), dtype=np.float32)
    with torch.inference_mode():
        for top in tile_starts(full_h, tile, overlap):
            for left in tile_starts(full_w, tile, overlap):
                patch = rgb[top:min(top + tile, full_h), left:min(left + tile, full_w)]
                tensor = torch.from_numpy(patch.astype(np.float32) / 255.0).permute(2, 0, 1).unsqueeze(0).to(device)
                try:
                    restored = model(tensor).clamp(0, 1)
                except RuntimeError as error:
                    if device.type == 'mps' and ('MPS' in str(error) or 'memory' in str(error).lower()):
                        device = torch.device('cpu')
                        model = model.to(device)
                        tensor = tensor.to(device)
                        restored = model(tensor).clamp(0, 1)
                    else:
                        raise
                restored = restored.squeeze(0).permute(1, 2, 0).detach().cpu().numpy()
                h, w = patch.shape[:2]
                restored = restored[:h, :w]
                weight = feather_weights(h, w, top, left, full_h, full_w, overlap)[..., None]
                accum[top:top+h, left:left+w] += restored * weight
                weights[top:top+h, left:left+w] += weight
    return np.clip(accum / np.maximum(weights, 1e-6) * 255.0 + 0.5, 0, 255).astype(np.uint8)


def run_face(rgb, model_path, site_path, device):
    sys.path.insert(0, site_path)
    from gfpgan import GFPGANer
    import cv2
    restorer = GFPGANer(model_path=model_path, upscale=1, arch='clean', channel_multiplier=2, bg_upsampler=None, device=device)
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    _, _, restored = restorer.enhance(bgr, has_aligned=False, only_center_face=False, paste_back=True, weight=0.5)
    if restored is None:
        return rgb
    return cv2.cvtColor(restored, cv2.COLOR_BGR2RGB)


def process(args):
    image = Image.open(args.input)
    alpha = np.array(image.getchannel('A')) if 'A' in image.getbands() else None
    rgb = np.array(image.convert('RGB'))
    device = choose_device()
    if args.mode == 'face':
        restored = run_face(rgb, args.gfpgan_model, args.site, device)
    elif args.mode == 'denoise':
        restored = run_naf(rgb, 'denoise', args.naf_denoise_model, device)
    else:
        restored = run_naf(rgb, 'deblur', args.naf_deblur_model, device)
    out = Image.fromarray(restored, 'RGB')
    if alpha is not None:
        out.putalpha(Image.fromarray(alpha, 'L'))
    out.save(args.output, format='PNG', optimize=False)


def prepare(args):
    device = choose_device()
    naf_model('denoise', args.naf_denoise_model, device)
    naf_model('deblur', args.naf_deblur_model, device)
    sys.path.insert(0, args.site)
    from gfpgan import GFPGANer
    GFPGANer(model_path=args.gfpgan_model, upscale=1, arch='clean', channel_multiplier=2, bg_upsampler=None, device=device)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input')
    parser.add_argument('--output')
    parser.add_argument('--mode', choices=['face', 'denoise', 'deblur'])
    parser.add_argument('--site', required=True)
    parser.add_argument('--gfpgan-model', required=True)
    parser.add_argument('--naf-denoise-model', required=True)
    parser.add_argument('--naf-deblur-model', required=True)
    parser.add_argument('--prepare', action='store_true')
    args = parser.parse_args()
    if args.prepare:
        prepare(args)
        return
    if not args.input or not args.output or not args.mode:
        parser.error('--input, --output and --mode are required unless --prepare is used')
    process(args)


if __name__ == '__main__':
    main()
"#
}

fn write_runner(root: &Path) -> Result<PathBuf, Agent2DError> {
    let path = runner_path(root);
    fs::write(&path, runner_source()).map_err(|error| Agent2DError::BackendFailed {
        backend: "restoration-runtime".into(), message: error.to_string(),
    })?;
    Ok(path)
}

fn runner_command(python: &Path, root: &Path) -> Command {
    let mut command = Command::new(python);
    command
        .current_dir(root)
        .arg(runner_path(root))
        .arg("--site").arg(site_path(root))
        .arg("--gfpgan-model").arg(gfpgan_path(root))
        .arg("--naf-denoise-model").arg(nafnet_denoise_path(root))
        .arg("--naf-deblur-model").arg(nafnet_deblur_path(root));
    command
}

pub fn restoration_runtime_status() -> Result<RestorationRuntimeStatus, Agent2DError> {
    let root = runtime_root();
    let background = background_runtime_status().ok().filter(|status| status.installed);
    let shared_python_runtime = background.is_some();
    let python_path = background
        .as_ref()
        .map(|status| status.python_path.clone())
        .filter(|path| path.is_file())
        .unwrap_or_else(|| private_python_path(&root));
    let installed = ready_path(&root).is_file()
        && python_path.is_file()
        && runner_path(&root).is_file()
        && site_path(&root).join("gfpgan").is_dir()
        && gfpgan_path(&root).is_file()
        && nafnet_denoise_path(&root).is_file()
        && nafnet_deblur_path(&root).is_file()
        && gfpgan_detection_path(&root).is_file()
        && gfpgan_parsing_path(&root).is_file();
    Ok(RestorationRuntimeStatus {
        installed,
        managed: true,
        release_id: RESTORATION_RUNTIME_RELEASE_ID.into(),
        root: root.clone(),
        python_path,
        runner_path: runner_path(&root),
        site_packages_path: site_path(&root),
        gfpgan_model_path: gfpgan_path(&root),
        nafnet_denoise_model_path: nafnet_denoise_path(&root),
        nafnet_deblur_model_path: nafnet_deblur_path(&root),
        models: vec![GFPGAN_MODEL_ID.into(), NAFNET_DENOISE_MODEL_ID.into(), NAFNET_DEBLUR_MODEL_ID.into()],
        shared_python_runtime,
        size_bytes: directory_size(&root),
    })
}

pub fn install_restoration_runtime() -> Result<RestorationRuntimeStatus, Agent2DError> {
    let background = background_runtime_status().ok().filter(|status| status.installed);
    let root = runtime_root();
    fs::create_dir_all(&root).map_err(|error| Agent2DError::BackendFailed {
        backend: "restoration-runtime".into(), message: error.to_string(),
    })?;
    cleanup_output(&ready_path(&root));
    write_runner(&root)?;
    let python_path = if let Some(background) = &background {
        background.python_path.clone()
    } else {
        let python_root = private_python_root(&root);
        fs::create_dir_all(&python_root).map_err(|error| Agent2DError::BackendFailed {
            backend: "restoration-runtime".into(), message: error.to_string(),
        })?;
        if !private_python_path(&root).is_file() {
            install_portable_python(&python_root)?;
        }
        let python = private_python_path(&root);
        run_checked(
            Command::new(&python)
                .args([
                    "-m",
                    "pip",
                    "install",
                    "--disable-pip-version-check",
                    "--no-input",
                    "--no-cache-dir",
                    &format!("torch=={BACKGROUND_TORCH_VERSION}"),
                    &format!("torchvision=={BACKGROUND_TORCHVISION_VERSION}"),
                ]),
            "restoration-python-runtime",
        )?;
        python
    };
    install_python_packages(&python_path, &site_path(&root))?;
    download_checked(GFPGAN_MODEL_URL, &gfpgan_path(&root), GFPGAN_SHA256)?;
    download_checked(NAFNET_DENOISE_MODEL_URL, &nafnet_denoise_path(&root), NAFNET_DENOISE_SHA256)?;
    download_checked(NAFNET_DEBLUR_MODEL_URL, &nafnet_deblur_path(&root), NAFNET_DEBLUR_SHA256)?;
    fs::create_dir_all(gfpgan_weights_dir(&root)).map_err(|error| Agent2DError::BackendFailed {
        backend: "restoration-runtime".into(), message: error.to_string(),
    })?;
    download_checked(GFPGAN_DETECTION_MODEL_URL, &gfpgan_detection_path(&root), GFPGAN_DETECTION_SHA256)?;
    download_checked(GFPGAN_PARSING_MODEL_URL, &gfpgan_parsing_path(&root), GFPGAN_PARSING_SHA256)?;
    run_checked(
        runner_command(&python_path, &root).arg("--prepare").stdout(Stdio::null()),
        "restoration-runtime",
    )?;
    fs::write(
        root.join("SOURCE.txt"),
        format!(
            "release={}\nGFPGAN={}\nGFPGAN_package={}\nGFPGAN_url={}\nGFPGAN_sha256={}\nNAFNet_denoise={}\nNAFNet_denoise_url={}\nNAFNet_denoise_sha256={}\nNAFNet_deblur={}\nNAFNet_deblur_url={}\nNAFNet_deblur_sha256={}\nGFPGAN_detection_url={}\nGFPGAN_detection_sha256={}\nGFPGAN_parsing_url={}\nGFPGAN_parsing_sha256={}\nshared_python={}\n",
            RESTORATION_RUNTIME_RELEASE_ID,
            GFPGAN_MODEL_ID,
            GFPGAN_PACKAGE_VERSION,
            GFPGAN_MODEL_URL,
            GFPGAN_SHA256,
            NAFNET_DENOISE_MODEL_ID,
            NAFNET_DENOISE_MODEL_URL,
            NAFNET_DENOISE_SHA256,
            NAFNET_DEBLUR_MODEL_ID,
            NAFNET_DEBLUR_MODEL_URL,
            NAFNET_DEBLUR_SHA256,
            GFPGAN_DETECTION_MODEL_URL,
            GFPGAN_DETECTION_SHA256,
            GFPGAN_PARSING_MODEL_URL,
            GFPGAN_PARSING_SHA256,
            python_path.display(),
        ),
    ).map_err(|error| Agent2DError::BackendFailed { backend: "restoration-runtime".into(), message: error.to_string() })?;
    fs::write(ready_path(&root), b"ready\n").map_err(|error| Agent2DError::BackendFailed {
        backend: "restoration-runtime".into(), message: error.to_string(),
    })?;
    restoration_runtime_status()
}

pub fn restore_image(request: &RestoreRequest) -> Result<Agent2DResult, Agent2DError> {
    restore_image_with_cancel(request, &CancellationToken::new())
}

pub fn restore_image_with_cancel(
    request: &RestoreRequest,
    cancellation: &CancellationToken,
) -> Result<Agent2DResult, Agent2DError> {
    if cancellation.is_cancelled() { return Err(Agent2DError::Cancelled); }
    validate_output_path(&request.input_path, &request.output_path)?;
    let status = restoration_runtime_status()?;
    if !status.installed {
        return Err(Agent2DError::BackendUnavailable { backend: "restoration-runtime".into() });
    }
    let input = inspect_image(&InspectRequest { input_path: request.input_path.clone() })?;
    let started = Instant::now();
    let temp = env::temp_dir().join(format!("agent2d-restore-{}.png", Uuid::new_v4()));
    let mode = match request.mode { RestoreMode::Face => "face", RestoreMode::Denoise => "denoise", RestoreMode::Deblur => "deblur" };
    let mut child = runner_command(&status.python_path, &status.root)
        .arg("--input").arg(&request.input_path)
        .arg("--output").arg(&temp)
        .arg("--mode").arg(mode)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| Agent2DError::BackendFailed { backend: "restoration-runtime".into(), message: error.to_string() })?;
    loop {
        if cancellation.is_cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            cleanup_output(&temp);
            return Err(Agent2DError::Cancelled);
        }
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(status)) => {
                let mut stderr = String::new();
                if let Some(mut stream) = child.stderr.take() { let _ = stream.read_to_string(&mut stderr); }
                cleanup_output(&temp);
                return Err(Agent2DError::BackendFailed {
                    backend: "restoration-runtime".into(),
                    message: if stderr.trim().is_empty() { format!("restoration process exited with {status}") } else { stderr.trim().chars().take(1200).collect() },
                });
            }
            Ok(None) => thread::sleep(Duration::from_millis(60)),
            Err(error) => {
                cleanup_output(&temp);
                return Err(Agent2DError::BackendFailed { backend: "restoration-runtime".into(), message: error.to_string() });
            }
        }
    }
    let output_mode = match request.format {
        OutputFormat::Jpeg | OutputFormat::Avif => CompressionMode::Preserve,
        OutputFormat::Png | OutputFormat::Webp | OutputFormat::Jxl | OutputFormat::Tiff | OutputFormat::Bmp => {
            CompressionMode::Exact
        }
    };
    let compressed = compress_image_with_cancel(
        &CompressRequest {
            input_path: temp.clone(),
            output_path: request.output_path.clone(),
            mode: output_mode,
            format: Some(request.format),
            target_bytes: None,
            preserve_metadata: Some(false),
        },
        cancellation,
    );
    cleanup_output(&temp);
    let mut result = compressed?;
    result.input_path = request.input_path.clone();
    result.input_width = input.width;
    result.input_height = input.height;
    result.input_bytes = input.input_bytes;
    result.compression_ratio = if result.output_bytes == 0 { 0.0 } else { input.input_bytes as f64 / result.output_bytes as f64 };
    result.model_id = Some(match request.mode {
        RestoreMode::Face => GFPGAN_MODEL_ID,
        RestoreMode::Denoise => NAFNET_DENOISE_MODEL_ID,
        RestoreMode::Deblur => NAFNET_DEBLUR_MODEL_ID,
    }.into());
    result.codec = Some(format!("restore-{mode}"));
    result.pixel_exact = Some(false);
    result.elapsed_ms = started.elapsed().as_millis() as u64;
    result.warnings.push(format!("restoration_mode_{mode}"));
    result.warnings.push(format!("managed_restoration_runtime_{RESTORATION_RUNTIME_RELEASE_ID}"));
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restoration_runtime_contract_lists_three_models() {
        let status = restoration_runtime_status().expect("status");
        assert_eq!(status.release_id, RESTORATION_RUNTIME_RELEASE_ID);
        assert_eq!(status.models.len(), 3);
        assert!(status.models.iter().any(|id| id.contains("GFPGAN")));
        assert!(status.models.iter().any(|id| id.contains("SIDD")));
        assert!(status.models.iter().any(|id| id.contains("GoPro")));
    }

    #[test]
    fn model_checksums_are_sha256_length() {
        assert_eq!(GFPGAN_SHA256.len(), 64);
        assert_eq!(NAFNET_DENOISE_SHA256.len(), 64);
        assert_eq!(NAFNET_DEBLUR_SHA256.len(), 64);
        assert_eq!(GFPGAN_DETECTION_SHA256.len(), 64);
        assert_eq!(GFPGAN_PARSING_SHA256.len(), 64);
    }

    #[test]
    #[ignore = "downloads the managed restoration runtime and runs real GFPGAN/NAFNet inference"]
    fn restoration_runtime_real_e2e() {
        let input = std::env::var_os("AGENT2D_RESTORE_E2E_INPUT")
            .map(PathBuf::from)
            .expect("AGENT2D_RESTORE_E2E_INPUT must point to a local image");
        assert!(input.is_file(), "E2E input does not exist: {}", input.display());

        let runtime = restoration_runtime_status().expect("restoration runtime status");
        let runtime = if runtime.installed {
            runtime
        } else {
            install_restoration_runtime().expect("install restoration runtime")
        };
        assert!(runtime.installed);
        let temp = tempfile::tempdir().expect("tempdir");

        for (mode, name, model_id) in [
            (RestoreMode::Face, "face", GFPGAN_MODEL_ID),
            (RestoreMode::Denoise, "denoise", NAFNET_DENOISE_MODEL_ID),
            (RestoreMode::Deblur, "deblur", NAFNET_DEBLUR_MODEL_ID),
        ] {
            let output = temp.path().join(format!("{name}.png"));
            let result = restore_image(&RestoreRequest {
                input_path: input.clone(),
                output_path: output.clone(),
                mode,
                format: agent2d_core::OutputFormat::Png,
            })
            .unwrap_or_else(|error| panic!("{name} restore failed: {error}"));
            assert!(output.is_file(), "{name} output missing");
            assert!(result.output_bytes > 0, "{name} output is empty");
            assert_eq!(result.model_id.as_deref(), Some(model_id));
            assert_eq!(result.output_width, result.input_width);
            assert_eq!(result.output_height, result.input_height);
        }
    }
}
