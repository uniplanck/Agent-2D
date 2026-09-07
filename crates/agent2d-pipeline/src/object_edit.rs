use std::{
    env,
    fs::{self, File},
    io::{BufRead, BufReader, BufWriter, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};

use agent2d_core::{
    Agent2DError, Agent2DResult, CancellationToken, InspectRequest, ObjectEditAction,
    ObjectEditRequest, ObjectPointLabel, ObjectSelection, ObjectSelectionRequest,
    ObjectSelectionResult, OutputFormat, cleanup_output, inspect_image, validate_output_path,
};
use serde::{Deserialize, Serialize};
use tempfile::tempdir;
use uuid::Uuid;

use super::{background_runtime_status, install_background_runtime, run_transform_to_png};

pub const OBJECT_SAM_MODEL_ID: &str = "facebook/sam2.1-hiera-base-plus";
pub const OBJECT_SAM_MODEL_REVISION: &str = "b732075";
pub const OBJECT_LAMA_MODEL_URL: &str = "https://github.com/enesmsahin/simple-lama-inpainting/releases/download/v0.1.0/big-lama.pt";
pub const OBJECT_RUNTIME_RELEASE_ID: &str = "object-edit-sam2.1-base-plus-lama-v1";

const RUNNER_NAME: &str = "object_edit.py";
const LAMA_NAME: &str = "big-lama.pt";
const READY_NAME: &str = "READY";

const RUNNER_SCRIPT: &str = r#"#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
import sys
import tempfile
import time
import traceback
import urllib.request

os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

import numpy as np
from PIL import Image, ImageFilter

SAM_MODEL_ID = "facebook/sam2.1-hiera-base-plus"
SAM_MODEL_REVISION = "b732075"
LAMA_MODEL_URL = "https://github.com/enesmsahin/simple-lama-inpainting/releases/download/v0.1.0/big-lama.pt"

_torch = None
_Sam2Model = None
_Sam2Processor = None


def ensure_torch():
    global _torch
    if _torch is None:
        import torch as torch_module
        _torch = torch_module
    return _torch


def ensure_sam_runtime():
    global _Sam2Model, _Sam2Processor
    torch = ensure_torch()
    if _Sam2Model is None or _Sam2Processor is None:
        from transformers import Sam2Model as model_type, Sam2Processor as processor_type
        _Sam2Model = model_type
        _Sam2Processor = processor_type
    return torch, _Sam2Model, _Sam2Processor


def sam_device():
    torch = ensure_torch()
    requested = os.environ.get("AGENT2D_OBJECT_DEVICE", "auto").lower()
    if requested == "cpu":
        return torch.device("cpu")
    if requested == "mps":
        if not (hasattr(torch.backends, "mps") and torch.backends.mps.is_available()):
            raise RuntimeError("AGENT2D_OBJECT_DEVICE=mps requested but MPS is unavailable")
        return torch.device("mps")
    if requested != "auto":
        raise RuntimeError("AGENT2D_OBJECT_DEVICE must be auto, mps, or cpu")
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def load_sam(device, offline=True):
    _torch, Sam2Model, Sam2Processor = ensure_sam_runtime()
    kwargs = {"revision": SAM_MODEL_REVISION}
    if offline:
        kwargs["local_files_only"] = True
    processor = Sam2Processor.from_pretrained(SAM_MODEL_ID, **kwargs)
    model = Sam2Model.from_pretrained(SAM_MODEL_ID, **kwargs).eval().to(device)
    return model, processor


def download_lama(path):
    if os.path.isfile(path) and os.path.getsize(path) > 10_000_000:
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix="big-lama-", suffix=".pt", dir=os.path.dirname(path))
    os.close(fd)
    try:
        urllib.request.urlretrieve(LAMA_MODEL_URL, tmp)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def prepare(lama_model):
    _torch, Sam2Model, Sam2Processor = ensure_sam_runtime()
    Sam2Processor.from_pretrained(SAM_MODEL_ID, revision=SAM_MODEL_REVISION)
    model = Sam2Model.from_pretrained(SAM_MODEL_ID, revision=SAM_MODEL_REVISION).eval()
    del model
    download_lama(lama_model)
    print(json.dumps({"ready": True, "lamaSha256": sha256_file(lama_model)}))


def parse_json_arg(value, default):
    if value is None:
        return default
    return json.loads(value)


def best_mask(processor, outputs, original_sizes):
    torch = ensure_torch()
    masks = processor.post_process_masks(outputs.pred_masks.detach().cpu(), original_sizes)[0]
    scores = outputs.iou_scores.detach().cpu()[0, 0]
    best = int(torch.argmax(scores).item())
    mask = masks[0, best].detach().cpu().numpy()
    if mask.ndim != 2:
        mask = np.squeeze(mask)
    if mask.min() < 0.0 or mask.max() > 1.0:
        mask = 1.0 / (1.0 + np.exp(-np.clip(mask, -30.0, 30.0)))
    binary = (mask >= 0.5).astype(np.uint8) * 255
    return Image.fromarray(binary, mode="L"), float(scores[best].item())


class SamSession:
    def __init__(self, device=None):
        self.torch, _model_type, _processor_type = ensure_sam_runtime()
        self.requested = os.environ.get("AGENT2D_OBJECT_DEVICE", "auto").lower()
        self.device = device or sam_device()
        self.model, self.processor = load_sam(self.device, offline=True)
        self.cache_key = None
        self.cached_image = None
        self.original_sizes = None
        self.image_embeddings = None

    def switch_to_cpu(self):
        if self.device.type == "cpu":
            return
        try:
            if hasattr(self.torch.mps, "empty_cache"):
                self.torch.mps.empty_cache()
        except Exception:
            pass
        self.device = self.torch.device("cpu")
        self.model, self.processor = load_sam(self.device, offline=True)
        self.cache_key = None
        self.cached_image = None
        self.original_sizes = None
        self.image_embeddings = None

    def load_image(self, path):
        stat = os.stat(path)
        key = (os.path.realpath(path), stat.st_mtime_ns, stat.st_size)
        if key == self.cache_key and self.image_embeddings is not None:
            return self.cached_image
        image = Image.open(path).convert("RGB")
        encoded = self.processor(images=image, return_tensors="pt")
        self.original_sizes = encoded["original_sizes"].detach().cpu()
        pixels = encoded["pixel_values"].to(self.device)
        with self.torch.inference_mode():
            self.image_embeddings = self.model.get_image_embeddings(pixels)
        self.cache_key = key
        self.cached_image = image
        return image

    def predict_once(self, path, points, labels, box):
        image = self.load_image(path)
        kwargs = {"original_sizes": self.original_sizes, "return_tensors": "pt"}
        if points:
            kwargs["input_points"] = [[points]]
            kwargs["input_labels"] = [[labels]]
        if box is not None:
            kwargs["input_boxes"] = [[box]]
        prompts = self.processor(**kwargs)
        model_kwargs = {"image_embeddings": self.image_embeddings}
        for key in ("input_points", "input_labels", "input_boxes"):
            value = prompts.get(key)
            if value is not None:
                model_kwargs[key] = value.to(self.device)
        with self.torch.inference_mode():
            outputs = self.model(**model_kwargs)
        mask, score = best_mask(self.processor, outputs, self.original_sizes)
        return image, mask, score

    def predict(self, path, points, labels, box):
        try:
            return self.predict_once(path, points, labels, box)
        except Exception:
            if self.device.type == "mps" and self.requested == "auto":
                self.switch_to_cpu()
                return self.predict_once(path, points, labels, box)
            raise


def predict_mask(path, points, labels, box, device):
    session = SamSession(device)
    _source, mask, score = session.predict(path, points, labels, box)
    return mask, score


def adjusted_mask(mask, expand_px, feather_px):
    expand_px = int(max(-64, min(64, expand_px)))
    if expand_px > 0:
        mask = mask.filter(ImageFilter.MaxFilter(size=expand_px * 2 + 1))
    elif expand_px < 0:
        mask = mask.filter(ImageFilter.MinFilter(size=(-expand_px) * 2 + 1))
    feather_px = max(0.0, min(32.0, float(feather_px)))
    if feather_px > 0:
        mask = mask.filter(ImageFilter.GaussianBlur(radius=feather_px))
    return mask


def run_mask(args, device):
    points = parse_json_arg(args.points, [])
    labels = parse_json_arg(args.labels, [])
    box = parse_json_arg(args.box, None)
    if not points and box is None:
        raise RuntimeError("at least one point or a box prompt is required")
    if len(points) != len(labels):
        raise RuntimeError("point/label counts differ")
    session = SamSession(device)
    image, mask, score = session.predict(args.input, points, labels, box)
    mask = adjusted_mask(mask, args.expand, args.feather)
    mask.save(args.mask_output, format="PNG", optimize=True)
    print(json.dumps({"score": score, "width": image.width, "height": image.height}))


def serve_worker():
    session = SamSession()
    print(json.dumps({"ready": True, "device": session.device.type}), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request_started = time.perf_counter()
            payload = json.loads(line)
            points = payload.get("points") or []
            labels = payload.get("labels") or []
            box = payload.get("box")
            if not points and box is None:
                raise RuntimeError("at least one point or a box prompt is required")
            if len(points) != len(labels):
                raise RuntimeError("point/label counts differ")
            image, mask, score = session.predict(payload["input"], points, labels, box)
            mask = adjusted_mask(mask, payload.get("expand", 0), payload.get("feather", 0.0))
            mask.save(payload["maskOutput"], format="PNG", optimize=True)
            print(json.dumps({"ok": True, "score": score, "width": image.width, "height": image.height, "device": session.device.type, "elapsedMs": round((time.perf_counter() - request_started) * 1000, 1)}), flush=True)
        except Exception as error:
            traceback.print_exc(file=sys.stderr)
            print(json.dumps({"ok": False, "error": str(error)}), flush=True)


def pad_to_modulo(array, modulo=8):
    channels, height, width = array.shape
    out_h = ((height + modulo - 1) // modulo) * modulo
    out_w = ((width + modulo - 1) // modulo) * modulo
    return np.pad(array, ((0, 0), (0, out_h - height), (0, out_w - width)), mode="symmetric")


def lama_inpaint(image, mask, model_path, device):
    torch = ensure_torch()
    rgb = np.array(image.convert("RGB"), dtype=np.float32) / 255.0
    mask_arr = np.array(mask.convert("L"), dtype=np.float32) / 255.0
    h, w = rgb.shape[:2]
    image_chw = np.transpose(rgb, (2, 0, 1))
    mask_chw = mask_arr[np.newaxis, ...]
    image_chw = pad_to_modulo(image_chw)
    mask_chw = pad_to_modulo(mask_chw)
    image_t = torch.from_numpy(image_chw).unsqueeze(0).to(device)
    mask_t = torch.from_numpy(mask_chw).unsqueeze(0).to(device)
    mask_t = (mask_t > 0.05).to(image_t.dtype)
    model = torch.jit.load(model_path, map_location=device).eval().to(device)
    with torch.inference_mode():
        out = model(image_t, mask_t)
    out = out[0].permute(1, 2, 0).detach().cpu().numpy()[:h, :w]
    out = np.clip(out * 255.0, 0, 255).astype(np.uint8)
    return Image.fromarray(out, mode="RGB")


def save_image(image, path, fmt):
    if fmt == "png":
        image.save(path, format="PNG", optimize=True)
    elif fmt == "webp":
        image.save(path, format="WEBP", lossless=True, quality=100, method=6)
    elif fmt in ("jpg", "jpeg"):
        image.convert("RGB").save(path, format="JPEG", quality=95, subsampling=0)
    else:
        raise RuntimeError(f"unsupported object edit output format: {fmt}")


def apply_action(args, device):
    image = Image.open(args.input)
    mask = Image.open(args.mask).convert("L")
    if mask.size != image.size:
        raise RuntimeError("mask dimensions do not match input")
    if args.action == "keep-selected":
        rgba = image.convert("RGBA")
        original_alpha = np.array(rgba.getchannel("A"), dtype=np.uint16)
        selected = np.array(mask, dtype=np.uint16)
        alpha = ((original_alpha * selected) // 255).astype(np.uint8)
        rgba.putalpha(Image.fromarray(alpha, mode="L"))
        save_image(rgba, args.output, args.format)
    elif args.action == "make-selected-transparent":
        rgba = image.convert("RGBA")
        original_alpha = np.array(rgba.getchannel("A"), dtype=np.uint16)
        selected = np.array(mask, dtype=np.uint16)
        alpha = ((original_alpha * (255 - selected)) // 255).astype(np.uint8)
        rgba.putalpha(Image.fromarray(alpha, mode="L"))
        save_image(rgba, args.output, args.format)
    elif args.action == "remove-and-fill":
        # LaMa receives a binary mask; use the feathered mask only as a wider edge hint.
        binary = mask.point(lambda value: 255 if value > 12 else 0, mode="L")
        result = lama_inpaint(image, binary, args.lama_model, device)
        save_image(result, args.output, args.format)
    else:
        raise RuntimeError(f"unsupported action: {args.action}")


def run_with_cpu_fallback(fn):
    torch = ensure_torch()
    device = sam_device()
    try:
        return fn(device)
    except Exception:
        if device.type == "mps" and os.environ.get("AGENT2D_OBJECT_DEVICE", "auto").lower() == "auto":
            try:
                if hasattr(torch.mps, "empty_cache"):
                    torch.mps.empty_cache()
            except Exception:
                pass
            return fn(torch.device("cpu"))
        raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--prepare", action="store_true")
    parser.add_argument("--worker", action="store_true")
    parser.add_argument("--mode", choices=["mask", "apply"])
    parser.add_argument("--input")
    parser.add_argument("--mask")
    parser.add_argument("--mask-output")
    parser.add_argument("--output")
    parser.add_argument("--points")
    parser.add_argument("--labels")
    parser.add_argument("--box")
    parser.add_argument("--expand", type=int, default=0)
    parser.add_argument("--feather", type=float, default=0.0)
    parser.add_argument("--action", choices=["keep-selected", "make-selected-transparent", "remove-and-fill"])
    parser.add_argument("--format", choices=["png", "webp", "jpeg"], default="png")
    parser.add_argument("--lama-model", required=True)
    args = parser.parse_args()

    if args.prepare:
        prepare(args.lama_model)
        return
    if args.worker:
        serve_worker()
        return
    if not args.mode or not args.input:
        parser.error("--mode and --input are required")
    if args.mode == "mask":
        if not args.mask_output:
            parser.error("--mask-output is required for mask mode")
        run_with_cpu_fallback(lambda device: run_mask(args, device))
    else:
        if not args.mask or not args.output or not args.action:
            parser.error("--mask, --output and --action are required for apply mode")
        # Prefer Apple MPS for LaMa on supported Macs; fall back to CPU if the model/operator path fails.
        torch = ensure_torch()
        requested = os.environ.get("AGENT2D_LAMA_DEVICE", "auto").lower()
        if requested not in ("auto", "mps", "cpu"):
            raise RuntimeError("AGENT2D_LAMA_DEVICE must be auto, mps, or cpu")
        mps_available = hasattr(torch.backends, "mps") and torch.backends.mps.is_available()
        device = torch.device("mps") if requested != "cpu" and mps_available else torch.device("cpu")
        try:
            apply_action(args, device)
        except Exception:
            if device.type == "mps":
                try:
                    if hasattr(torch.mps, "empty_cache"):
                        torch.mps.empty_cache()
                except Exception:
                    pass
                apply_action(args, torch.device("cpu"))
            else:
                raise


if __name__ == "__main__":
    main()
"#;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectEditRuntimeStatus {
    pub installed: bool,
    pub managed: bool,
    pub release_id: String,
    pub root: PathBuf,
    pub python_path: PathBuf,
    pub runner_path: PathBuf,
    pub model_cache_dir: PathBuf,
    pub lama_model_path: PathBuf,
    pub sam_model_id: String,
    pub sam_model_revision: String,
    pub lama_model_url: String,
    pub shared_python_runtime: bool,
}

#[derive(Debug, Clone)]
struct ObjectRuntimePaths {
    root: PathBuf,
    python: PathBuf,
    runner: PathBuf,
    model_cache_dir: PathBuf,
    lama_model: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MaskRunnerOutput {
    score: f64,
    width: u32,
    height: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerMaskResponse {
    ok: bool,
    score: Option<f64>,
    width: Option<u32>,
    height: Option<u32>,
    error: Option<String>,
}

struct SamWorker {
    root: PathBuf,
    child: Child,
    stdin: BufWriter<ChildStdin>,
    stdout: BufReader<ChildStdout>,
}

impl Drop for SamWorker {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

static SAM_WORKER: OnceLock<Mutex<Option<SamWorker>>> = OnceLock::new();

pub fn object_edit_runtime_status() -> Result<ObjectEditRuntimeStatus, Agent2DError> {
    let background = background_runtime_status()?;
    let root = if let Some(root) = env::var_os("AGENT2D_OBJECT_RUNTIME_ROOT") {
        PathBuf::from(root)
    } else {
        managed_object_runtime_root()?
    };
    let paths = object_runtime_paths(root, background.python_path);
    Ok(status_from_paths(&paths, background.installed))
}

pub fn install_object_edit_runtime() -> Result<ObjectEditRuntimeStatus, Agent2DError> {
    let background = if background_runtime_status()?.installed {
        background_runtime_status()?
    } else {
        install_background_runtime()?
    };
    let root = managed_object_runtime_root()?;
    fs::create_dir_all(&root).map_err(|error| install_error(error.to_string()))?;
    let paths = object_runtime_paths(root.clone(), background.python_path);
    fs::create_dir_all(&paths.model_cache_dir).map_err(|error| install_error(error.to_string()))?;
    fs::write(&paths.runner, RUNNER_SCRIPT).map_err(|error| install_error(error.to_string()))?;

    let hf_home = paths.model_cache_dir.to_string_lossy().into_owned();
    let lama_model = paths.lama_model.to_string_lossy().into_owned();
    let output = Command::new(&paths.python)
        .arg(&paths.runner)
        .arg("--prepare")
        .args(["--lama-model", &lama_model])
        .env("HF_HOME", &hf_home)
        .env("HF_HUB_DISABLE_TELEMETRY", "1")
        .env("TOKENIZERS_PARALLELISM", "false")
        .output()
        .map_err(|error| install_error(format!("failed to start object runtime prepare: {error}")))?;
    if !output.status.success() {
        return Err(install_error(format!(
            "object runtime prepare failed: {}{}",
            tail_chars(&String::from_utf8_lossy(&output.stderr), 4000),
            tail_chars(&String::from_utf8_lossy(&output.stdout), 1000)
        )));
    }
    fs::write(root.join("SOURCE.txt"), runtime_notice())
        .map_err(|error| install_error(error.to_string()))?;
    fs::write(root.join(READY_NAME), String::from_utf8_lossy(&output.stdout).trim())
        .map_err(|error| install_error(error.to_string()))?;

    let installed = object_edit_runtime_status()?;
    if !installed.installed {
        return Err(install_error("object edit runtime verification failed after installation"));
    }
    Ok(installed)
}

pub fn warm_object_edit_runtime() -> Result<(), Agent2DError> {
    let runtime = discover_object_runtime()?;
    let mutex = SAM_WORKER.get_or_init(|| Mutex::new(None));
    let mut guard = mutex.lock().map_err(|_| backend_error("SAM worker mutex poisoned"))?;
    ensure_sam_worker(&runtime, &mut guard)?;
    Ok(())
}

pub fn segment_object_mask(request: &ObjectSelectionRequest) -> Result<ObjectSelectionResult, Agent2DError> {
    segment_object_mask_with_cancel(request, &CancellationToken::new())
}

pub fn segment_object_mask_with_cancel(
    request: &ObjectSelectionRequest,
    cancellation: &CancellationToken,
) -> Result<ObjectSelectionResult, Agent2DError> {
    validate_selection(&request.selection)?;
    validate_output_path(&request.input_path, &request.output_mask_path)?;
    let started = Instant::now();
    let input = inspect_image(&InspectRequest { input_path: request.input_path.clone() })?;
    validate_selection_bounds(&request.selection, input.width, input.height)?;
    let runtime = discover_object_runtime()?;
    let temp = tempdir().map_err(|error| Agent2DError::ImageWrite {
        path: "temporary_directory".into(),
        message: error.to_string(),
    })?;
    let prepared_input = prepare_input(&request.input_path, &input.format, temp.path(), cancellation)?;

    let points = request.selection.points.iter().map(|point| vec![point.x, point.y]).collect::<Vec<_>>();
    let labels = request.selection.points.iter().map(|point| match point.label {
        ObjectPointLabel::Include => 1_i32,
        ObjectPointLabel::Exclude => 0_i32,
    }).collect::<Vec<_>>();
    let box_prompt = request.selection.box_prompt.as_ref().map(|value| vec![value.x1, value.y1, value.x2, value.y2]);
    let meta = request_sam_worker(
        &runtime,
        &prepared_input,
        &request.output_mask_path,
        &points,
        &labels,
        &box_prompt,
        request.selection.expand_px,
        request.selection.feather_px,
    )?;
    if cancellation.is_cancelled() {
        cleanup_output(&request.output_mask_path);
        return Err(Agent2DError::Cancelled);
    }
    if (meta.width, meta.height) != (input.width, input.height) {
        cleanup_output(&request.output_mask_path);
        return Err(Agent2DError::ProbeFailed {
            message: format!("object mask dimensions expected {}x{}, got {}x{}", input.width, input.height, meta.width, meta.height),
        });
    }
    if !request.output_mask_path.is_file() {
        return Err(Agent2DError::ProbeFailed { message: "SAM2 runner did not produce a mask file".into() });
    }
    Ok(ObjectSelectionResult {
        job_id: Uuid::new_v4().to_string(),
        input_path: request.input_path.clone(),
        output_mask_path: request.output_mask_path.clone(),
        width: meta.width,
        height: meta.height,
        score: meta.score,
        model_id: OBJECT_SAM_MODEL_ID.into(),
        elapsed_ms: started.elapsed().as_millis() as u64,
        warnings: vec!["sam2.1_base_plus_object_mask".into()],
    })
}

pub fn edit_object(request: &ObjectEditRequest) -> Result<Agent2DResult, Agent2DError> {
    edit_object_with_cancel(request, &CancellationToken::new())
}

pub fn edit_object_with_cancel(
    request: &ObjectEditRequest,
    cancellation: &CancellationToken,
) -> Result<Agent2DResult, Agent2DError> {
    validate_selection(&request.selection)?;
    validate_action_format(request.action, request.format)?;
    validate_output_path(&request.input_path, &request.output_path)?;
    let started = Instant::now();
    let input = inspect_image(&InspectRequest { input_path: request.input_path.clone() })?;
    validate_selection_bounds(&request.selection, input.width, input.height)?;
    let runtime = discover_object_runtime()?;
    let temp = tempdir().map_err(|error| Agent2DError::ImageWrite {
        path: "temporary_directory".into(),
        message: error.to_string(),
    })?;
    let mask_path = temp.path().join("object-mask.png");
    let selection_result = segment_object_mask_with_cancel(
        &ObjectSelectionRequest {
            input_path: request.input_path.clone(),
            output_mask_path: mask_path.clone(),
            selection: request.selection.clone(),
        },
        cancellation,
    )?;
    let prepared_input = prepare_input(&request.input_path, &input.format, temp.path(), cancellation)?;
    let action = match request.action {
        ObjectEditAction::KeepSelected => "keep-selected",
        ObjectEditAction::MakeSelectedTransparent => "make-selected-transparent",
        ObjectEditAction::RemoveAndFill => "remove-and-fill",
    };
    let format = match request.format {
        OutputFormat::Png => "png",
        OutputFormat::Webp => "webp",
        OutputFormat::Jpeg => "jpeg",
        other => return Err(Agent2DError::UnsupportedCompression { mode: "object-edit".into(), format: format!("{other:?}") }),
    };
    let mut command = base_runner_command(&runtime);
    command
        .args(["--mode", "apply", "--input"])
        .arg(&prepared_input)
        .args(["--mask"])
        .arg(&mask_path)
        .args(["--output"])
        .arg(&request.output_path)
        .args(["--action", action, "--format", format]);
    run_child(command, cancellation, Some(&request.output_path))?;
    let output = inspect_image(&InspectRequest { input_path: request.output_path.clone() })?;
    if (output.width, output.height) != (input.width, input.height) {
        cleanup_output(&request.output_path);
        return Err(Agent2DError::ProbeFailed {
            message: format!("object edit dimensions expected {}x{}, got {}x{}", input.width, input.height, output.width, output.height),
        });
    }
    if matches!(request.action, ObjectEditAction::KeepSelected | ObjectEditAction::MakeSelectedTransparent) && !output.has_alpha {
        cleanup_output(&request.output_path);
        return Err(Agent2DError::ProbeFailed { message: "transparent object edit output does not contain alpha".into() });
    }
    let model_id = match request.action {
        ObjectEditAction::RemoveAndFill => format!("{OBJECT_SAM_MODEL_ID}+LaMa"),
        _ => OBJECT_SAM_MODEL_ID.into(),
    };
    Ok(Agent2DResult {
        job_id: Uuid::new_v4().to_string(),
        input_path: request.input_path.clone(),
        output_path: request.output_path.clone(),
        input_width: input.width,
        input_height: input.height,
        output_width: output.width,
        output_height: output.height,
        input_bytes: input.input_bytes,
        output_bytes: output.input_bytes,
        compression_ratio: if output.input_bytes == 0 { 0.0 } else { input.input_bytes as f64 / output.input_bytes as f64 },
        model_id: Some(model_id),
        codec: Some(format!("object-edit-{action}-{format}")),
        pixel_exact: Some(false),
        elapsed_ms: started.elapsed().as_millis() as u64,
        warnings: vec![
            format!("sam_score_{:.4}", selection_result.score),
            "object_edit_prompt_mask".into(),
            if request.action == ObjectEditAction::RemoveAndFill { "lama_inpaint".into() } else { "alpha_edit".into() },
        ],
    })
}

fn prepare_input(
    input: &Path,
    format: &str,
    temp: &Path,
    cancellation: &CancellationToken,
) -> Result<PathBuf, Agent2DError> {
    if matches!(format, "png" | "jpeg" | "jpg" | "webp") {
        return Ok(input.to_path_buf());
    }
    let path = temp.join("object-edit-input.png");
    run_transform_to_png(input, &path, "null", cancellation)?;
    Ok(path)
}

fn validate_selection(selection: &ObjectSelection) -> Result<(), Agent2DError> {
    if selection.points.is_empty() && selection.box_prompt.is_none() {
        return Err(selection_error("at least one include/exclude point or a box prompt is required"));
    }
    if !(-64..=64).contains(&selection.expand_px) {
        return Err(selection_error("expandPx must be between -64 and 64"));
    }
    if !selection.feather_px.is_finite() || !(0.0..=32.0).contains(&selection.feather_px) {
        return Err(selection_error("featherPx must be between 0 and 32"));
    }
    Ok(())
}

fn validate_selection_bounds(selection: &ObjectSelection, width: u32, height: u32) -> Result<(), Agent2DError> {
    let max_x = width.saturating_sub(1) as f64;
    let max_y = height.saturating_sub(1) as f64;
    for point in &selection.points {
        if !point.x.is_finite() || !point.y.is_finite() || point.x < 0.0 || point.y < 0.0 || point.x > max_x || point.y > max_y {
            return Err(selection_error(format!("point ({}, {}) is outside {}x{} image bounds", point.x, point.y, width, height)));
        }
    }
    if let Some(value) = &selection.box_prompt {
        let values = [value.x1, value.y1, value.x2, value.y2];
        if values.iter().any(|value| !value.is_finite())
            || value.x1 < 0.0 || value.y1 < 0.0 || value.x2 > width as f64 || value.y2 > height as f64
            || value.x2 <= value.x1 || value.y2 <= value.y1
        {
            return Err(selection_error("box prompt must be an ordered rectangle inside image bounds"));
        }
    }
    Ok(())
}

fn validate_action_format(action: ObjectEditAction, format: OutputFormat) -> Result<(), Agent2DError> {
    match action {
        ObjectEditAction::KeepSelected | ObjectEditAction::MakeSelectedTransparent
            if !matches!(format, OutputFormat::Png | OutputFormat::Webp) =>
        {
            Err(Agent2DError::UnsupportedCompression {
                mode: "object-edit-alpha".into(),
                format: format!("{format:?}"),
            })
        }
        ObjectEditAction::RemoveAndFill
            if !matches!(format, OutputFormat::Png | OutputFormat::Webp | OutputFormat::Jpeg) =>
        {
            Err(Agent2DError::UnsupportedCompression {
                mode: "object-edit-inpaint".into(),
                format: format!("{format:?}"),
            })
        }
        _ => Ok(()),
    }
}

fn ensure_sam_worker(
    runtime: &ObjectRuntimePaths,
    slot: &mut Option<SamWorker>,
) -> Result<(), Agent2DError> {
    let needs_restart = match slot.as_mut() {
        Some(worker) if worker.root == runtime.root => match worker.child.try_wait() {
            Ok(None) => false,
            Ok(Some(_)) => true,
            Err(_) => true,
        },
        Some(_) => true,
        None => true,
    };
    if needs_restart {
        *slot = None;
        *slot = Some(spawn_sam_worker(runtime)?);
    }
    Ok(())
}

fn spawn_sam_worker(runtime: &ObjectRuntimePaths) -> Result<SamWorker, Agent2DError> {
    let stderr_path = runtime.root.join("sam-worker.stderr.log");
    let stderr = File::create(&stderr_path).map_err(|error| backend_error(error.to_string()))?;
    let mut command = base_runner_command(runtime);
    command
        .arg("--worker")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::from(stderr));
    let mut child = command.spawn().map_err(|error| Agent2DError::BackendUnavailable {
        backend: format!("SAM2 persistent worker: {error}"),
    })?;
    let stdin = child.stdin.take().ok_or_else(|| backend_error("SAM worker stdin unavailable"))?;
    let stdout = child.stdout.take().ok_or_else(|| backend_error("SAM worker stdout unavailable"))?;
    let mut stdout = BufReader::new(stdout);
    let mut ready = String::new();
    let bytes = stdout.read_line(&mut ready).map_err(|error| backend_error(format!("SAM worker startup read failed: {error}")))?;
    if bytes == 0 {
        let _ = child.wait();
        let stderr = fs::read_to_string(&stderr_path).unwrap_or_default();
        return Err(backend_error(format!("SAM worker exited before ready: {}", tail_chars(&stderr, 4000))));
    }
    let value: serde_json::Value = serde_json::from_str(ready.trim())
        .map_err(|error| backend_error(format!("invalid SAM worker ready response: {error}: {}", ready.trim())))?;
    if value.get("ready").and_then(|value| value.as_bool()) != Some(true) {
        return Err(backend_error(format!("SAM worker did not report ready: {}", ready.trim())));
    }
    Ok(SamWorker {
        root: runtime.root.clone(),
        child,
        stdin: BufWriter::new(stdin),
        stdout,
    })
}

fn request_sam_worker(
    runtime: &ObjectRuntimePaths,
    input_path: &Path,
    output_mask_path: &Path,
    points: &[Vec<f64>],
    labels: &[i32],
    box_prompt: &Option<Vec<f64>>,
    expand_px: i32,
    feather_px: f64,
) -> Result<MaskRunnerOutput, Agent2DError> {
    let payload = serde_json::json!({
        "input": input_path,
        "maskOutput": output_mask_path,
        "points": points,
        "labels": labels,
        "box": box_prompt,
        "expand": expand_px,
        "feather": feather_px,
    });
    let mutex = SAM_WORKER.get_or_init(|| Mutex::new(None));
    let mut guard = mutex.lock().map_err(|_| backend_error("SAM worker mutex poisoned"))?;

    for attempt in 0..2 {
        ensure_sam_worker(runtime, &mut guard)?;
        let worker = guard.as_mut().expect("worker initialized");
        let request_result = (|| -> Result<MaskRunnerOutput, Agent2DError> {
            serde_json::to_writer(&mut worker.stdin, &payload)
                .map_err(|error| backend_error(format!("SAM worker request serialize failed: {error}")))?;
            worker.stdin.write_all(b"\n").map_err(|error| backend_error(format!("SAM worker request write failed: {error}")))?;
            worker.stdin.flush().map_err(|error| backend_error(format!("SAM worker request flush failed: {error}")))?;
            let mut line = String::new();
            let bytes = worker.stdout.read_line(&mut line)
                .map_err(|error| backend_error(format!("SAM worker response read failed: {error}")))?;
            if bytes == 0 {
                return Err(backend_error("SAM worker closed stdout before responding"));
            }
            let response: WorkerMaskResponse = serde_json::from_str(line.trim())
                .map_err(|error| backend_error(format!("invalid SAM worker response: {error}: {}", tail_chars(&line, 1000))))?;
            if !response.ok {
                return Err(backend_error(response.error.unwrap_or_else(|| "SAM worker failed without an error message".into())));
            }
            Ok(MaskRunnerOutput {
                score: response.score.ok_or_else(|| backend_error("SAM worker response missing score"))?,
                width: response.width.ok_or_else(|| backend_error("SAM worker response missing width"))?,
                height: response.height.ok_or_else(|| backend_error("SAM worker response missing height"))?,
            })
        })();
        match request_result {
            Ok(value) => return Ok(value),
            Err(error) if attempt == 0 => {
                *guard = None;
                if output_mask_path.exists() {
                    cleanup_output(output_mask_path);
                }
                let _ = error;
            }
            Err(error) => return Err(error),
        }
    }
    Err(backend_error("SAM worker retry exhausted"))
}

fn base_runner_command(runtime: &ObjectRuntimePaths) -> Command {
    let mut command = Command::new(&runtime.python);
    command
        .arg(&runtime.runner)
        .args(["--lama-model"])
        .arg(&runtime.lama_model)
        .env("HF_HOME", &runtime.model_cache_dir)
        .env("HF_HUB_OFFLINE", "1")
        .env("TRANSFORMERS_OFFLINE", "1")
        .env("HF_HUB_DISABLE_TELEMETRY", "1")
        .env("PYTORCH_ENABLE_MPS_FALLBACK", "1")
        .env("TOKENIZERS_PARALLELISM", "false");
    command
}

fn run_child(
    mut command: Command,
    cancellation: &CancellationToken,
    cleanup: Option<&Path>,
) -> Result<String, Agent2DError> {
    let temp = tempdir().map_err(|error| backend_error(error.to_string()))?;
    let stderr_path = temp.path().join("object-edit.stderr.log");
    let stdout_path = temp.path().join("object-edit.stdout.log");
    let stderr = File::create(&stderr_path).map_err(|error| backend_error(error.to_string()))?;
    let stdout = File::create(&stdout_path).map_err(|error| backend_error(error.to_string()))?;
    let mut child = command
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        .spawn()
        .map_err(|error| Agent2DError::BackendUnavailable { backend: format!("Object Edit Python runtime: {error}") })?;
    loop {
        if cancellation.is_cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            if let Some(path) = cleanup { cleanup_output(path); }
            return Err(Agent2DError::Cancelled);
        }
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) => {
                if let Some(path) = cleanup { cleanup_output(path); }
                let stderr = fs::read_to_string(&stderr_path).unwrap_or_default();
                let stdout = fs::read_to_string(&stdout_path).unwrap_or_default();
                return Err(backend_error(format!("{}{}", tail_chars(&stderr, 4000), tail_chars(&stdout, 1000))));
            }
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(error) => {
                if let Some(path) = cleanup { cleanup_output(path); }
                return Err(backend_error(error.to_string()));
            }
        }
    }
    if cancellation.is_cancelled() {
        if let Some(path) = cleanup { cleanup_output(path); }
        return Err(Agent2DError::Cancelled);
    }
    fs::read_to_string(stdout_path).map_err(|error| backend_error(error.to_string()))
}

fn discover_object_runtime() -> Result<ObjectRuntimePaths, Agent2DError> {
    let status = object_edit_runtime_status()?;
    if !status.installed {
        return Err(Agent2DError::BackendUnavailable {
            backend: format!(
                "Object Edit runtime is not installed at {}. Install it from the Desktop Object Edit tab or run `agent2d object-runtime-install`.",
                status.root.to_string_lossy()
            ),
        });
    }
    Ok(ObjectRuntimePaths {
        root: status.root,
        python: status.python_path,
        runner: status.runner_path,
        model_cache_dir: status.model_cache_dir,
        lama_model: status.lama_model_path,
    })
}

fn managed_object_runtime_root() -> Result<PathBuf, Agent2DError> {
    if let Some(root) = env::var_os("AGENT2D_RUNTIME_ROOT") {
        return Ok(PathBuf::from(root).join(OBJECT_RUNTIME_RELEASE_ID));
    }
    let home = env::var_os("HOME").ok_or_else(|| Agent2DError::BackendUnavailable {
        backend: "HOME is unavailable; cannot resolve Object Edit runtime directory".into(),
    })?;
    Ok(PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join("Agent-2D")
        .join("runtime")
        .join(OBJECT_RUNTIME_RELEASE_ID))
}

fn object_runtime_paths(root: PathBuf, python: PathBuf) -> ObjectRuntimePaths {
    ObjectRuntimePaths {
        python,
        runner: root.join(RUNNER_NAME),
        model_cache_dir: root.join("hf"),
        lama_model: root.join(LAMA_NAME),
        root,
    }
}

fn status_from_paths(paths: &ObjectRuntimePaths, background_installed: bool) -> ObjectEditRuntimeStatus {
    ObjectEditRuntimeStatus {
        installed: background_installed
            && paths.python.is_file()
            && paths.runner.is_file()
            && paths.model_cache_dir.is_dir()
            && paths.lama_model.is_file()
            && paths.root.join(READY_NAME).is_file(),
        managed: true,
        release_id: OBJECT_RUNTIME_RELEASE_ID.into(),
        root: paths.root.clone(),
        python_path: paths.python.clone(),
        runner_path: paths.runner.clone(),
        model_cache_dir: paths.model_cache_dir.clone(),
        lama_model_path: paths.lama_model.clone(),
        sam_model_id: OBJECT_SAM_MODEL_ID.into(),
        sam_model_revision: OBJECT_SAM_MODEL_REVISION.into(),
        lama_model_url: OBJECT_LAMA_MODEL_URL.into(),
        shared_python_runtime: background_installed,
    }
}

fn runtime_notice() -> String {
    format!(
        "Agent-2D managed Object Edit runtime\n\nSAM model: {OBJECT_SAM_MODEL_ID}\nSAM revision: {OBJECT_SAM_MODEL_REVISION}\nSAM license: Apache-2.0\nLaMa model source: {OBJECT_LAMA_MODEL_URL}\nLaMa/simple-lama-inpainting license: Apache-2.0\n\nThe Object Edit runtime reuses the FeyNoBg managed Python/PyTorch environment to avoid duplicating PyTorch. Normal inference runs with Hugging Face offline mode enabled.\n"
    )
}

fn selection_error(message: impl Into<String>) -> Agent2DError {
    Agent2DError::UnsupportedCompression { mode: "object-selection".into(), format: message.into() }
}

fn backend_error(message: impl Into<String>) -> Agent2DError {
    Agent2DError::BackendFailed { backend: "sam2_lama_object_edit".into(), message: message.into() }
}

fn install_error(message: impl Into<String>) -> Agent2DError {
    Agent2DError::BackendFailed { backend: "object_edit_runtime_installer".into(), message: message.into() }
}

fn tail_chars(value: &str, max: usize) -> String {
    let count = value.chars().count();
    if count <= max { value.to_owned() } else { value.chars().skip(count - max).collect() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent2d_core::{ObjectBoxPrompt, ObjectPoint};

    #[test]
    fn object_runtime_contract_is_pinned_and_shared() {
        assert_eq!(OBJECT_SAM_MODEL_ID, "facebook/sam2.1-hiera-base-plus");
        assert_eq!(OBJECT_SAM_MODEL_REVISION, "b732075");
        assert!(RUNNER_SCRIPT.contains("Sam2Model"));
        assert!(RUNNER_SCRIPT.contains("remove-and-fill"));
        assert!(RUNNER_SCRIPT.contains("torch.jit.load"));
    }

    #[test]
    fn selection_requires_a_prompt_and_bounds_adjustments() {
        let empty = ObjectSelection { points: vec![], box_prompt: None, expand_px: 0, feather_px: 0.0 };
        assert!(validate_selection(&empty).is_err());
        let valid = ObjectSelection {
            points: vec![ObjectPoint { x: 10.0, y: 8.0, label: ObjectPointLabel::Include }],
            box_prompt: Some(ObjectBoxPrompt { x1: 1.0, y1: 1.0, x2: 20.0, y2: 18.0 }),
            expand_px: 4,
            feather_px: 1.5,
        };
        assert!(validate_selection(&valid).is_ok());
        assert!(validate_selection_bounds(&valid, 32, 24).is_ok());
    }

    #[test]
    fn alpha_actions_reject_non_alpha_output_formats() {
        assert!(validate_action_format(ObjectEditAction::KeepSelected, OutputFormat::Jpeg).is_err());
        assert!(validate_action_format(ObjectEditAction::MakeSelectedTransparent, OutputFormat::Png).is_ok());
        assert!(validate_action_format(ObjectEditAction::RemoveAndFill, OutputFormat::Jpeg).is_ok());
    }
}
