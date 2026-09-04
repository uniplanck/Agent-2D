import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  Agent2DResult,
  CompressionMode,
  DesktopJobRequest,
  DesktopJobStatus,
  ErrorPayload,
  InspectResult,
  Operation,
  OutputFormat,
  SrCapabilities,
  SrMode,
} from "./types";
import "./styles.css";

const POLL_MS = 180;
const SUPPORTED_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "avif", "jxl"]);

type QueueState = "pending" | "running" | "completed" | "failed" | "cancelled";
interface QueueEntry {
  path: string;
  state: QueueState;
}

interface SavedSizePreset {
  id: string;
  name: string;
  width: number;
  height: number;
}

interface FormatComparisonOutput {
  format: OutputFormat;
  result: Agent2DResult;
  preview: string;
}

const CUSTOM_SIZE_STORAGE_KEY = "agent2d.custom-size-presets.v1";
const OUTPUT_FORMATS: Array<{ id: OutputFormat; label: string; detail: string }> = [
  { id: "png", label: "PNG", detail: "Exact" },
  { id: "jpeg", label: "JPG", detail: "High Quality" },
  { id: "webp", label: "WebP", detail: "Lossless / Compact" },
  { id: "avif", label: "AVIF", detail: "Preserve / Compact" },
  { id: "jxl", label: "JXL", detail: "Lossless / Compact" },
];

function loadSavedSizePresets(): SavedSizePreset[] {
  try {
    const raw = window.localStorage.getItem(CUSTOM_SIZE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is SavedSizePreset => {
      if (!entry || typeof entry !== "object") return false;
      const candidate = entry as Partial<SavedSizePreset>;
      return typeof candidate.id === "string"
        && typeof candidate.name === "string"
        && typeof candidate.width === "number"
        && typeof candidate.height === "number"
        && candidate.width > 0
        && candidate.height > 0;
    }).slice(0, 40);
  } catch {
    return [];
  }
}

function targetBytesFrom(value: number, unit: "KB" | "MB"): number {
  const multiplier = unit === "MB" ? 1024 * 1024 : 1024;
  return Math.max(1, Math.round(value * multiplier));
}

function formatQualityText(format: OutputFormat): string {
  if (format === "png") return "PNG Exact";
  if (format === "jpeg") return "JPEG High Quality";
  if (format === "webp") return "WebP Lossless";
  if (format === "avif") return "AVIF Preserve";
  return "JXL Lossless";
}

const MODE_HELP: Record<SrMode, { title: string; body: string; use: string }> = {
  fidelity: {
    title: "Fidelity",
    body: "原画像への忠実さを優先するrouting intentです。現行Real-ESRGANではModelを固定するとMode差は小さくなります。",
    use: "写真・文字入り画像・過剰な質感追加を避けたいとき。",
  },
  balanced: {
    title: "Balanced · 推奨",
    body: "品質と自然さの中間を狙う標準routing intentです。迷った場合の初期値です。",
    use: "一般写真、Web画像、AI画像など用途が混在するとき。",
  },
  perceptual: {
    title: "Perceptual",
    body: "見た目のディテール感を優先するためのrouting intentです。現行モデル群ではModel選択の影響の方が大きいです。",
    use: "小さく柔らかい画像や、多少の推定ディテールを許容できるとき。",
  },
};

function modelHelp(modelId: string): { title: string; body: string; use: string } {
  if (!modelId) {
    return {
      title: "Auto route · 推奨",
      body: "Modeと内蔵routing規則から利用可能なReal-ESRGANモデルを選びます。現在は保守的なroutingです。",
      use: "モデル差を意識せず使いたいとき。まずはAuto + Balancedが基準です。",
    };
  }
  if (modelId.includes("x4plus-anime")) {
    return {
      title: "realesrgan-x4plus-anime",
      body: "アニメ・イラスト・輪郭線を持つ画像向けの公式Real-ESRGANモデルです。",
      use: "アニメ絵、マンガ調、イラスト、線画主体の画像。",
    };
  }
  if (modelId.includes("animevideov3")) {
    return {
      title: "realesr-animevideov3",
      body: "アニメ映像系を想定した軽量寄りの公式モデルです。静止画にも利用できます。",
      use: "アニメ系で処理負荷を抑えたい場合や、連続フレーム由来の画像。",
    };
  }
  return {
    title: modelId,
    body: "一般画像向けのReal-ESRGAN x4plus系モデルです。写真と混在コンテンツで基準になります。",
    use: "写真、Web素材、一般画像。迷って手動固定するならこの系統。",
  };
}

function InfoHint({ title, children }: { title: string; children: ReactNode }) {
  const [openState, setOpenState] = useState(false);
  const [position, setPosition] = useState({ left: 12, top: 12, width: 380 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const popoverId = useMemo(() => `info-${title.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()}`, [title]);

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current != null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => setOpenState(false), 140);
  }, [cancelClose]);

  const place = useCallback(() => {
    const button = buttonRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const width = Math.min(400, Math.max(300, window.innerWidth - 24));
    const height = popoverRef.current?.offsetHeight ?? 280;
    const left = Math.min(Math.max(12, rect.left - 18), Math.max(12, window.innerWidth - width - 12));
    const below = rect.bottom + 10;
    const top = below + height <= window.innerHeight - 12
      ? below
      : Math.max(12, rect.top - height - 10);
    setPosition({ left, top, width });
  }, []);

  useEffect(() => {
    if (!openState) return;
    place();
    const frame = window.requestAnimationFrame(place);
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!buttonRef.current?.contains(target) && !popoverRef.current?.contains(target)) {
        setOpenState(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenState(false);
        buttonRef.current?.focus();
      }
    };
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [openState, place]);

  useEffect(() => () => cancelClose(), [cancelClose]);

  return (
    <span className="info-hint" onMouseEnter={() => { cancelClose(); setOpenState(true); }} onMouseLeave={scheduleClose}>
      <button
        ref={buttonRef}
        type="button"
        className="info-button"
        aria-label={`${title}の説明`}
        aria-expanded={openState}
        aria-controls={popoverId}
        onClick={() => setOpenState((value) => !value)}
        onFocus={() => setOpenState(true)}
      >?</button>
      {openState && createPortal(
        <div
          ref={popoverRef}
          id={popoverId}
          className="info-popover"
          role="dialog"
          aria-label={title}
          style={{ left: position.left, top: position.top, width: position.width }}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          <strong>{title}</strong>
          {children}
        </div>,
        document.body,
      )}
    </span>
  );
}

function bytes(value?: number | null): string {
  if (value == null) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(2)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

function outputFor(input: string, operation: Operation, format: OutputFormat, batch = false): string {
  if (!input) return "";
  const slash = input.lastIndexOf("/");
  const dir = slash >= 0 ? input.slice(0, slash + 1) : "";
  const file = slash >= 0 ? input.slice(slash + 1) : input;
  const dot = file.lastIndexOf(".");
  const stem = dot > 0 ? file.slice(0, dot) : file;
  const sourceExt = dot > 0 ? file.slice(dot + 1).toLowerCase() : "image";
  const sourceTag = batch ? `-${sourceExt}` : "";
  const suffix = operation === "enhance"
    ? "enhanced"
    : operation === "compress"
      ? "compressed"
      : operation === "crop"
        ? "custom"
        : operation === "resize"
          ? "resized"
          : "optimized";
  const ext = format === "jpeg" ? "jpg" : format;
  return `${dir}${stem}${sourceTag}-agent2d-${suffix}.${ext}`;
}

function directoryOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash > 0 ? path.slice(0, slash) : "";
}

function outputNameFor(input: string, operation: Operation, format: OutputFormat, batch = false): string {
  return basename(outputFor(input, operation, format, batch));
}

function withExtension(filename: string, format: OutputFormat): string {
  const trimmed = filename.trim();
  const dot = trimmed.lastIndexOf(".");
  const stem = dot > 0 ? trimmed.slice(0, dot) : trimmed;
  const ext = format === "jpeg" ? "jpg" : format;
  return `${stem || "output"}.${ext}`;
}

function outputNameForFormat(filename: string, format: OutputFormat, multiFormat: boolean): string {
  if (!multiFormat) return filename;
  const trimmed = filename.trim();
  const dot = trimmed.lastIndexOf(".");
  const stem = dot > 0 ? trimmed.slice(0, dot) : trimmed;
  const tag = format === "jpeg" ? "jpg" : format;
  return `${stem || "output"}-${tag}`;
}

function estimateDurationMs(info: InspectResult, operation: Operation, scale: 1 | 2 | 4): number {
  const megapixels = Math.max(0.1, (info.width * info.height) / 1_000_000);
  const compressionMs = 650 + megapixels * 520;
  if (operation === "crop" || operation === "resize") return 850 + megapixels * 620;
  if (operation === "compress" || scale === 1) return compressionMs;
  const srMs = scale === 4
    ? 2_800 + megapixels * 12_500
    : 1_900 + megapixels * 7_200;
  return operation === "optimize" ? srMs + compressionMs : srMs;
}

function stageLabel(stage?: string): string {
  switch (stage) {
    case "queued": return "準備中";
    case "super_resolution": return "AI超解像";
    case "super_resolution_then_compression": return "AI超解像 → 圧縮";
    case "compression": return "圧縮 / 変換";
    case "conversion_only": return "解像度維持 / 変換";
    case "compression_conversion_only": return "解像度維持 / 圧縮・変換";
    case "crop_to_size": return "Custom書き出し";
    case "resize_to_size": return "指定サイズへ縮小";
    case "completed": return "完了";
    case "cancelling": return "キャンセル中";
    case "cancelled": return "キャンセル済み";
    case "failed": return "失敗";
    default: return stage || "処理中";
  }
}

function durationText(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}分${String(seconds % 60).padStart(2, "0")}秒`;
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const maybe = error as Partial<ErrorPayload>;
    if (maybe.message) return maybe.message;
  }
  return "Unknown error";
}

function modeLabel(mode: Operation): string {
  if (mode === "enhance") return "Enhance";
  if (mode === "compress") return "Compress";
  if (mode === "crop") return "Custom";
  if (mode === "resize") return "Resize to Size";
  return "Optimize";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function compressionModeFor(format: OutputFormat): CompressionMode {
  return format === "avif" || format === "jpeg" ? "preserve" : "exact";
}

function basename(path: string): string {
  return path.split("/").pop() || path;
}

function isSupportedImage(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot >= 0 && SUPPORTED_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export default function App() {
  const [operation, setOperation] = useState<Operation>("optimize");
  const [inputPath, setInputPath] = useState("");
  const [outputDirectory, setOutputDirectory] = useState("");
  const [outputName, setOutputName] = useState("");
  const [outputPath, setOutputPath] = useState("");
  const [inputInfo, setInputInfo] = useState<InspectResult | null>(null);
  const [inputPreview, setInputPreview] = useState("");
  const [outputPreview, setOutputPreview] = useState("");
  const [result, setResult] = useState<Agent2DResult | null>(null);
  const [outputResults, setOutputResults] = useState<Agent2DResult[]>([]);
  const [comparisonOutputs, setComparisonOutputs] = useState<FormatComparisonOutput[]>([]);
  const [comparisonFormat, setComparisonFormat] = useState<OutputFormat>("png");
  const [scale, setScale] = useState<1 | 2 | 4>(2);
  const [srMode, setSrMode] = useState<SrMode>("balanced");
  const [selectedFormats, setSelectedFormats] = useState<OutputFormat[]>(["png"]);
  const [modelId, setModelId] = useState("");
  const [capabilities, setCapabilities] = useState<SrCapabilities | null>(null);
  const [runtimeChecked, setRuntimeChecked] = useState(false);
  const [installingRuntime, setInstallingRuntime] = useState(false);
  const [job, setJob] = useState<DesktopJobStatus | null>(null);
  const [error, setError] = useState("");
  const [multiMode, setMultiMode] = useState(false);
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [batchRunning, setBatchRunning] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [comparePosition, setComparePosition] = useState(50);
  const [clock, setClock] = useState(() => Date.now());
  const [jobTiming, setJobTiming] = useState<{ startedAt: number; estimatedMs: number } | null>(null);
  const [targetWidth, setTargetWidth] = useState(1024);
  const [targetHeight, setTargetHeight] = useState(1024);
  const [sourceSizeMultiplier, setSourceSizeMultiplier] = useState(1);
  const [cropZoom, setCropZoom] = useState(1);
  const [cropX, setCropX] = useState(0);
  const [cropY, setCropY] = useState(0);
  const [cropFrameSize, setCropFrameSize] = useState({ width: 0, height: 0 });
  const [savedSizePresets, setSavedSizePresets] = useState<SavedSizePreset[]>(loadSavedSizePresets);
  const [presetName, setPresetName] = useState("");
  const [presetMenuOpen, setPresetMenuOpen] = useState(false);
  const [sizeCapEnabled, setSizeCapEnabled] = useState(false);
  const [sizeCapValue, setSizeCapValue] = useState(1);
  const [sizeCapUnit, setSizeCapUnit] = useState<"KB" | "MB">("MB");
  const cancelBatchRef = useRef(false);
  const outputDirectoryPinnedRef = useRef(false);
  const compareStageRef = useRef<HTMLDivElement>(null);
  const cropStageRef = useRef<HTMLDivElement>(null);
  const cropDragRef = useRef<{ pointerId: number; startX: number; startY: number; baseX: number; baseY: number } | null>(null);

  const backendRunning = job?.state === "queued" || job?.state === "running";
  const running = batchRunning || backendRunning;
  const effectiveFormat: OutputFormat = selectedFormats[0] ?? "png";
  const activeComparison = comparisonOutputs.find((entry) => entry.format === comparisonFormat) ?? comparisonOutputs[0] ?? null;
  const displayResult = operation === "crop" ? result : activeComparison?.result ?? result;
  const displayOutputPreview = activeComparison?.preview ?? outputPreview;
  const customTargetBytes = operation === "crop" && sizeCapEnabled
    ? targetBytesFrom(sizeCapValue, sizeCapUnit)
    : null;
  const selectedModeHelp = MODE_HELP[srMode];
  const selectedModelHelp = modelHelp(modelId);

  const loadInput = useCallback(async (path: string) => {
    if (!path) return false;
    setError("");
    setResult(null);
    setOutputResults([]);
    setComparisonOutputs([]);
    setComparisonFormat(effectiveFormat);
    setOutputPreview("");
    try {
      const [info, preview] = await Promise.all([
        invoke<InspectResult>("inspect_image_command", { path }),
        invoke<string>("preview_image_command", { path }),
      ]);
      setInputPath(path);
      setInputInfo(info);
      setInputPreview(preview);
      if (!outputDirectoryPinnedRef.current) setOutputDirectory(directoryOf(path));
      setOutputName(outputNameFor(path, operation, effectiveFormat));
      setOutputPath("");
      setComparePosition(50);
      setSourceSizeMultiplier(1);
      setCropZoom(1);
      setCropX(0);
      setCropY(0);
      return true;
    } catch (cause) {
      setError(errorText(cause));
      return false;
    }
  }, [effectiveFormat, operation]);

  const refreshCapabilities = useCallback(async () => {
    try {
      const next = await invoke<SrCapabilities>("capabilities_command");
      setCapabilities(next);
    } catch {
      setCapabilities(null);
    } finally {
      setRuntimeChecked(true);
    }
  }, []);

  useEffect(() => {
    void refreshCapabilities();
  }, [refreshCapabilities]);

  useEffect(() => {
    try {
      window.localStorage.setItem(CUSTOM_SIZE_STORAGE_KEY, JSON.stringify(savedSizePresets));
    } catch {
      // Persistence failure must not block local image processing.
    }
  }, [savedSizePresets]);

  const installManagedRuntime = async () => {
    if (installingRuntime) return;
    setInstallingRuntime(true);
    setError("");
    try {
      const next = await invoke<SrCapabilities>("install_runtime_command");
      setCapabilities(next);
      setRuntimeChecked(true);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setInstallingRuntime(false);
    }
  };

  const handlePaths = useCallback(async (paths: string[]) => {
    const valid = paths.filter(isSupportedImage);
    if (valid.length === 0) {
      setError("対応画像は PNG / JPEG / WebP / AVIF / JXL です。");
      return;
    }
    if (multiMode) {
      setQueue((current) => {
        const known = new Set(current.map((entry) => entry.path));
        const additions = valid
          .filter((path) => !known.has(path))
          .map((path) => ({ path, state: "pending" as const }));
        return [...current, ...additions];
      });
    }
    await loadInput(valid[0]);
  }, [loadInput, multiMode]);

  useEffect(() => {
    const promise = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "enter" || event.payload.type === "over") {
        setDragActive(true);
      } else if (event.payload.type === "leave") {
        setDragActive(false);
      } else if (event.payload.type === "drop") {
        setDragActive(false);
        void handlePaths(event.payload.paths);
      }
    });
    return () => {
      void promise.then((unlisten) => unlisten());
    };
  }, [handlePaths]);

  useEffect(() => {
    if (inputPath && !running) {
      setOutputName(outputNameFor(inputPath, operation, effectiveFormat));
      setOutputPath("");
      setResult(null);
      setOutputResults([]);
      setComparisonOutputs([]);
      setComparisonFormat(effectiveFormat);
      setOutputPreview("");
      setComparePosition(50);
    }
  }, [effectiveFormat, inputPath, operation, running]);

  useEffect(() => {
    if (operation === "crop" && multiMode && !running) {
      setMultiMode(false);
      setQueue([]);
    }
  }, [multiMode, operation, running]);

  useEffect(() => {
    if (operation !== "crop") return;
    const stage = cropStageRef.current;
    if (!stage) return;
    const update = () => {
      const rect = stage.getBoundingClientRect();
      setCropFrameSize({ width: rect.width, height: rect.height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [inputPreview, operation, targetHeight, targetWidth]);

  useEffect(() => {
    if (!backendRunning) return;
    const timer = window.setInterval(() => setClock(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [backendRunning]);

  const openImage = async () => {
    const selected = await open({
      multiple: multiMode,
      directory: false,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "avif", "jxl"] }],
    });
    const paths = Array.isArray(selected) ? selected : typeof selected === "string" ? [selected] : [];
    if (paths.length > 0) await handlePaths(paths);
  };

  const chooseOutputDirectory = async () => {
    const selected = await open({
      multiple: false,
      directory: true,
      defaultPath: outputDirectory || directoryOf(inputPath) || undefined,
    });
    if (typeof selected === "string") {
      outputDirectoryPinnedRef.current = true;
      setOutputDirectory(selected);
      setOutputPath("");
    }
  };

  const resolveDestination = useCallback(async (filename: string, targetFormat: OutputFormat): Promise<string> => {
    if (!outputDirectory) throw new Error("保存先フォルダを選択してください。");
    return invoke<string>("resolve_output_path_command", {
      directory: outputDirectory,
      filename,
      format: targetFormat,
    });
  }, [outputDirectory]);

  const runOne = useCallback(async (path: string, destination: string, targetFormat: OutputFormat): Promise<DesktopJobStatus | null> => {
    const useCompact = operation === "crop" && customTargetBytes != null;
    const request: DesktopJobRequest = {
      operation,
      inputPath: path,
      outputPath: destination,
      scale,
      srMode,
      compressionMode: useCompact ? "compact" : compressionModeFor(targetFormat),
      format: targetFormat,
      modelId: modelId || null,
      targetWidth: operation === "crop" || operation === "resize" ? targetWidth : null,
      targetHeight: operation === "crop" || operation === "resize" ? targetHeight : null,
      cropZoom: operation === "crop" ? cropZoom : null,
      cropX: operation === "crop" ? cropX : null,
      cropY: operation === "crop" ? cropY : null,
      targetBytes: operation === "crop" ? customTargetBytes : null,
    };
    try {
      const timingInfo = await invoke<InspectResult>("inspect_image_command", { path });
      const startedAt = Date.now();
      setClock(startedAt);
      setJobTiming({ startedAt, estimatedMs: estimateDurationMs(timingInfo, operation, scale) });
      const jobId = await invoke<string>("start_job_command", { request });
      let next: DesktopJobStatus = { jobId, state: "queued", fraction: 0, stage: "queued" };
      setJob(next);
      while (next.state === "queued" || next.state === "running") {
        await delay(POLL_MS);
        next = await invoke<DesktopJobStatus>("job_status_command", { jobId });
        setJob(next);
      }
      if (next.state === "completed") {
        if (next.result) {
          setResult(next.result);
          setOutputResults((current) => [...current, next.result!]);
        }
        if (next.result?.outputPath) {
          let preview = "";
          try {
            preview = await invoke<string>("preview_image_command", { path: next.result.outputPath });
            setOutputPreview(preview);
          } catch {
            setOutputPreview("");
          }
          if (next.result) {
            const comparisonEntry: FormatComparisonOutput = { format: targetFormat, result: next.result, preview };
            setComparisonOutputs((current) => [
              ...current.filter((entry) => entry.format !== targetFormat),
              comparisonEntry,
            ]);
          }
        }
      }
      return next;
    } catch (cause) {
      setJobTiming(null);
      return {
        jobId: "local-error",
        state: "failed",
        fraction: 0,
        stage: "failed",
        error: { code: "desktop_request_error", message: errorText(cause) },
      };
    }
  }, [cropX, cropY, cropZoom, customTargetBytes, modelId, operation, scale, srMode, targetHeight, targetWidth]);

  const start = async () => {
    if (running || selectedFormats.length === 0) return;
    setError("");
    setResult(null);
    setOutputResults([]);
    setComparisonOutputs([]);
    setComparisonFormat(selectedFormats[0] ?? "png");
    setOutputPreview("");

    if (!multiMode) {
      if (!inputPath || !outputDirectory || !outputName.trim()) return;
      const failures: string[] = [];
      for (const targetFormat of selectedFormats) {
        try {
          const destination = await resolveDestination(outputNameForFormat(outputName, targetFormat, selectedFormats.length > 1), targetFormat);
          setOutputPath(destination);
          const terminal = await runOne(inputPath, destination, targetFormat);
          if (terminal?.state === "cancelled") break;
          if (terminal?.state !== "completed") {
            failures.push(`${targetFormat.toUpperCase()}: ${terminal?.error?.message ?? "Processing failed"}`);
          }
        } catch (cause) {
          failures.push(`${targetFormat.toUpperCase()}: ${errorText(cause)}`);
        }
      }
      if (failures.length > 0) setError(failures.join(" / "));
      return;
    }

    const paths = queue.map((entry) => entry.path);
    if (paths.length === 0) return;
    cancelBatchRef.current = false;
    setBatchRunning(true);
    setQueue((current) => current.map((entry) => ({ ...entry, state: "pending" })));
    const failures: string[] = [];

    for (const path of paths) {
      if (cancelBatchRef.current) break;
      setQueue((current) => current.map((entry) => (
        entry.path === path ? { ...entry, state: "running" } : entry
      )));
      const loaded = await loadInput(path);
      if (!loaded) {
        setQueue((current) => current.map((entry) => (
          entry.path === path ? { ...entry, state: "failed" } : entry
        )));
        continue;
      }

      let pathState: QueueState = "completed";
      for (const targetFormat of selectedFormats) {
        if (cancelBatchRef.current) {
          pathState = "cancelled";
          break;
        }
        try {
          const destination = await resolveDestination(outputNameForFormat(outputNameFor(path, operation, targetFormat, true), targetFormat, selectedFormats.length > 1), targetFormat);
          setOutputPath(destination);
          const terminal = await runOne(path, destination, targetFormat);
          if (terminal?.state === "cancelled") {
            pathState = "cancelled";
            break;
          }
          if (terminal?.state !== "completed") {
            pathState = "failed";
            failures.push(`${basename(path)} / ${targetFormat.toUpperCase()}: ${terminal?.error?.message ?? "Processing failed"}`);
          }
        } catch (cause) {
          pathState = "failed";
          failures.push(`${basename(path)} / ${targetFormat.toUpperCase()}: ${errorText(cause)}`);
        }
      }
      setQueue((current) => current.map((entry) => (
        entry.path === path ? { ...entry, state: pathState } : entry
      )));
      if (pathState === "cancelled" || cancelBatchRef.current) break;
    }
    setBatchRunning(false);
    if (failures.length > 0) setError(failures.join(" / "));
  };

  const cancel = async () => {
    cancelBatchRef.current = true;
    if (!job || !backendRunning) {
      setBatchRunning(false);
      return;
    }
    try {
      const next = await invoke<DesktopJobStatus>("cancel_job_command", { jobId: job.jobId });
      setJob(next);
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  const toggleMultiMode = () => {
    if (running) return;
    const next = !multiMode;
    setMultiMode(next);
    if (next) {
      setQueue((current) => {
        if (!inputPath || current.some((entry) => entry.path === inputPath)) return current;
        return [{ path: inputPath, state: "pending" }, ...current];
      });
    } else {
      setQueue([]);
    }
  };

  const removeQueueEntry = (path: string) => {
    if (running) return;
    setQueue((current) => current.filter((entry) => entry.path !== path));
  };

  const savings = useMemo(() => {
    if (!displayResult || displayResult.inputBytes <= 0) return null;
    return (1 - displayResult.outputBytes / displayResult.inputBytes) * 100;
  }, [displayResult]);

  const qualityNote = operation === "crop" && customTargetBytes != null
    ? `最大 ${bytes(customTargetBytes)} を優先して品質を自動調整します。PNGはExactで上限を満たせない場合、曖昧に劣化させず失敗として明示します。`
    : selectedFormats.map(formatQualityText).join(" · ");

  const elapsedMs = jobTiming ? Math.max(0, clock - jobTiming.startedAt) : 0;
  const adaptiveTotalMs = jobTiming
    ? Math.max(jobTiming.estimatedMs, elapsedMs > 0 ? elapsedMs / 0.88 : jobTiming.estimatedMs)
    : 0;
  const estimatedFraction = backendRunning && adaptiveTotalMs > 0
    ? Math.min(0.94, (elapsedMs / adaptiveTotalMs) * 0.92)
    : 0;
  const progressFraction = job?.state === "completed"
    ? 1
    : backendRunning
      ? Math.max(job?.fraction ?? 0, estimatedFraction)
      : job?.fraction ?? 0;
  const etaText = job?.state === "completed" && result
    ? `所要 ${durationText(result.elapsedMs)}`
    : backendRunning && jobTiming
      ? `残り 約${durationText(Math.max(0, adaptiveTotalMs - elapsedMs))}`
      : "";
  const visibleOutputName = outputResults.length > 0
    ? outputResults.map((entry) => basename(entry.outputPath)).join(" · ")
    : selectedFormats.map((targetFormat) => withExtension(outputNameForFormat(outputName, targetFormat, selectedFormats.length > 1), targetFormat)).join(" · ");

  const updateCompareFromClientX = useCallback((clientX: number) => {
    const rect = compareStageRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const position = ((clientX - rect.left) / rect.width) * 100;
    setComparePosition(Math.min(96, Math.max(4, position)));
  }, []);

  const cropImageStyle = useMemo(() => {
    if (!inputInfo || !inputPreview || cropFrameSize.width <= 0 || cropFrameSize.height <= 0) return undefined;
    const baseScale = Math.max(cropFrameSize.width / inputInfo.width, cropFrameSize.height / inputInfo.height);
    const drawWidth = inputInfo.width * baseScale * cropZoom;
    const drawHeight = inputInfo.height * baseScale * cropZoom;
    const overflowX = Math.max(0, drawWidth - cropFrameSize.width);
    const overflowY = Math.max(0, drawHeight - cropFrameSize.height);
    return {
      width: `${drawWidth}px`,
      height: `${drawHeight}px`,
      left: `${(cropFrameSize.width - drawWidth) / 2 - cropX * overflowX / 2}px`,
      top: `${(cropFrameSize.height - drawHeight) / 2 - cropY * overflowY / 2}px`,
    };
  }, [cropFrameSize, cropX, cropY, cropZoom, inputInfo, inputPreview]);

  const adjustCrop = useCallback((deltaX: number, deltaY: number) => {
    setCropX((value) => clamp(value + deltaX, -1, 1));
    setCropY((value) => clamp(value + deltaY, -1, 1));
  }, []);

  const setCropPreset = (width: number, height: number) => {
    setTargetWidth(width);
    setTargetHeight(height);
    setCropZoom(1);
    setCropX(0);
    setCropY(0);
  };

  const maxSourceSizeMultiplier = inputInfo
    ? Math.max(0.1, Math.min(16, 32768 / inputInfo.width, 32768 / inputInfo.height))
    : 16;

  const applySourceSizeMultiplier = useCallback((requestedMultiplier: number) => {
    if (!inputInfo) return;
    const multiplier = clamp(Number.isFinite(requestedMultiplier) ? requestedMultiplier : 1, 0.1, maxSourceSizeMultiplier);
    setSourceSizeMultiplier(Number(multiplier.toFixed(2)));
    setTargetWidth(clamp(Math.round(inputInfo.width * multiplier), 1, 32768));
    setTargetHeight(clamp(Math.round(inputInfo.height * multiplier), 1, 32768));
    setCropZoom(1);
    setCropX(0);
    setCropY(0);
  }, [inputInfo, maxSourceSizeMultiplier]);

  const toggleOutputFormat = (targetFormat: OutputFormat) => {
    if (running) return;
    setSelectedFormats((current) => {
      if (current.includes(targetFormat)) {
        if (current.length === 1) return current;
        return current.filter((item) => item !== targetFormat);
      }
      const chosen = new Set([...current, targetFormat]);
      return OUTPUT_FORMATS.map((item) => item.id).filter((item) => chosen.has(item));
    });
  };

  const saveCurrentPreset = () => {
    const name = presetName.trim() || `${targetWidth}×${targetHeight}`;
    const nextPreset: SavedSizePreset = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      width: targetWidth,
      height: targetHeight,
    };
    setSavedSizePresets((current) => {
      const existing = current.find((item) => item.name.toLocaleLowerCase() === name.toLocaleLowerCase());
      if (existing) {
        return current.map((item) => item.id === existing.id
          ? { ...item, width: targetWidth, height: targetHeight }
          : item);
      }
      return [...current, nextPreset].slice(-40);
    });
    setPresetName("");
  };

  const deleteSavedPreset = (id: string) => {
    setSavedSizePresets((current) => current.filter((item) => item.id !== id));
  };

  const handleCropPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!inputInfo || !inputPreview) return;
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    cropDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      baseX: cropX,
      baseY: cropY,
    };
  };

  const handleCropPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = cropDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !inputInfo) return;
    const baseScale = Math.max(cropFrameSize.width / inputInfo.width, cropFrameSize.height / inputInfo.height);
    const drawWidth = inputInfo.width * baseScale * cropZoom;
    const drawHeight = inputInfo.height * baseScale * cropZoom;
    const overflowX = Math.max(0, drawWidth - cropFrameSize.width);
    const overflowY = Math.max(0, drawHeight - cropFrameSize.height);
    const deltaPixelsX = event.clientX - drag.startX;
    const deltaPixelsY = event.clientY - drag.startY;
    setCropX(overflowX > 0 ? clamp(drag.baseX - (2 * deltaPixelsX) / overflowX, -1, 1) : 0);
    setCropY(overflowY > 0 ? clamp(drag.baseY - (2 * deltaPixelsY) / overflowY, -1, 1) : 0);
  };

  const endCropDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (cropDragRef.current?.pointerId === event.pointerId) cropDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <main className={`app-shell ${dragActive ? "dragging" : ""}`}>
      {dragActive && (
        <div className="drag-overlay" aria-hidden="true">
          <div className="drag-overlay-card">
            <span>↘</span>
            <strong>{multiMode ? "画像を追加" : "画像を置き換え"}</strong>
            <small>{multiMode ? "複数枚をまとめてドロップできます" : "ウィンドウ内のどこでもドロップできます"}</small>
          </div>
        </div>
      )}

      {runtimeChecked && !capabilities && (
        <div className="runtime-alert">
          <span>Real-ESRGAN runtime未導入</span>
          <button className="runtime-install" onClick={installManagedRuntime} disabled={installingRuntime}>
            {installingRuntime ? "Installing…" : "Install runtime"}
          </button>
        </div>
      )}

      <section className="mode-tabs" aria-label="Operation">
        {(["enhance", "compress", "optimize", "crop"] as Operation[]).map((item) => (
          <button key={item} className={operation === item ? "active" : ""} onClick={() => setOperation(item)} disabled={running}>
            {modeLabel(item)}
            <small>{item === "enhance" ? "AI超解像" : item === "compress" ? "超圧縮・変換" : item === "optimize" ? "超解像 + 圧縮" : "サイズ・構図・容量"}</small>
          </button>
        ))}
      </section>

      <section className="workspace-grid">
        <aside className="control-panel">
          <div className="section-heading">
            <div className="section-label">SOURCE</div>
            <button className={`multi-toggle ${multiMode ? "active" : ""}`} onClick={toggleMultiMode} disabled={running || operation === "crop"} title={operation === "crop" ? "Crop to Size は1枚ずつ構図を調整します" : undefined}>
              <span className="toggle-track"><i /></span>
              複数 {multiMode ? "ON" : "OFF"}
            </button>
          </div>
          <button className={`drop-zone ${inputPath ? "loaded" : ""}`} onClick={openImage} disabled={running}>
            <span className="drop-icon">↘</span>
            <strong>{multiMode ? "画像を追加" : inputPath ? "画像を変更" : "画像をドロップ"}</strong>
            <span>{inputPath ? basename(inputPath) : "ウィンドウ全体へD&D / クリックして選択"}</span>
          </button>

          {multiMode && queue.length > 0 && (
            <div className="queue-card">
              <div className="queue-head">
                <span>{queue.length} images</span>
                <button onClick={() => setQueue([])} disabled={running}>Clear</button>
              </div>
              <div className="queue-list">
                {queue.map((entry, index) => (
                  <div key={entry.path} className={`queue-item ${entry.path === inputPath ? "selected" : ""}`}>
                    <button className="queue-select" onClick={() => void loadInput(entry.path)} disabled={running}>
                      <span className="queue-index">{String(index + 1).padStart(2, "0")}</span>
                      <span className="queue-name">{basename(entry.path)}</span>
                      <span className={`queue-status ${entry.state}`}>{entry.state}</span>
                    </button>
                    <button className="queue-remove" onClick={() => removeQueueEntry(entry.path)} disabled={running} aria-label={`${basename(entry.path)}をキューから削除`}>×</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {inputInfo && (
            <div className="mini-stats">
              <span>{inputInfo.width} × {inputInfo.height}</span>
              <span>{bytes(inputInfo.inputBytes)}</span>
              <span>{inputInfo.format.toUpperCase()} · {inputInfo.bitDepth}bit</span>
            </div>
          )}

          {operation === "crop" && (
            <>
              <div className="section-label">CUSTOM OUTPUT</div>
              <div className="field-row two size-fields">
                <label>
                  <span>Width · px</span>
                  <input type="number" min={1} max={32768} value={targetWidth} onChange={(event) => setTargetWidth(clamp(Math.round(Number(event.target.value) || 1), 1, 32768))} disabled={running} />
                </label>
                <label>
                  <span>Height · px</span>
                  <input type="number" min={1} max={32768} value={targetHeight} onChange={(event) => setTargetHeight(clamp(Math.round(Number(event.target.value) || 1), 1, 32768))} disabled={running} />
                </label>
              </div>
              <div className="source-size-tools">
                <button
                  type="button"
                  className="source-size-button"
                  onClick={() => applySourceSizeMultiplier(1)}
                  disabled={running || !inputInfo}
                >
                  元画像と同じ {inputInfo ? `${inputInfo.width}×${inputInfo.height}` : ""}
                </button>
                <div className="source-multiplier-tools" aria-label="元画像サイズ倍率">
                  <span>元画像倍率</span>
                  {[1, 2, 4].map((multiplier) => (
                    <button
                      key={multiplier}
                      type="button"
                      className={inputInfo
                        && targetWidth === Math.round(inputInfo.width * multiplier)
                        && targetHeight === Math.round(inputInfo.height * multiplier)
                        ? "active"
                        : ""}
                      onClick={() => applySourceSizeMultiplier(multiplier)}
                      disabled={running || !inputInfo || multiplier > maxSourceSizeMultiplier}
                    >
                      {multiplier}×
                    </button>
                  ))}
                  <label className="source-multiplier-input">
                    <input
                      type="number"
                      min={0.1}
                      max={Number(maxSourceSizeMultiplier.toFixed(2))}
                      step={0.1}
                      value={sourceSizeMultiplier}
                      onChange={(event) => setSourceSizeMultiplier(clamp(Number(event.target.value) || 0.1, 0.1, maxSourceSizeMultiplier))}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          applySourceSizeMultiplier(sourceSizeMultiplier);
                        }
                      }}
                      disabled={running || !inputInfo}
                      aria-label="元画像サイズ倍率"
                    />
                    <span>×</span>
                  </label>
                  <button type="button" onClick={() => applySourceSizeMultiplier(sourceSizeMultiplier)} disabled={running || !inputInfo}>適用</button>
                </div>
                {inputInfo && (
                  <small className="source-size-preview">
                    {sourceSizeMultiplier.toFixed(sourceSizeMultiplier % 1 === 0 ? 0 : 1)}× → {Math.round(inputInfo.width * sourceSizeMultiplier)}×{Math.round(inputInfo.height * sourceSizeMultiplier)} px
                  </small>
                )}
              </div>
              <div className="size-toolbar custom-size-toolbar">
                <button type="button" onClick={() => { setTargetWidth(targetHeight); setTargetHeight(targetWidth); }} disabled={running}>↔ W/H</button>
                <div
                  className="preset-menu"
                  onMouseEnter={() => setPresetMenuOpen(true)}
                  onMouseLeave={() => setPresetMenuOpen(false)}
                >
                  <button type="button" onClick={() => setPresetMenuOpen((value) => !value)} disabled={running}>サイズプリセット ▾</button>
                  {presetMenuOpen && (
                    <div className="preset-popover" role="menu">
                      <span className="preset-heading">BUILT-IN</span>
                      {[[1024, 1024], [1080, 1350], [1080, 1920], [1200, 630]].map(([width, height]) => (
                        <button key={`${width}x${height}`} type="button" onClick={() => { setCropPreset(width, height); setPresetMenuOpen(false); }}>
                          <span>{width}×{height}</span><small>px</small>
                        </button>
                      ))}
                      {savedSizePresets.length > 0 && <span className="preset-heading saved">SAVED</span>}
                      {savedSizePresets.map((preset) => (
                        <div className="saved-preset-row" key={preset.id}>
                          <button type="button" className="saved-preset-apply" onClick={() => { setCropPreset(preset.width, preset.height); setPresetMenuOpen(false); }}>
                            <span>{preset.name}</span><small>{preset.width}×{preset.height}</small>
                          </button>
                          <button type="button" className="saved-preset-delete" aria-label={`${preset.name}を削除`} onClick={(event) => { event.stopPropagation(); deleteSavedPreset(preset.id); }}>×</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="preset-save-row">
                <input value={presetName} onChange={(event) => setPresetName(event.target.value)} placeholder={`名前（未入力なら ${targetWidth}×${targetHeight}）`} disabled={running} />
                <button type="button" onClick={saveCurrentPreset} disabled={running}>サイズ保存</button>
              </div>

              <div className={`size-cap-card ${sizeCapEnabled ? "active" : ""}`}>
                <label className="size-cap-toggle">
                  <input type="checkbox" checked={sizeCapEnabled} onChange={(event) => setSizeCapEnabled(event.target.checked)} disabled={running} />
                  <span>最大ファイルサイズを指定</span>
                </label>
                {sizeCapEnabled && (
                  <div className="size-cap-fields">
                    <input type="number" min={0.01} step={0.05} value={sizeCapValue} onChange={(event) => setSizeCapValue(Math.max(0.01, Number(event.target.value) || 0.01))} disabled={running} />
                    <select value={sizeCapUnit} onChange={(event) => setSizeCapUnit(event.target.value as "KB" | "MB")} disabled={running}>
                      <option value="KB">KB</option>
                      <option value="MB">MB</option>
                    </select>
                    <strong>≤ {bytes(customTargetBytes)}</strong>
                  </div>
                )}
                <p>サイズ上限を優先するため、JPG / WebP / AVIF / JXL は必要に応じて品質を下げます。PNGはExactで達成不能なら明示的に停止します。</p>
              </div>

              <div className="crop-controls">
                <div className="crop-zoom-head"><span>Zoom</span><strong>{cropZoom.toFixed(2)}×</strong></div>
                <div className="crop-zoom-row">
                  <button type="button" onClick={() => setCropZoom((value) => clamp(value - 0.1, 1, 6))} disabled={running}>−</button>
                  <input type="range" min={1} max={6} step={0.01} value={cropZoom} onChange={(event) => setCropZoom(Number(event.target.value))} disabled={running} />
                  <button type="button" onClick={() => setCropZoom((value) => clamp(value + 0.1, 1, 6))} disabled={running}>＋</button>
                </div>
                <div className="nudge-area">
                  <span>位置</span>
                  <div className="nudge-pad">
                    <button type="button" className="up" onClick={() => adjustCrop(0, -0.04)} disabled={running}>↑</button>
                    <button type="button" className="left" onClick={() => adjustCrop(-0.04, 0)} disabled={running}>←</button>
                    <button type="button" className="center" onClick={() => { setCropX(0); setCropY(0); }} disabled={running}>●</button>
                    <button type="button" className="right" onClick={() => adjustCrop(0.04, 0)} disabled={running}>→</button>
                    <button type="button" className="down" onClick={() => adjustCrop(0, 0.04)} disabled={running}>↓</button>
                  </div>
                </div>
                <div className="crop-reset-row">
                  <button type="button" onClick={() => { setCropX(0); setCropY(0); }} disabled={running}>位置Reset</button>
                  <button type="button" onClick={() => setCropZoom(1)} disabled={running}>Zoom Reset</button>
                  <button type="button" onClick={() => { setCropZoom(1); setCropX(0); setCropY(0); }} disabled={running}>中央Fit</button>
                </div>
                <div className="transform-note compact">
                  <span>プレビューをドラッグ / ホイール / 矢印キーで調整。Shift+矢印は大きく、Option+矢印は細かく移動。</span>
                  {inputInfo && (inputInfo.width < targetWidth || inputInfo.height < targetHeight) && <span className="size-warning">指定サイズが元画像より大きいため、出力ではLanczos補間が入る場合があります。</span>}
                </div>
              </div>
            </>
          )}

          {(operation === "enhance" || operation === "optimize") && (
            <>
              <div className="section-label">SUPER RESOLUTION</div>
              <div className="field-row two sr-mode-row">
                <div className="field-control">
                  <div className="field-title"><span>Scale</span></div>
                  <select value={scale} onChange={(event) => setScale(Number(event.target.value) as 1 | 2 | 4)} disabled={running}>
                    <option value={1}>1× · 解像度維持</option>
                    <option value={2}>2× · 推奨確認</option>
                    <option value={4}>4× · 最大拡大</option>
                  </select>
                </div>
                <div className="field-control">
                  <div className="field-title">
                    <span>Mode</span>
                    <InfoHint title="Mode · 処理方針の選び方">
                      <p className="info-lead"><b>Modeは「処理の方針・優先順位」</b>です。Modelそのものではなく、Auto route時の選び方と仕上がり意図を指定します。</p>
                      <p>{selectedModeHelp.body}</p>
                      <ul className="info-list">
                        <li><b>Fidelity</b><span>原画像優先。写真、文字、滑らかなCGで余計な再生成を抑えたい。</span></li>
                        <li><b>Balanced · 推奨</b><span>自然さとディテールの中間。迷ったらこれ。</span></li>
                        <li><b>Perceptual</b><span>見た目の細部感寄り。柔らかい素材では効くが、再生成感も増えやすい。</span></li>
                      </ul>
                      <div className="info-callout"><b>用途例</b><span>写真 → Fidelity / Balanced</span><span>宇宙・近未来CG / 発光ライン → FidelityまたはBalanced</span><span>アニメ絵 → Balanced + anime系Model</span></div>
                      <em>Speed専用Modeはありません。速度差は主にScaleとModelで決まり、軽さ重視なら animevideov3 が候補です。</em>
                    </InfoHint>
                  </div>
                  <select value={srMode} onChange={(event) => setSrMode(event.target.value as SrMode)} disabled={running || scale === 1}>
                    <option value="fidelity">Fidelity</option>
                    <option value="balanced">Balanced · 推奨</option>
                    <option value="perceptual">Perceptual</option>
                  </select>
                </div>
              </div>
              {scale === 1 && <div className="scale-note">1×ではSR child processを起動せず、寸法を完全維持して変換 / 圧縮のみ行います。</div>}
              <div className="field-control field sr-model-field">
                <div className="field-title">
                  <span>Model</span>
                  <InfoHint title="Model · 学習済みSRモデルの選び方">
                    <p className="info-lead"><b>Modelは「学習済みSRモデルそのもの」</b>です。Modeよりも、画像ジャンルに対する得意・不得意へ直接効きます。</p>
                    <p>{selectedModelHelp.body}</p>
                    <ul className="info-list">
                      <li><b>Auto route · 推奨</b><span>Modeと内蔵規則から保守的に選択。一般用途向け。特殊CGでは手動固定の方が読みやすい結果になる場合があります。</span></li>
                      <li><b>realesrgan-x4plus</b><span>写真・一般画像・実写寄りCG。宇宙、霧、発光リム、滑らかなラインはまずこれ。</span></li>
                      <li><b>realesrgan-x4plus-anime</b><span>アニメ、イラスト、線画。写真や実写寄りCGには不向き。</span></li>
                      <li><b>realesr-animevideov3</b><span>アニメ映像寄りの軽量モデル。速度優先や連続フレーム向け。</span></li>
                    </ul>
                    <div className="info-callout accent"><b>宇宙 / 近未来CG</b><span>realesrgan-x4plus + Fidelity / Balanced</span><span>まず2×で確認し、必要な場合だけ4×。微細な星・霧・発光線は4×ほど再生成感が増えやすい。</span></div>
                    <em>Auto routeで質感が抽象化する場合は、宇宙CGでは x4plus を手動固定してください。</em>
                  </InfoHint>
                </div>
                <select value={modelId} onChange={(event) => setModelId(event.target.value)} disabled={running || scale === 1}>
                  <option value="">Auto route · 推奨</option>
                  {capabilities?.models.map((model) => <option key={model.id} value={model.id}>{model.id}</option>)}
                </select>
              </div>
            </>
          )}

          <div className="section-label">OUTPUT FORMATS</div>
          <div className="format-selector" role="group" aria-label="出力形式を複数選択">
            {OUTPUT_FORMATS.map((item) => {
              const active = selectedFormats.includes(item.id);
              return (
                <button
                  key={item.id}
                  type="button"
                  className={active ? "active" : ""}
                  aria-pressed={active}
                  onClick={() => toggleOutputFormat(item.id)}
                  disabled={running}
                >
                  <strong>{item.label}</strong>
                  <small>{item.detail}</small>
                </button>
              );
            })}
          </div>
          <div className="quality-note">{qualityNote}</div>

          <div className="section-label">OUTPUT</div>
          <div className="output-folder-row">
            <div className="output-folder-display">
              <span>保存先フォルダ</span>
              <strong title={outputDirectory}>{outputDirectory || "未選択"}</strong>
            </div>
            <button onClick={chooseOutputDirectory} disabled={!inputPath || running}>Finder…</button>
          </div>
          <label className="field output-name-field">
            <span>ファイル名</span>
            <input
              value={multiMode ? "入力名-agent2d-*（自動）" : outputName}
              onChange={(event) => { setOutputName(event.target.value); setOutputPath(""); }}
              placeholder="image-agent2d-optimized"
              disabled={running || multiMode}
            />
          </label>
          <div className="output-preview-line">
            <span>最終名</span>
            <code>{multiMode ? `各入力名 → ${selectedFormats.map((item) => item.toUpperCase()).join(" + ")} / 衝突時 _02, _03…` : visibleOutputName}</code>
          </div>
          {outputPath && <div className="resolved-output" title={outputPath}>保存先: {outputPath}</div>}
          {outputResults.length > 1 && (
            <div className="output-results-list">
              {outputResults.map((entry) => <span key={entry.outputPath}>{basename(entry.outputPath)} · {bytes(entry.outputBytes)}</span>)}
            </div>
          )}

          {job && (
            <div className={`job-card ${job.state}`}>
              <div className="job-line">
                <span>{batchRunning ? `batch · ${stageLabel(job.stage)}` : stageLabel(job.stage)}</span>
                <strong>{Math.round(progressFraction * 100)}%</strong>
              </div>
              <div className="progress-track"><div className="progress-fill" style={{ width: `${Math.max(4, progressFraction * 100)}%` }} /></div>
              <div className="job-meta"><span>{etaText || "時間を計測中"}</span><span>{operation === "crop" ? `${targetWidth}×${targetHeight}${customTargetBytes ? ` · ≤${bytes(customTargetBytes)}` : ""}` : scale === 1 && (operation === "enhance" || operation === "optimize") ? `SR skip · ${selectedFormats.length} format` : operation === "compress" ? `${selectedFormats.length} format` : `${scale}× · ${selectedFormats.length} format`}</span></div>
            </div>
          )}

          {error && <div className="error-box">{error}</div>}

          <div className="action-row">
            <button className="primary" onClick={start} disabled={running || selectedFormats.length === 0 || (multiMode ? queue.length === 0 || !outputDirectory : !inputPath || !outputDirectory || !outputName.trim())}>
              {running ? "Processing…" : multiMode ? `${modeLabel(operation)} ${queue.length} images · ${selectedFormats.length} formats` : `${modeLabel(operation)} · ${selectedFormats.length} format${selectedFormats.length > 1 ? "s" : ""}`}
            </button>
            {running && <button className="danger" onClick={cancel}>Cancel</button>}
          </div>
        </aside>

        <section className="preview-area">
          {operation === "crop" ? (
            <figure className="crop-card">
              <figcaption>
                <div><span className="before-label">CUSTOM FRAME</span>{inputInfo && <b>{inputInfo.width}×{inputInfo.height}</b>}</div>
                <div className="crop-caption-center">{targetWidth}×{targetHeight}px · {cropZoom.toFixed(2)}×</div>
                <div><span className="after-label">OUTPUT</span>{result && <b>{result.outputWidth}×{result.outputHeight}</b>}</div>
              </figcaption>
              <div className="crop-workbench">
                <div
                  ref={cropStageRef}
                  className="crop-frame"
                  style={{ aspectRatio: `${targetWidth} / ${targetHeight}` }}
                  tabIndex={0}
                  role="application"
                  aria-label="Ultra custom preview. Drag, wheel, or arrow keys to adjust."
                  onPointerDown={handleCropPointerDown}
                  onPointerMove={handleCropPointerMove}
                  onPointerUp={endCropDrag}
                  onPointerCancel={endCropDrag}
                  onWheel={(event) => {
                    if (!inputPreview || running) return;
                    event.preventDefault();
                    setCropZoom((value) => clamp(value + (event.deltaY < 0 ? 0.12 : -0.12), 1, 6));
                  }}
                  onKeyDown={(event) => {
                    if (running) return;
                    const step = event.shiftKey ? 0.1 : event.altKey ? 0.012 : 0.035;
                    if (event.key === "ArrowLeft") { event.preventDefault(); adjustCrop(-step, 0); }
                    else if (event.key === "ArrowRight") { event.preventDefault(); adjustCrop(step, 0); }
                    else if (event.key === "ArrowUp") { event.preventDefault(); adjustCrop(0, -step); }
                    else if (event.key === "ArrowDown") { event.preventDefault(); adjustCrop(0, step); }
                    else if (event.key === "Enter") { event.preventDefault(); void start(); }
                    else if (event.key === "Escape") { event.preventDefault(); setCropX(0); setCropY(0); }
                  }}
                >
                  {inputPreview ? (
                    <>
                      <img className="crop-image" src={inputPreview} alt="Crop source" style={cropImageStyle} draggable={false} />
                      <div className="crop-grid-overlay" aria-hidden="true"><i /><i /><i /><i /></div>
                      <div className="crop-edge-shade" aria-hidden="true" />
                    </>
                  ) : <div className="empty-preview">Drop an image anywhere</div>}
                </div>
              </div>
              <div className="crop-helpbar">
                <span>Drag · Wheel · ↑↓←→</span>
                <span>Shift = 大きく / Option = 細かく</span>
                <span>最小Zoomは空白が出ないCover</span>
              </div>
            </figure>
          ) : (
          <figure className="comparison-card">
            <figcaption>
              <div><span className="before-label">BEFORE</span>{inputInfo && <b>{inputInfo.width}×{inputInfo.height}</b>}</div>
              <div className="compare-help">← Afterを広く · drag · Beforeを広く →</div>
              <div><span className="after-label">AFTER</span>{displayResult && <b>{displayResult.outputWidth}×{displayResult.outputHeight}</b>}</div>
            </figcaption>
            {comparisonOutputs.length > 1 && (
              <div className="compare-format-tabs" role="tablist" aria-label="Before / After 出力形式">
                {comparisonOutputs.map((entry) => (
                  <button
                    key={entry.format}
                    type="button"
                    role="tab"
                    aria-selected={comparisonFormat === entry.format}
                    className={comparisonFormat === entry.format ? "active" : ""}
                    onClick={() => setComparisonFormat(entry.format)}
                  >
                    <strong>{entry.format === "jpeg" ? "JPG" : entry.format.toUpperCase()}</strong>
                    <small>{bytes(entry.result.outputBytes)}</small>
                  </button>
                ))}
              </div>
            )}
            <div
              ref={compareStageRef}
              className={`comparison-stage ${displayOutputPreview ? "ready" : ""}`}
              onPointerDown={(event) => {
                if (!displayOutputPreview) return;
                event.currentTarget.setPointerCapture(event.pointerId);
                updateCompareFromClientX(event.clientX);
              }}
              onPointerMove={(event) => {
                if (displayOutputPreview && event.currentTarget.hasPointerCapture(event.pointerId)) updateCompareFromClientX(event.clientX);
              }}
            >
              {inputPreview ? (
                <>
                  <img className="compare-image before-image" src={inputPreview} alt="Before" />
                  {displayOutputPreview && (
                    <div className="after-layer" style={{ clipPath: `inset(0 0 0 ${comparePosition}%)` }}>
                      <img className="compare-image after-image" src={displayOutputPreview} alt={`After ${comparisonFormat.toUpperCase()}`} />
                    </div>
                  )}
                  {displayOutputPreview && (
                    <button
                      type="button"
                      className="compare-handle"
                      style={{ left: `${comparePosition}%` }}
                      role="slider"
                      aria-label="Before / After 比較位置"
                      aria-valuemin={4}
                      aria-valuemax={96}
                      aria-valuenow={Math.round(comparePosition)}
                      onKeyDown={(event) => {
                        if (event.key === "ArrowLeft") {
                          event.preventDefault();
                          setComparePosition((value) => Math.max(4, value - 2));
                        } else if (event.key === "ArrowRight") {
                          event.preventDefault();
                          setComparePosition((value) => Math.min(96, value + 2));
                        } else if (event.key === "Home") {
                          event.preventDefault();
                          setComparePosition(4);
                        } else if (event.key === "End") {
                          event.preventDefault();
                          setComparePosition(96);
                        }
                      }}
                    >
                      <span>‹</span><i /><span>›</span>
                    </button>
                  )}
                  {!displayOutputPreview && <div className="result-waiting">処理後、ここで重ね比較できます</div>}
                </>
              ) : <div className="empty-preview">Drop an image anywhere</div>}
            </div>
          </figure>
          )}

          <div className="result-strip">
            <div><span>INPUT</span><strong>{bytes(displayResult?.inputBytes ?? inputInfo?.inputBytes)}</strong></div>
            <div><span>OUTPUT</span><strong>{bytes(displayResult?.outputBytes)}</strong></div>
            <div><span>SIZE CHANGE</span><strong>{savings == null ? "—" : `${savings >= 0 ? "−" : "+"}${Math.abs(savings).toFixed(1)}%`}</strong></div>
            <div><span>TIME</span><strong>{displayResult ? `${(displayResult.elapsedMs / 1000).toFixed(2)}s` : "—"}</strong></div>
            <div><span>VERIFY</span><strong>{displayResult?.pixelExact === true ? "PIXEL EXACT" : displayResult ? "PASS" : "—"}</strong></div>
          </div>

          {displayResult?.warnings?.length ? (
            <div className="warning-row">{displayResult.warnings.map((warning) => <span key={warning}>{warning.replaceAll("_", " ")}</span>)}</div>
          ) : null}
        </section>
      </section>
    </main>
  );
}
