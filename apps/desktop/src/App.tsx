import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type WheelEvent as ReactWheelEvent } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  Agent2DResult,
  BackgroundRuntimeStatus,
  CompressionMode,
  DesktopJobRequest,
  DesktopJobStatus,
  ErrorPayload,
  InspectResult,
  ObjectBoxPrompt,
  ObjectEditAction,
  ObjectEditRuntimeStatus,
  ObjectMaskPreview,
  ObjectPoint,
  ObjectSelection,
  Operation,
  OutputFormat,
  SrCapabilities,
  SrMode,
} from "./types";
import "./styles.css";

const POLL_MS = 180;
const SUPPORTED_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "avif", "jxl"]);

type QueueState = "pending" | "running" | "completed" | "failed" | "cancelled";
type VectorPreset = "illustration" | "logo" | "line-art";
type VectorDetail = "clean" | "balanced" | "detailed";
type ObjectTool = "include" | "exclude" | "box" | "pan";
type AppTheme = "lumiere" | "sorbet" | "linen" | "petale" | "versailles" | "nocturne" | "cosmos" | "graphite";
type ShortcutAction = "operation1" | "operation2" | "operation3" | "operation4" | "operation5" | "operation6" | "operation7" | "previousOperation" | "nextOperation" | "openImage" | "run" | "objectUndo" | "settings";
type ShortcutMap = Record<ShortcutAction, string>;
type UiPreferences = {
  theme: AppTheme;
  shortcuts: ShortcutMap;
};
type ObjectSelectionSnapshot = {
  points: ObjectPoint[];
  box: ObjectBoxPrompt | null;
  expand: number;
  feather: number;
};
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
const UI_PREFERENCES_STORAGE_KEY = "agent2d.ui-preferences.v1";
const OPERATION_ORDER: Operation[] = ["enhance", "compress", "optimize", "crop", "remove-bg", "object-edit", "vectorize"];
const OPERATION_SHORTCUT_ACTIONS: ShortcutAction[] = ["operation1", "operation2", "operation3", "operation4", "operation5", "operation6", "operation7"];
const DEFAULT_SHORTCUTS: ShortcutMap = {
  operation1: "Meta+Digit1",
  operation2: "Meta+Digit2",
  operation3: "Meta+Digit3",
  operation4: "Meta+Digit4",
  operation5: "Meta+Digit5",
  operation6: "Meta+Digit6",
  operation7: "Meta+Digit7",
  previousOperation: "Meta+BracketLeft",
  nextOperation: "Meta+BracketRight",
  openImage: "Meta+KeyO",
  run: "Meta+Enter",
  objectUndo: "Meta+KeyZ",
  settings: "Meta+Comma",
};
const THEME_OPTIONS: Array<{ id: AppTheme; name: string; detail: string; swatches: [string, string, string] }> = [
  { id: "lumiere", name: "Lumière", detail: "明るく端正", swatches: ["#f7f9fc", "#ffffff", "#4f78c9"] },
  { id: "sorbet", name: "Sorbet", detail: "POPで軽やか", swatches: ["#fff4f7", "#ffdbe6", "#eb7d9e"] },
  { id: "linen", name: "Linen", detail: "やさしい温もり", swatches: ["#f5efe5", "#fffaf2", "#7d947c"] },
  { id: "petale", name: "Pétale", detail: "可憐で柔らかい", swatches: ["#fff7fa", "#f7dfe9", "#d7799f"] },
  { id: "versailles", name: "Versailles", detail: "古典と品格", swatches: ["#f2eadb", "#203858", "#a3833f"] },
  { id: "nocturne", name: "Nocturne", detail: "落ち着いたダーク", swatches: ["#080b12", "#111a28", "#5e91d3"] },
  { id: "cosmos", name: "Cosmos", detail: "深宇宙と発光", swatches: ["#050713", "#101735", "#8a78ff"] },
  { id: "graphite", name: "Graphite", detail: "無彩色ミニマル", swatches: ["#111315", "#1c1f23", "#98a3b2"] },
];
const SHORTCUT_ROWS: Array<{ id: ShortcutAction; label: string; detail: string }> = [
  ...OPERATION_ORDER.map((operation, index) => ({ id: OPERATION_SHORTCUT_ACTIONS[index], label: `${index + 1}. ${modeLabel(operation)}`, detail: "モードへ直接移動" })),
  { id: "previousOperation", label: "前のモード", detail: "左隣のタブへ移動" },
  { id: "nextOperation", label: "次のモード", detail: "右隣のタブへ移動" },
  { id: "openImage", label: "画像を開く", detail: "ファイル選択を開く" },
  { id: "run", label: "処理を実行", detail: "現在の設定で開始" },
  { id: "objectUndo", label: "Object Editを戻す", detail: "選択操作を1段階戻す" },
  { id: "settings", label: "設定を開く", detail: "Theme / Shortcut設定" },
];
const OUTPUT_FORMATS: Array<{ id: OutputFormat; label: string; detail: string }> = [
  { id: "png", label: "PNG", detail: "Exact" },
  { id: "jpeg", label: "JPG", detail: "High Quality" },
  { id: "webp", label: "WebP", detail: "Lossless / Compact" },
  { id: "avif", label: "AVIF", detail: "Preserve / Compact" },
  { id: "jxl", label: "JXL", detail: "Lossless / Compact" },
];
const BACKGROUND_OUTPUT_FORMATS: Array<{ id: OutputFormat; label: string; detail: string }> = [
  { id: "png", label: "PNG", detail: "Transparent" },
  { id: "webp", label: "WebP", detail: "Transparent · Lossless" },
];
const OBJECT_ALPHA_OUTPUT_FORMATS: Array<{ id: OutputFormat; label: string; detail: string }> = [
  { id: "png", label: "PNG", detail: "Transparent" },
  { id: "webp", label: "WebP", detail: "Transparent · Lossless" },
];
const OBJECT_FILL_OUTPUT_FORMATS: Array<{ id: OutputFormat; label: string; detail: string }> = [
  { id: "png", label: "PNG", detail: "Filled · Lossless" },
  { id: "jpeg", label: "JPG", detail: "Filled · High Quality" },
  { id: "webp", label: "WebP", detail: "Filled · Lossless" },
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

function isAppTheme(value: unknown): value is AppTheme {
  return THEME_OPTIONS.some((theme) => theme.id === value);
}

function loadUiPreferences(): UiPreferences {
  const fallback: UiPreferences = { theme: "lumiere", shortcuts: { ...DEFAULT_SHORTCUTS } };
  try {
    const raw = window.localStorage.getItem(UI_PREFERENCES_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<UiPreferences>;
    const shortcuts = parsed.shortcuts && typeof parsed.shortcuts === "object"
      ? Object.fromEntries((Object.keys(DEFAULT_SHORTCUTS) as ShortcutAction[]).map((key) => [key, typeof parsed.shortcuts?.[key] === "string" ? parsed.shortcuts[key] : DEFAULT_SHORTCUTS[key]])) as ShortcutMap
      : { ...DEFAULT_SHORTCUTS };
    return {
      theme: isAppTheme(parsed.theme) ? parsed.theme : fallback.theme,
      shortcuts,
    };
  } catch {
    return fallback;
  }
}

function shortcutFromEvent(event: KeyboardEvent): string {
  if (["MetaLeft", "MetaRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight", "ShiftLeft", "ShiftRight"].includes(event.code)) return "";
  const parts: string[] = [];
  if (event.metaKey) parts.push("Meta");
  if (event.ctrlKey) parts.push("Control");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  parts.push(event.code || event.key);
  return parts.join("+");
}

function matchesShortcut(event: KeyboardEvent, shortcut: string): boolean {
  if (!shortcut) return false;
  const parts = shortcut.split("+");
  const code = parts.at(-1) ?? "";
  return event.code === code
    && event.metaKey === parts.includes("Meta")
    && event.ctrlKey === parts.includes("Control")
    && event.altKey === parts.includes("Alt")
    && event.shiftKey === parts.includes("Shift");
}

function shortcutDisplay(shortcut: string): string {
  if (!shortcut) return "未設定";
  const parts = shortcut.split("+");
  const code = parts.at(-1) ?? "";
  const symbol = code.startsWith("Digit") ? code.slice(5)
    : code.startsWith("Key") ? code.slice(3)
      : code === "BracketLeft" ? "["
        : code === "BracketRight" ? "]"
          : code === "Comma" ? ","
            : code === "Enter" ? "↵"
              : code === "Space" ? "Space"
                : code.replace(/^Arrow/, "");
  return `${parts.includes("Control") ? "⌃" : ""}${parts.includes("Alt") ? "⌥" : ""}${parts.includes("Shift") ? "⇧" : ""}${parts.includes("Meta") ? "⌘" : ""}${symbol}`;
}

function ShortcutCaptureButton({ value, label, onChange }: { value: string; label: string; onChange: (value: string) => void }) {
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    if (!recording) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setRecording(false);
        return;
      }
      if (event.key === "Backspace" || event.key === "Delete") {
        onChange("");
        setRecording(false);
        return;
      }
      const next = shortcutFromEvent(event);
      if (!next) return;
      onChange(next);
      setRecording(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onChange, recording]);

  return (
    <button
      type="button"
      className={`shortcut-capture ${recording ? "recording" : ""}`}
      data-shortcut-capture-active={recording ? "true" : undefined}
      aria-label={`${label}のショートカットを編集`}
      onClick={() => setRecording(true)}
    >
      {recording ? "キー入力…" : shortcutDisplay(value)}
    </button>
  );
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

function NumberStepper({
  value,
  onChange,
  min,
  max,
  step = 1,
  disabled = false,
  ariaLabel,
  suffix,
  onEnter,
}: {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  ariaLabel: string;
  suffix?: string;
  onEnter?: () => void;
}) {
  const precision = Math.max(0, `${step}`.split(".")[1]?.length ?? 0);
  const normalize = useCallback((next: number) => {
    const bounded = Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min, next));
    return Number(bounded.toFixed(precision));
  }, [max, min, precision]);

  return (
    <div className="number-stepper">
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(normalize(Number(event.target.value) || min))}
        onKeyDown={(event) => {
          if (event.key === "Enter" && onEnter) {
            event.preventDefault();
            onEnter();
          }
        }}
        disabled={disabled}
        aria-label={ariaLabel}
      />
      {suffix && <span className="number-stepper-suffix">{suffix}</span>}
      <div className="number-stepper-actions" aria-hidden={disabled || undefined}>
        <button type="button" onClick={() => onChange(normalize(value - step))} disabled={disabled || value <= min} aria-label={`${ariaLabel}を減らす`}>−</button>
        <button type="button" onClick={() => onChange(normalize(value + step))} disabled={disabled || (max != null && value >= max)} aria-label={`${ariaLabel}を増やす`}>＋</button>
      </div>
    </div>
  );
}

function SizePresetMenu({
  disabled,
  presets,
  onApply,
  onDelete,
}: {
  disabled: boolean;
  presets: SavedSizePreset[];
  onApply: (width: number, height: number) => void;
  onDelete: (id: string) => void;
}) {
  const [openState, setOpenState] = useState(false);
  const [position, setPosition] = useState({ left: 12, top: 12, width: 260 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current != null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => setOpenState(false), 180);
  }, [cancelClose]);

  const place = useCallback(() => {
    const button = buttonRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const width = Math.min(280, Math.max(220, window.innerWidth - 24));
    const height = popoverRef.current?.offsetHeight ?? 260;
    const left = Math.min(Math.max(12, rect.left), Math.max(12, window.innerWidth - width - 12));
    const below = rect.bottom + 8;
    const top = below + height <= window.innerHeight - 12
      ? below
      : Math.max(12, rect.top - height - 8);
    setPosition({ left, top, width });
  }, []);

  useEffect(() => {
    if (!openState) return;
    place();
    const frame = window.requestAnimationFrame(place);
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!buttonRef.current?.contains(target) && !popoverRef.current?.contains(target)) setOpenState(false);
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
    <>
      <div className="preset-menu" onMouseEnter={() => { cancelClose(); setOpenState(true); }} onMouseLeave={scheduleClose}>
        <button ref={buttonRef} type="button" onClick={() => setOpenState((value) => !value)} disabled={disabled} aria-expanded={openState}>サイズプリセット ▾</button>
      </div>
      {openState && createPortal(
        <div
          ref={popoverRef}
          className="preset-popover preset-popover-floating"
          role="menu"
          style={{ left: position.left, top: position.top, width: position.width }}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          <span className="preset-heading">BUILT-IN</span>
          {[[1024, 1024], [1080, 1350], [1080, 1920], [1200, 630]].map(([width, height]) => (
            <button key={`${width}x${height}`} type="button" onClick={() => { onApply(width, height); setOpenState(false); }}>
              <span>{width}×{height}</span><small>px</small>
            </button>
          ))}
          {presets.length > 0 && <span className="preset-heading saved">SAVED</span>}
          {presets.map((preset) => (
            <div className="saved-preset-row" key={preset.id}>
              <button type="button" className="saved-preset-apply" onClick={() => { onApply(preset.width, preset.height); setOpenState(false); }}>
                <span>{preset.name}</span><small>{preset.width}×{preset.height}</small>
              </button>
              <button type="button" className="saved-preset-delete" aria-label={`${preset.name}を削除`} onClick={(event) => { event.stopPropagation(); onDelete(preset.id); }}>×</button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
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
          : operation === "vectorize"
            ? "vectorized"
            : operation === "remove-bg"
              ? "transparent"
              : operation === "object-edit"
                ? "object-edit"
                : "optimized";
  const ext = operation === "vectorize" ? "svg" : format === "jpeg" ? "jpg" : format;
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

function withSvgExtension(filename: string): string {
  const trimmed = filename.trim();
  const dot = trimmed.lastIndexOf(".");
  const stem = dot > 0 ? trimmed.slice(0, dot) : trimmed;
  return `${stem || "output"}.svg`;
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
  if (operation === "vectorize") return 1_100 + megapixels * 1_850;
  if (operation === "remove-bg") return 3_500 + megapixels * 2_400;
  if (operation === "object-edit") return 5_000 + megapixels * 4_500;
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
    case "vectorize_svg": return "SVGベクター化";
    case "object_edit_sam2_lama": return "Object Edit · SAM2 / LaMa";
    case "background_removal_feynobg": return "FeyNoBg 背景透過";
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
  if (mode === "vectorize") return "Vectorize";
  if (mode === "remove-bg") return "Remove BG";
  if (mode === "object-edit") return "Object Edit";
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
  const [uiPreferences, setUiPreferences] = useState<UiPreferences>(loadUiPreferences);
  const [settingsOpen, setSettingsOpen] = useState(false);
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
  const [sizeCapEnabled, setSizeCapEnabled] = useState(false);
  const [sizeCapValue, setSizeCapValue] = useState(1);
  const [sizeCapUnit, setSizeCapUnit] = useState<"KB" | "MB">("MB");
  const [vectorPreset, setVectorPreset] = useState<VectorPreset>("illustration");
  const [vectorDetail, setVectorDetail] = useState<VectorDetail>("balanced");
  const [vectorMaxColors, setVectorMaxColors] = useState(24);
  const [backgroundRuntime, setBackgroundRuntime] = useState<BackgroundRuntimeStatus | null>(null);
  const [backgroundRuntimeChecked, setBackgroundRuntimeChecked] = useState(false);
  const [installingBackgroundRuntime, setInstallingBackgroundRuntime] = useState(false);
  const [objectRuntime, setObjectRuntime] = useState<ObjectEditRuntimeStatus | null>(null);
  const [objectRuntimeChecked, setObjectRuntimeChecked] = useState(false);
  const [installingObjectRuntime, setInstallingObjectRuntime] = useState(false);
  const [objectRuntimeWarming, setObjectRuntimeWarming] = useState(false);
  const [objectTool, setObjectTool] = useState<ObjectTool>("include");
  const [objectPoints, setObjectPoints] = useState<ObjectPoint[]>([]);
  const [objectBox, setObjectBox] = useState<ObjectBoxPrompt | null>(null);
  const [objectBoxDraft, setObjectBoxDraft] = useState<ObjectBoxPrompt | null>(null);
  const [objectExpand, setObjectExpand] = useState(0);
  const [objectFeather, setObjectFeather] = useState(1);
  const [objectAction, setObjectAction] = useState<ObjectEditAction>("make-selected-transparent");
  const [objectMaskPreview, setObjectMaskPreview] = useState("");
  const [objectMaskScore, setObjectMaskScore] = useState<number | null>(null);
  const [objectMaskLoading, setObjectMaskLoading] = useState(false);
  const [objectZoom, setObjectZoom] = useState(1);
  const [objectPan, setObjectPan] = useState({ x: 0, y: 0 });
  const [objectStageSize, setObjectStageSize] = useState({ width: 0, height: 0 });
  const [objectUndoDepth, setObjectUndoDepth] = useState(0);
  const cancelBatchRef = useRef(false);
  const outputDirectoryPinnedRef = useRef(false);
  const compareStageRef = useRef<HTMLDivElement>(null);
  const cropStageRef = useRef<HTMLDivElement>(null);
  const cropDragRef = useRef<{ pointerId: number; startX: number; startY: number; baseX: number; baseY: number } | null>(null);
  const objectStageRef = useRef<HTMLDivElement>(null);
  const objectMediaRef = useRef<HTMLDivElement>(null);
  const objectDragRef = useRef<{ pointerId: number; mode: "box" | "pan"; startX: number; startY: number; basePanX: number; basePanY: number; startPoint?: { x: number; y: number } } | null>(null);
  const objectUndoStackRef = useRef<ObjectSelectionSnapshot[]>([]);
  const objectMaskRequestRef = useRef(0);

  useEffect(() => {
    document.documentElement.dataset.agent2dTheme = uiPreferences.theme;
    try {
      window.localStorage.setItem(UI_PREFERENCES_STORAGE_KEY, JSON.stringify(uiPreferences));
    } catch {
      // UI preferences are optional; image processing must stay usable.
    }
  }, [uiPreferences]);

  const assignShortcut = useCallback((action: ShortcutAction, shortcut: string) => {
    setUiPreferences((current) => {
      const next = { ...current.shortcuts };
      if (shortcut) {
        (Object.keys(next) as ShortcutAction[]).forEach((key) => {
          if (key !== action && next[key] === shortcut) next[key] = "";
        });
      }
      next[action] = shortcut;
      return { ...current, shortcuts: next };
    });
  }, []);

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
      setObjectPoints([]);
      setObjectBox(null);
      setObjectBoxDraft(null);
      setObjectMaskPreview("");
      setObjectMaskScore(null);
      setObjectMaskLoading(false);
      setObjectZoom(1);
      setObjectPan({ x: 0, y: 0 });
      objectUndoStackRef.current = [];
      setObjectUndoDepth(0);
      objectMaskRequestRef.current += 1;
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

  const refreshBackgroundRuntime = useCallback(async () => {
    try {
      const next = await invoke<BackgroundRuntimeStatus>("background_runtime_status_command");
      setBackgroundRuntime(next);
    } catch {
      setBackgroundRuntime(null);
    } finally {
      setBackgroundRuntimeChecked(true);
    }
  }, []);

  useEffect(() => {
    void refreshBackgroundRuntime();
  }, [refreshBackgroundRuntime]);

  const refreshObjectRuntime = useCallback(async () => {
    try {
      const next = await invoke<ObjectEditRuntimeStatus>("object_edit_runtime_status_command");
      setObjectRuntime(next);
    } catch {
      setObjectRuntime(null);
    } finally {
      setObjectRuntimeChecked(true);
    }
  }, []);

  useEffect(() => {
    void refreshObjectRuntime();
  }, [refreshObjectRuntime]);

  useEffect(() => {
    if (operation !== "object-edit" || !objectRuntime?.installed) return;
    let active = true;
    setObjectRuntimeWarming(true);
    void invoke<void>("warm_object_edit_runtime_command")
      .catch((cause) => {
        if (active) setError(errorText(cause));
      })
      .finally(() => {
        if (active) setObjectRuntimeWarming(false);
      });
    return () => { active = false; };
  }, [objectRuntime?.installed, operation]);

  useEffect(() => {
    if (operation === "remove-bg") {
      setSelectedFormats((current) => {
        const compatible = current.filter((format) => format === "png" || format === "webp");
        if (compatible.length === 0) return ["png"];
        return compatible.length === current.length ? current : compatible;
      });
      return;
    }
    if (operation === "object-edit") {
      setMultiMode(false);
      setSelectedFormats((current) => {
        const allowed = objectAction === "remove-and-fill" ? ["png", "jpeg", "webp"] : ["png", "webp"];
        const compatible = current.filter((format) => allowed.includes(format));
        return compatible.length > 0 ? [compatible[0]] : ["png"];
      });
    }
  }, [objectAction, operation]);

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

  const installBackgroundRuntime = async () => {
    if (installingBackgroundRuntime) return;
    setInstallingBackgroundRuntime(true);
    setError("");
    try {
      const next = await invoke<BackgroundRuntimeStatus>("install_background_runtime_command");
      setBackgroundRuntime(next);
      setBackgroundRuntimeChecked(true);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setInstallingBackgroundRuntime(false);
    }
  };

  const installObjectRuntime = async () => {
    if (installingObjectRuntime) return;
    setInstallingObjectRuntime(true);
    setError("");
    try {
      const next = await invoke<ObjectEditRuntimeStatus>("install_object_edit_runtime_command");
      setObjectRuntime(next);
      setObjectRuntimeChecked(true);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setInstallingObjectRuntime(false);
    }
  };

  const currentObjectSelection = useMemo<ObjectSelection>(() => ({
    points: objectPoints,
    boxPrompt: objectBox,
    expandPx: objectExpand,
    featherPx: objectFeather,
  }), [objectBox, objectExpand, objectFeather, objectPoints]);

  const pushObjectUndo = useCallback(() => {
    const next: ObjectSelectionSnapshot = {
      points: objectPoints.map((point) => ({ ...point })),
      box: objectBox ? { ...objectBox } : null,
      expand: objectExpand,
      feather: objectFeather,
    };
    objectUndoStackRef.current = [...objectUndoStackRef.current.slice(-39), next];
    setObjectUndoDepth(objectUndoStackRef.current.length);
  }, [objectBox, objectExpand, objectFeather, objectPoints]);

  const undoObjectSelection = useCallback(() => {
    const previous = objectUndoStackRef.current.at(-1);
    if (!previous) return;
    objectUndoStackRef.current = objectUndoStackRef.current.slice(0, -1);
    setObjectUndoDepth(objectUndoStackRef.current.length);
    objectMaskRequestRef.current += 1;
    setObjectPoints(previous.points.map((point) => ({ ...point })));
    setObjectBox(previous.box ? { ...previous.box } : null);
    setObjectBoxDraft(null);
    setObjectExpand(previous.expand);
    setObjectFeather(previous.feather);
    setObjectMaskPreview("");
    setObjectMaskScore(null);
    setObjectMaskLoading(false);
  }, []);

  const refreshObjectMask = useCallback(async (selection: ObjectSelection, requestId: number) => {
    if (!inputPath || !objectRuntime?.installed || (selection.points.length === 0 && !selection.boxPrompt)) return;
    try {
      const preview = await invoke<ObjectMaskPreview>("object_mask_preview_command", {
        inputPath,
        selection,
      });
      if (requestId !== objectMaskRequestRef.current) return;
      setObjectMaskPreview(preview.preview);
      setObjectMaskScore(preview.score);
    } catch (cause) {
      if (requestId !== objectMaskRequestRef.current) return;
      setObjectMaskPreview("");
      setObjectMaskScore(null);
      setError(errorText(cause));
    } finally {
      if (requestId === objectMaskRequestRef.current) setObjectMaskLoading(false);
    }
  }, [inputPath, objectRuntime?.installed]);

  useEffect(() => {
    const requestId = ++objectMaskRequestRef.current;
    if (operation !== "object-edit") {
      setObjectMaskLoading(false);
      return;
    }
    setResult(null);
    setOutputPreview("");
    setOutputResults([]);
    setComparisonOutputs([]);
    if (currentObjectSelection.points.length === 0 && !currentObjectSelection.boxPrompt) {
      setObjectMaskPreview("");
      setObjectMaskScore(null);
      setObjectMaskLoading(false);
      return;
    }
    setError("");
    setObjectMaskLoading(true);
    const timer = window.setTimeout(() => void refreshObjectMask(currentObjectSelection, requestId), 120);
    return () => window.clearTimeout(timer);
  }, [currentObjectSelection, operation, refreshObjectMask]);

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
    if ((operation === "crop" || operation === "object-edit") && multiMode && !running) {
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
    if (operation !== "object-edit") return;
    const stage = objectStageRef.current;
    if (!stage) return;
    const update = () => {
      const rect = stage.getBoundingClientRect();
      setObjectStageSize({ width: rect.width, height: rect.height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [inputPreview, operation]);

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

  const resolveVectorDestination = useCallback(async (filename: string): Promise<string> => {
    if (!outputDirectory) throw new Error("保存先フォルダを選択してください。");
    return invoke<string>("resolve_output_path_command", {
      directory: outputDirectory,
      filename,
      format: "svg",
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
      vectorPreset: operation === "vectorize" ? vectorPreset : null,
      vectorDetail: operation === "vectorize" ? vectorDetail : null,
      vectorMaxColors: operation === "vectorize" && vectorPreset !== "line-art" ? vectorMaxColors : null,
      vectorThreshold: null,
      objectAction: operation === "object-edit" ? objectAction : null,
      objectSelection: operation === "object-edit" ? currentObjectSelection : null,
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
  }, [cropX, cropY, cropZoom, currentObjectSelection, customTargetBytes, modelId, objectAction, operation, scale, srMode, targetHeight, targetWidth, vectorDetail, vectorMaxColors, vectorPreset]);

  const start = async () => {
    if (running || (operation !== "vectorize" && selectedFormats.length === 0)) return;
    if (operation === "remove-bg" && !backgroundRuntime?.installed) {
      setError("FeyNoBg runtimeを先にインストールしてください。");
      return;
    }
    if (operation === "object-edit") {
      if (!objectRuntime?.installed) {
        setError("Object Edit runtimeを先にインストールしてください。");
        return;
      }
      if (currentObjectSelection.points.length === 0 && !currentObjectSelection.boxPrompt) {
        setError("画像上をクリックするかBoxで対象物を選択してください。");
        return;
      }
    }
    const runFormats: OutputFormat[] = operation === "vectorize"
      ? ["png"]
      : operation === "remove-bg"
        ? selectedFormats.filter((format) => format === "png" || format === "webp")
        : operation === "object-edit"
          ? selectedFormats.filter((format) => objectAction === "remove-and-fill"
              ? format === "png" || format === "webp" || format === "jpeg"
              : format === "png" || format === "webp")
          : selectedFormats;
    if (runFormats.length === 0) return;
    setError("");
    setResult(null);
    setOutputResults([]);
    setComparisonOutputs([]);
    setComparisonFormat(runFormats[0] ?? "png");
    setOutputPreview("");

    if (!multiMode) {
      if (!inputPath || !outputDirectory || !outputName.trim()) return;
      const failures: string[] = [];
      for (const targetFormat of runFormats) {
        try {
          const destination = operation === "vectorize"
            ? await resolveVectorDestination(withSvgExtension(outputName))
            : await resolveDestination(outputNameForFormat(outputName, targetFormat, runFormats.length > 1), targetFormat);
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
      for (const targetFormat of runFormats) {
        if (cancelBatchRef.current) {
          pathState = "cancelled";
          break;
        }
        try {
          const destination = operation === "vectorize"
            ? await resolveVectorDestination(outputNameFor(path, operation, targetFormat, true))
            : await resolveDestination(outputNameForFormat(outputNameFor(path, operation, targetFormat, true), targetFormat, runFormats.length > 1), targetFormat);
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

  const qualityNote = operation === "vectorize"
    ? "本物のSVG pathへ変換します。ロゴ・アイコン・線画・フラットイラスト向け。写真や細かな質感主体の画像には非推奨です。"
    : operation === "remove-bg"
      ? "FeyNoBgで前景のalpha matteを推定し、元のピクセル寸法を保った透過画像を書き出します。PNG / WebPのみ対応します。"
    : operation === "object-edit"
      ? "SAM 2.1 Base+で任意物体をクリック選択し、maskを±/Featherで調整。透明化はSAMのみ、自然削除はLaMaで背景を復元します。"
    : operation === "crop" && customTargetBytes != null
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
    : operation === "vectorize"
      ? withSvgExtension(outputName)
      : (operation === "remove-bg"
        ? selectedFormats.filter((format) => format === "png" || format === "webp")
        : operation === "object-edit"
          ? selectedFormats.filter((format) => objectAction === "remove-and-fill"
              ? format === "png" || format === "webp" || format === "jpeg"
              : format === "png" || format === "webp")
          : selectedFormats)
          .map((targetFormat, _index, formats) => withExtension(outputNameForFormat(outputName, targetFormat, formats.length > 1), targetFormat)).join(" · ");

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

  const objectMediaStyle = useMemo(() => {
    if (!inputInfo || objectStageSize.width <= 0 || objectStageSize.height <= 0) return undefined;
    const padding = 28;
    const availableWidth = Math.max(1, objectStageSize.width - padding * 2);
    const availableHeight = Math.max(1, objectStageSize.height - padding * 2);
    const baseScale = Math.min(availableWidth / inputInfo.width, availableHeight / inputInfo.height);
    const width = inputInfo.width * baseScale;
    const height = inputInfo.height * baseScale;
    return {
      width: `${width}px`,
      height: `${height}px`,
      left: `${(objectStageSize.width - width) / 2}px`,
      top: `${(objectStageSize.height - height) / 2}px`,
      transform: `translate(${objectPan.x}px, ${objectPan.y}px) scale(${objectZoom})`,
    };
  }, [inputInfo, objectPan.x, objectPan.y, objectStageSize.height, objectStageSize.width, objectZoom]);

  const objectPointFromClient = useCallback((clientX: number, clientY: number) => {
    if (!inputInfo) return null;
    const rect = objectMediaRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null;
    return {
      x: clamp(((clientX - rect.left) / rect.width) * inputInfo.width, 0, Math.max(0, inputInfo.width - 1)),
      y: clamp(((clientY - rect.top) / rect.height) * inputInfo.height, 0, Math.max(0, inputInfo.height - 1)),
    };
  }, [inputInfo]);

  const handleObjectPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!inputInfo || !inputPreview || running || (event.button !== 0 && event.button !== 1)) return;
    const panRequested = objectTool === "pan" || event.button === 1;
    if (panRequested) {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      objectDragRef.current = {
        pointerId: event.pointerId,
        mode: "pan",
        startX: event.clientX,
        startY: event.clientY,
        basePanX: objectPan.x,
        basePanY: objectPan.y,
      };
      return;
    }
    const point = objectPointFromClient(event.clientX, event.clientY);
    if (!point) return;
    const boxRequested = objectTool === "box" || event.shiftKey;
    if (boxRequested) {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      objectDragRef.current = {
        pointerId: event.pointerId,
        mode: "box",
        startX: event.clientX,
        startY: event.clientY,
        basePanX: objectPan.x,
        basePanY: objectPan.y,
        startPoint: point,
      };
      setObjectBoxDraft({ x1: point.x, y1: point.y, x2: point.x + 1, y2: point.y + 1 });
      return;
    }
    pushObjectUndo();
    setObjectPoints((current) => [...current, {
      x: point.x,
      y: point.y,
      label: event.altKey || objectTool === "exclude" ? "exclude" : "include",
    }]);
  };

  const handleObjectPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = objectDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.mode === "pan") {
      setObjectPan({
        x: drag.basePanX + event.clientX - drag.startX,
        y: drag.basePanY + event.clientY - drag.startY,
      });
      return;
    }
    const point = objectPointFromClient(event.clientX, event.clientY);
    if (!point || !drag.startPoint) return;
    setObjectBoxDraft({
      x1: Math.min(drag.startPoint.x, point.x),
      y1: Math.min(drag.startPoint.y, point.y),
      x2: Math.max(drag.startPoint.x, point.x),
      y2: Math.max(drag.startPoint.y, point.y),
    });
  };

  const endObjectPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = objectDragRef.current;
    if (drag?.pointerId === event.pointerId && drag.mode === "box" && objectBoxDraft) {
      if (objectBoxDraft.x2 - objectBoxDraft.x1 >= 2 && objectBoxDraft.y2 - objectBoxDraft.y1 >= 2) {
        pushObjectUndo();
        setObjectBox(objectBoxDraft);
      }
      setObjectBoxDraft(null);
    }
    if (drag?.pointerId === event.pointerId) objectDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const clearObjectSelection = () => {
    if (objectPoints.length === 0 && !objectBox) return;
    pushObjectUndo();
    setObjectPoints([]);
    setObjectBox(null);
    setObjectBoxDraft(null);
    setObjectMaskPreview("");
    setObjectMaskScore(null);
  };

  const adjustObjectExpand = (delta: number) => {
    pushObjectUndo();
    setObjectExpand((value) => clamp(value + delta, -32, 32));
  };

  const handleObjectWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (!inputPreview || running) return;
    event.preventDefault();
    const zoomDelta = clamp(-event.deltaY * 0.0025, -0.18, 0.18);
    const nextZoom = clamp(objectZoom * (1 + zoomDelta), 1, 6);
    if (Math.abs(nextZoom - objectZoom) < 0.001) return;
    const stageRect = objectStageRef.current?.getBoundingClientRect();
    if (stageRect) {
      const centerX = stageRect.left + stageRect.width / 2;
      const centerY = stageRect.top + stageRect.height / 2;
      const ratio = nextZoom / objectZoom;
      setObjectPan((current) => ({
        x: current.x + (event.clientX - centerX - current.x) * (1 - ratio),
        y: current.y + (event.clientY - centerY - current.y) * (1 - ratio),
      }));
    }
    setObjectZoom(nextZoom);
  };

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
    if (operation === "object-edit") {
      setSelectedFormats([targetFormat]);
      return;
    }
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

  useEffect(() => {
    if (!settingsOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector('[data-shortcut-capture-active="true"]')) setSettingsOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [settingsOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (document.querySelector('[data-shortcut-capture-active="true"]')) return;
      const shortcuts = uiPreferences.shortcuts;
      if (matchesShortcut(event, shortcuts.settings)) {
        event.preventDefault();
        setSettingsOpen((value) => !value);
        return;
      }
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")) return;

      const directIndex = OPERATION_SHORTCUT_ACTIONS.findIndex((action) => matchesShortcut(event, shortcuts[action]));
      if (directIndex >= 0) {
        event.preventDefault();
        if (!running) setOperation(OPERATION_ORDER[directIndex]);
        return;
      }
      if (matchesShortcut(event, shortcuts.previousOperation) || matchesShortcut(event, shortcuts.nextOperation)) {
        event.preventDefault();
        if (running) return;
        const current = Math.max(0, OPERATION_ORDER.indexOf(operation));
        const delta = matchesShortcut(event, shortcuts.previousOperation) ? -1 : 1;
        setOperation(OPERATION_ORDER[(current + delta + OPERATION_ORDER.length) % OPERATION_ORDER.length]);
        return;
      }
      if (matchesShortcut(event, shortcuts.openImage)) {
        event.preventDefault();
        if (!running) void openImage();
        return;
      }
      if (matchesShortcut(event, shortcuts.run)) {
        event.preventDefault();
        if (!running) void start();
        return;
      }
      if (matchesShortcut(event, shortcuts.objectUndo) && operation === "object-edit" && objectUndoStackRef.current.length > 0) {
        event.preventDefault();
        undoObjectSelection();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openImage, operation, running, start, uiPreferences.shortcuts, undoObjectSelection]);

  return (
    <main className={`app-shell mode-${operation} ${dragActive ? "dragging" : ""}`}>
      {dragActive && (
        <div className="drag-overlay" aria-hidden="true">
          <div className="drag-overlay-card">
            <span>↘</span>
            <strong>{multiMode ? "画像を追加" : "画像を置き換え"}</strong>
            <small>{multiMode ? "複数枚をまとめてドロップできます" : "ウィンドウ内のどこでもドロップできます"}</small>
          </div>
        </div>
      )}

      {settingsOpen && createPortal(
        <div className="settings-backdrop" role="presentation" onMouseDown={() => setSettingsOpen(false)}>
          <section className="settings-dialog" role="dialog" aria-modal="true" aria-label="Agent-2D 設定" onMouseDown={(event) => event.stopPropagation()}>
            <header className="settings-header">
              <div>
                <span>SETTINGS</span>
                <strong>外観とショートカット</strong>
              </div>
              <button type="button" className="settings-close" onClick={() => setSettingsOpen(false)}>閉じる</button>
            </header>
            <div className="settings-scroll">
              <section className="settings-section">
                <div className="settings-section-head">
                  <div><strong>Theme</strong><small>作業内容は変えず、色・素材感・コントラストだけを切り替えます。</small></div>
                </div>
                <div className="theme-grid">
                  {THEME_OPTIONS.map((theme) => (
                    <button
                      key={theme.id}
                      type="button"
                      className={uiPreferences.theme === theme.id ? "active" : ""}
                      aria-pressed={uiPreferences.theme === theme.id}
                      onClick={() => setUiPreferences((current) => ({ ...current, theme: theme.id }))}
                    >
                      <span className="theme-swatches" aria-hidden="true">
                        {theme.swatches.map((color) => <i key={color} style={{ background: color }} />)}
                      </span>
                      <span className="theme-copy"><strong>{theme.name}</strong><small>{theme.detail}</small></span>
                    </button>
                  ))}
                </div>
              </section>
              <section className="settings-section">
                <div className="settings-section-head shortcut-head">
                  <div><strong>Keyboard Shortcuts</strong><small>キー欄を押して新しい組み合わせを入力。Delete / Backspaceで解除できます。</small></div>
                  <button type="button" onClick={() => setUiPreferences((current) => ({ ...current, shortcuts: { ...DEFAULT_SHORTCUTS } }))}>初期値へ戻す</button>
                </div>
                <div className="shortcut-list">
                  {SHORTCUT_ROWS.map((item) => (
                    <div className="shortcut-row" key={item.id}>
                      <div><strong>{item.label}</strong><small>{item.detail}</small></div>
                      <ShortcutCaptureButton value={uiPreferences.shortcuts[item.id]} label={item.label} onChange={(value) => assignShortcut(item.id, value)} />
                    </div>
                  ))}
                </div>
                <p className="shortcut-note">同じキーを別操作へ割り当てた場合は、以前の割り当てを自動で解除します。入力欄へ文字を入力中は、設定を開く操作以外のショートカットを無効化します。</p>
              </section>
            </div>
          </section>
        </div>,
        document.body,
      )}

      {runtimeChecked && !capabilities && (
        <div className="runtime-alert">
          <span>Real-ESRGAN runtime未導入</span>
          <button className="runtime-install" onClick={installManagedRuntime} disabled={installingRuntime}>
            {installingRuntime ? "Installing…" : "Install runtime"}
          </button>
        </div>
      )}

      <div className="app-navigation">
        <section className="mode-tabs" aria-label="Operation">
          {OPERATION_ORDER.map((item, index) => (
            <button key={item} className={operation === item ? "active" : ""} onClick={() => setOperation(item)} disabled={running} title={`${shortcutDisplay(uiPreferences.shortcuts[OPERATION_SHORTCUT_ACTIONS[index]])} · ${modeLabel(item)}`}>
              {modeLabel(item)}
              <small>{item === "enhance" ? "AI超解像" : item === "compress" ? "超圧縮・変換" : item === "optimize" ? "超解像 + 圧縮" : item === "crop" ? "サイズ・構図・容量" : item === "remove-bg" ? "AI背景透過" : item === "object-edit" ? "クリック選択・削除" : "SVG化 · イラスト/線画"}</small>
            </button>
          ))}
        </section>
        <button type="button" className="settings-trigger" onClick={() => setSettingsOpen(true)} aria-label="外観とショートカット設定">
          <strong>設定</strong>
          <small>{shortcutDisplay(uiPreferences.shortcuts.settings)}</small>
        </button>
      </div>

      <section className="workspace-grid">
        <aside className="control-panel">
          <div className="section-heading">
            <div className="section-label">SOURCE</div>
            <button className={`multi-toggle ${multiMode ? "active" : ""}`} onClick={toggleMultiMode} disabled={running || operation === "crop" || operation === "object-edit"} title={operation === "crop" ? "Custom は1枚ずつ構図を調整します" : operation === "object-edit" ? "Object Editは画像ごとに対象物を指定します" : undefined}>
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
                <div className="field-control">
                  <span>Width · px</span>
                  <NumberStepper value={targetWidth} onChange={(value) => setTargetWidth(Math.round(value))} min={1} max={32768} step={1} disabled={running} ariaLabel="出力幅" />
                </div>
                <div className="field-control">
                  <span>Height · px</span>
                  <NumberStepper value={targetHeight} onChange={(value) => setTargetHeight(Math.round(value))} min={1} max={32768} step={1} disabled={running} ariaLabel="出力高さ" />
                </div>
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
                  <div className="source-multiplier-input">
                    <NumberStepper
                      value={sourceSizeMultiplier}
                      onChange={(value) => setSourceSizeMultiplier(clamp(value, 0.1, maxSourceSizeMultiplier))}
                      min={0.1}
                      max={Number(maxSourceSizeMultiplier.toFixed(2))}
                      step={0.1}
                      disabled={running || !inputInfo}
                      ariaLabel="元画像サイズ倍率"
                      suffix="×"
                      onEnter={() => applySourceSizeMultiplier(sourceSizeMultiplier)}
                    />
                  </div>
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
                <SizePresetMenu
                  disabled={running}
                  presets={savedSizePresets}
                  onApply={setCropPreset}
                  onDelete={deleteSavedPreset}
                />
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
                    <NumberStepper value={sizeCapValue} onChange={setSizeCapValue} min={0.01} step={0.05} disabled={running} ariaLabel="最大ファイルサイズ" />
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

          {operation === "remove-bg" && (
            <>
              <div className="section-label">BACKGROUND REMOVAL</div>
              <div className={`background-removal-card ${backgroundRuntime?.installed ? "ready" : "missing"}`}>
                <div className="background-removal-head">
                  <div>
                    <strong>FeyNoBg · High Quality</strong>
                    <span>foreground segmentation + alpha matting · 1024 inference</span>
                  </div>
                  <span className="background-runtime-badge">
                    {!backgroundRuntimeChecked ? "Checking…" : backgroundRuntime?.installed ? "READY" : "NOT INSTALLED"}
                  </span>
                </div>
                <p>人物・商品・動物・細い輪郭までAIで前景を推定し、透明alphaとして出力します。元画像の縦横サイズは維持します。</p>
                {backgroundRuntime?.installed ? (
                  <div className="background-runtime-meta">
                    <span>{backgroundRuntime.modelId}</span>
                    <span>NoBg {backgroundRuntime.nobgVersion} · PyTorch {backgroundRuntime.torchVersion}</span>
                  </div>
                ) : (
                  <div className="background-runtime-install">
                    <span>初回のみ約1GBのモデルとPyTorch runtimeをApplication Supportへ取得します。通常処理は完全ローカルです。</span>
                    <button type="button" onClick={installBackgroundRuntime} disabled={running || installingBackgroundRuntime}>
                      {installingBackgroundRuntime ? "Installing FeyNoBg…" : "Install FeyNoBg"}
                    </button>
                  </div>
                )}
              </div>
            </>
          )}

          {operation === "object-edit" && (
            <>
              <div className="section-label">OBJECT EDIT</div>
              <div className={`object-runtime-card ${objectRuntime?.installed ? "ready" : "missing"}`}>
                <div className="object-runtime-head">
                  <div><strong>SAM 2.1 Base+ + LaMa</strong><span>click segmentation + local inpainting</span></div>
                  <span className="background-runtime-badge">{!objectRuntimeChecked ? "Checking…" : objectRuntimeWarming ? "WARMING…" : objectRuntime?.installed ? "READY" : "NOT INSTALLED"}</span>
                </div>
                {objectRuntime?.installed ? (
                  <details className="object-runtime-details">
                    <summary>技術情報</summary>
                    <div className="background-runtime-meta"><span>{objectRuntime.samModelId}</span><span>LaMa · shared PyTorch runtime</span></div>
                  </details>
                ) : (
                  <div className="background-runtime-install">
                    <span>初回のみSAM 2.1 Base+とBig-LaMaを取得。既存FeyNoBgのPyTorch runtimeを再利用します。</span>
                    <button type="button" onClick={installObjectRuntime} disabled={running || installingObjectRuntime}>{installingObjectRuntime ? "Installing…" : "Install Object Edit"}</button>
                  </div>
                )}
              </div>
              <div className="object-control-card">
                <div className="object-quick-guide">
                  <strong>{inputPath ? "対象をクリックして選択" : "まず画像を読み込む"}</strong>
                  <span>{inputPath ? `${shortcutDisplay(uiPreferences.shortcuts.objectUndo)}で戻す · ⌥クリックで除外 · ⇧ドラッグで範囲` : "SOURCEへドロップするか、画像選択ボタンから開始できます。"}</span>
                </div>
                {inputPath && <>
                <div className="object-mask-adjust">
                  <div><span>Mask範囲</span><strong>{objectExpand > 0 ? `+${objectExpand}` : objectExpand}px</strong></div>
                  <div className="crop-zoom-row">
                    <button type="button" onClick={() => adjustObjectExpand(-2)} disabled={running}>−</button>
                    <input type="range" min={-32} max={32} step={1} value={objectExpand} onPointerDown={pushObjectUndo} onChange={(event) => setObjectExpand(Number(event.target.value))} disabled={running} />
                    <button type="button" onClick={() => adjustObjectExpand(2)} disabled={running}>＋</button>
                  </div>
                </div>
                <label className="object-feather-field"><span>境界ぼかし <b>{objectFeather.toFixed(1)}px</b></span><input type="range" min={0} max={16} step={0.5} value={objectFeather} onPointerDown={pushObjectUndo} onChange={(event) => setObjectFeather(Number(event.target.value))} disabled={running} /></label>
                <div className="object-action-grid">
                  <button type="button" className={objectAction === "keep-selected" ? "active" : ""} onClick={() => setObjectAction("keep-selected")} disabled={running}>選択だけ残す<small>外側を透明化</small></button>
                  <button type="button" className={objectAction === "make-selected-transparent" ? "active" : ""} onClick={() => setObjectAction("make-selected-transparent")} disabled={running}>選択だけ透明化<small>対象物を抜く</small></button>
                  <button type="button" className={objectAction === "remove-and-fill" ? "active" : ""} onClick={() => setObjectAction("remove-and-fill")} disabled={running}>自然に削除<small>LaMaで背景復元</small></button>
                </div>
                <div className="object-selection-meta">
                  <span>＋ {objectPoints.filter((point) => point.label === "include").length}</span>
                  <span>− {objectPoints.filter((point) => point.label === "exclude").length}</span>
                  <span>Box {objectBox ? "1" : "0"}</span>
                  <span title={objectMaskScore != null ? `SAM score ${objectMaskScore.toFixed(3)}` : undefined}>{objectMaskLoading ? "AI更新中… 続けてクリック可" : objectMaskPreview ? "選択済み" : "対象をクリック"}</span>
                  <button type="button" className="undo" onClick={undoObjectSelection} disabled={running || objectUndoDepth === 0}>↶ 戻す ⌘Z</button>
                  <button type="button" onClick={clearObjectSelection} disabled={running || (objectPoints.length === 0 && !objectBox)}>リセット</button>
                </div>
                </>}
              </div>
            </>
          )}

          {operation === "vectorize" && (
            <>
              <div className="section-label">VECTORIZE TO SVG</div>
              <div className="vectorize-card">
                <div className="field-row two vectorize-fields">
                  <label>
                    <span>Preset</span>
                    <select
                      value={vectorPreset}
                      onChange={(event) => {
                        const next = event.target.value as VectorPreset;
                        setVectorPreset(next);
                        if (next === "logo") setVectorMaxColors(8);
                        else if (next === "illustration") setVectorMaxColors(24);
                      }}
                      disabled={running}
                    >
                      <option value="illustration">Illustration · 推奨</option>
                      <option value="logo">Logo / Icon</option>
                      <option value="line-art">Line Art</option>
                    </select>
                  </label>
                  <label>
                    <span>Detail</span>
                    <select value={vectorDetail} onChange={(event) => setVectorDetail(event.target.value as VectorDetail)} disabled={running}>
                      <option value="clean">Clean · 少ないpath</option>
                      <option value="balanced">Balanced · 推奨</option>
                      <option value="detailed">Detailed · 細部優先</option>
                    </select>
                  </label>
                </div>
                {vectorPreset !== "line-art" && (
                  <div className="vector-color-field">
                    <span>最大色数</span>
                    <NumberStepper value={vectorMaxColors} onChange={(value) => setVectorMaxColors(Math.round(value))} min={2} max={64} step={1} disabled={running} ariaLabel="最大色数" />
                    <small>少ないほどロゴ的で軽量。多いほど元画像の色を残します。</small>
                  </div>
                )}
                <div className="vectorize-note">
                  <strong>Raster → real SVG paths</strong>
                  <span>ロゴ・アイコン・線画・フラットイラスト向け。埋め込み画像ではなくベクターpathを生成します。</span>
                  <span className="vectorize-warning">写真・複雑な自然画像・微細な質感が主役の素材には非推奨です。</span>
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

          {operation !== "vectorize" && (
            <>
              <div className="section-label">OUTPUT FORMATS</div>
              <div className={`format-selector ${operation === "remove-bg" || operation === "object-edit" ? "alpha-only" : ""}`} role="group" aria-label="出力形式を複数選択">
                {(operation === "remove-bg"
                  ? BACKGROUND_OUTPUT_FORMATS
                  : operation === "object-edit"
                    ? (objectAction === "remove-and-fill" ? OBJECT_FILL_OUTPUT_FORMATS : OBJECT_ALPHA_OUTPUT_FORMATS)
                    : OUTPUT_FORMATS).map((item) => {
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
            </>
          )}
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
            <code>{multiMode ? `各入力名 → ${operation === "vectorize" ? "SVG" : operation === "remove-bg" ? selectedFormats.filter((item) => item === "png" || item === "webp").map((item) => item.toUpperCase()).join(" + ") : selectedFormats.map((item) => item.toUpperCase()).join(" + ")} / 衝突時 _02, _03…` : visibleOutputName}</code>
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
              <div className="job-meta"><span>{etaText || "時間を計測中"}</span><span>{operation === "vectorize" ? `${vectorPreset} · ${vectorDetail} · SVG` : operation === "remove-bg" ? `FeyNoBg · ${selectedFormats.filter((item) => item === "png" || item === "webp").length} alpha format` : operation === "object-edit" ? `SAM2 · ${objectAction === "remove-and-fill" ? "LaMa fill" : "alpha edit"}` : operation === "crop" ? `${targetWidth}×${targetHeight}${customTargetBytes ? ` · ≤${bytes(customTargetBytes)}` : ""}` : scale === 1 && (operation === "enhance" || operation === "optimize") ? `SR skip · ${selectedFormats.length} format` : operation === "compress" ? `${selectedFormats.length} format` : `${scale}× · ${selectedFormats.length} format`}</span></div>
            </div>
          )}

          {error && <div className="error-box">{error}</div>}

          <div className="action-row">
            <button className="primary" onClick={start} disabled={running || objectMaskLoading || (operation !== "vectorize" && selectedFormats.length === 0) || (operation === "remove-bg" && !backgroundRuntime?.installed) || (operation === "object-edit" && (!objectRuntime?.installed || (objectPoints.length === 0 && !objectBox))) || (multiMode ? queue.length === 0 || !outputDirectory : !inputPath || !outputDirectory || !outputName.trim())}>
              {running ? "Processing…" : operation === "vectorize" ? (multiMode ? `Vectorize ${queue.length} images · SVG` : "Vectorize to SVG") : operation === "remove-bg" ? (multiMode ? `Remove BG ${queue.length} images` : "Remove Background") : operation === "object-edit" ? (objectAction === "remove-and-fill" ? "Remove & Fill" : objectAction === "keep-selected" ? "Keep Selected" : "Make Transparent") : multiMode ? `${modeLabel(operation)} ${queue.length} images · ${selectedFormats.length} formats` : `${modeLabel(operation)} · ${selectedFormats.length} format${selectedFormats.length > 1 ? "s" : ""}`}
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
          ) : operation === "object-edit" ? (
            <figure className="object-edit-card">
              <figcaption>
                <div><span className="before-label">{inputPreview ? "対象を選択" : "PREVIEW"}</span>{inputInfo && <b>{inputInfo.width}×{inputInfo.height}</b>}</div>
                <div className="object-view-controls">
                  <button type="button" onClick={() => setObjectZoom((value) => clamp(value - 0.2, 1, 6))} disabled={running || !inputPreview}>−</button>
                  <strong>{objectZoom.toFixed(1)}×</strong>
                  <button type="button" onClick={() => setObjectZoom((value) => clamp(value + 0.2, 1, 6))} disabled={running || !inputPreview}>＋</button>
                  <button type="button" onClick={() => { setObjectZoom(1); setObjectPan({ x: 0, y: 0 }); }} disabled={running || !inputPreview}>Fit</button>
                </div>
                <div title={objectMaskScore != null ? `SAM score ${objectMaskScore.toFixed(3)}` : undefined}><span className="after-label">{!inputPreview ? "画像未選択" : objectMaskLoading ? "選択中…" : objectMaskPreview ? "選択済み" : "クリックで選択"}</span></div>
              </figcaption>
              {inputPreview && (
                <div className="object-canvas-toolbar object-canvas-toolbar-docked" role="group" aria-label="Object selection tool">
                  <button type="button" title="対象に含める。通常クリックと同じです" className={objectTool === "include" ? "active include" : ""} onClick={() => setObjectTool("include")} disabled={running}>＋ 選択</button>
                  <button type="button" title="対象から除外。Option+クリックでも使えます" className={objectTool === "exclude" ? "active exclude" : ""} onClick={() => setObjectTool("exclude")} disabled={running}>− 除外</button>
                  <button type="button" title="矩形で大まかに指定。Shift+ドラッグでも使えます" className={objectTool === "box" ? "active" : ""} onClick={() => setObjectTool("box")} disabled={running}>□ 範囲</button>
                  <button type="button" title="ドラッグで表示位置を移動。マウス中ボタンでも移動できます" className={objectTool === "pan" ? "active" : ""} onClick={() => setObjectTool("pan")} disabled={running}>移動</button>
                  <i aria-hidden="true" />
                  <button type="button" className="utility" onClick={undoObjectSelection} disabled={running || objectUndoDepth === 0}>↶ 戻す</button>
                </div>
              )}
              <div
                ref={objectStageRef}
                className={`object-edit-stage tool-${objectTool}`}
                role="application"
                aria-label="Object selection preview. Use include, exclude, box, or pan tools."
                onPointerDown={handleObjectPointerDown}
                onPointerMove={handleObjectPointerMove}
                onPointerUp={endObjectPointer}
                onPointerCancel={endObjectPointer}
                onWheel={handleObjectWheel}
              >
                {inputPreview && inputInfo && objectMediaStyle ? (
                  <div ref={objectMediaRef} className="object-media-frame" style={objectMediaStyle}>
                    <img src={inputPreview} alt="Object edit source" draggable={false} />
                    {objectMaskPreview && (
                      <div
                        className="object-mask-overlay"
                        style={{ WebkitMaskImage: `url(${objectMaskPreview})`, maskImage: `url(${objectMaskPreview})` }}
                        aria-hidden="true"
                      />
                    )}
                    {objectPoints.map((point, index) => (
                      <i
                        key={`${point.label}-${index}-${point.x}-${point.y}`}
                        className={`object-prompt-point ${point.label}`}
                        style={{ left: `${(point.x / inputInfo.width) * 100}%`, top: `${(point.y / inputInfo.height) * 100}%`, transform: `scale(${1 / objectZoom})` }}
                        aria-hidden="true"
                      >{point.label === "include" ? "+" : "−"}</i>
                    ))}
                    {(objectBoxDraft ?? objectBox) && (() => {
                      const box = (objectBoxDraft ?? objectBox)!;
                      return <i className="object-prompt-box" style={{
                        left: `${(box.x1 / inputInfo.width) * 100}%`,
                        top: `${(box.y1 / inputInfo.height) * 100}%`,
                        width: `${((box.x2 - box.x1) / inputInfo.width) * 100}%`,
                        height: `${((box.y2 - box.y1) / inputInfo.height) * 100}%`,
                        borderWidth: `${2 / objectZoom}px`,
                      }} aria-hidden="true" />;
                    })()}
                  </div>
                ) : (
                  <div className="canvas-empty-state" onPointerDown={(event) => event.stopPropagation()}>
                    <span className="canvas-empty-mark" aria-hidden="true">＋</span>
                    <strong>画像を読み込んでください</strong>
                    <small>左のSOURCEへドロップ、またはここから選択できます。</small>
                    <button type="button" onClick={(event) => { event.stopPropagation(); void openImage(); }} disabled={running}>画像を選択</button>
                  </div>
                )}
                {objectMaskLoading && <div className="object-mask-loading">SAM 2.1 selecting…</div>}
              </div>
              {inputPreview && (
                <div className="object-helpbar">
                  <span>クリック 選択 · ⌥ 除外 · ⇧ドラッグ 範囲 · {shortcutDisplay(uiPreferences.shortcuts.objectUndo)} 戻す</span>
                  <span>Wheel Zoom · 中ドラッグ 移動</span>
                  {displayOutputPreview && <span className="object-result-ready">処理結果あり · {objectAction === "remove-and-fill" ? "背景補完" : "透明化"}</span>}
                </div>
              )}
              {displayOutputPreview && (
                <div className="object-result-preview">
                  <span>RESULT</span>
                  <img src={displayOutputPreview} alt="Object edit result" />
                </div>
              )}
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

          {displayResult && (
            <div className="result-strip">
              <div><span>INPUT</span><strong>{bytes(displayResult.inputBytes)}</strong></div>
              <div><span>OUTPUT</span><strong>{bytes(displayResult.outputBytes)}</strong></div>
              <div><span>SIZE CHANGE</span><strong>{savings == null ? "—" : `${savings >= 0 ? "−" : "+"}${Math.abs(savings).toFixed(1)}%`}</strong></div>
              <div><span>TIME</span><strong>{`${(displayResult.elapsedMs / 1000).toFixed(2)}s`}</strong></div>
              <div><span>VERIFY</span><strong>{displayResult.pixelExact === true ? "PIXEL EXACT" : "PASS"}</strong></div>
            </div>
          )}

          {displayResult?.warnings?.length ? (
            <div className="warning-row">{displayResult.warnings.map((warning) => <span key={warning}>{warning.replaceAll("_", " ")}</span>)}</div>
          ) : null}
        </section>
      </section>
    </main>
  );
}
