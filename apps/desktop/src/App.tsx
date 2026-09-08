import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type WheelEvent as ReactWheelEvent } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
const SUPPORTED_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "avif", "jxl", "tif", "tiff", "bmp"]);

type QueueState = "pending" | "running" | "completed" | "failed" | "cancelled";
type VectorPreset = "illustration" | "logo" | "line-art";
type VectorDetail = "clean" | "balanced" | "detailed";
type ObjectTool = "include" | "exclude" | "box" | "pan";
type NavOperation = "enhance" | "compress" | "optimize" | "crop" | "cutout" | "vectorize";
type CutoutMode = "auto" | "object";
type SrContentPreset = "general" | "photo" | "illustration" | "ai-art" | "graphics";
type AppTheme = "lumiere" | "sorbet" | "linen" | "petale" | "versailles" | "nocturne" | "cosmos" | "graphite";
type AppLanguage = "system" | "ja" | "en";
type ResolvedLanguage = Exclude<AppLanguage, "system">;
type ShortcutAction = "operation1" | "operation2" | "operation3" | "operation4" | "operation5" | "operation6" | "previousOperation" | "nextOperation" | "openImage" | "run" | "objectUndo" | "settings";
type ShortcutMap = Record<ShortcutAction, string>;
type OutputNamingTemplates = Record<Operation, string>;
type UiPreferences = {
  theme: AppTheme;
  language: AppLanguage;
  shortcuts: ShortcutMap;
  formatVisibility: Record<OutputFormat, boolean>;
  outputNaming: OutputNamingTemplates;
  outputAliasEnabled: boolean;
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
const NAV_OPERATION_ORDER: NavOperation[] = ["enhance", "compress", "optimize", "crop", "cutout", "vectorize"];
const OPERATION_SHORTCUT_ACTIONS: ShortcutAction[] = ["operation1", "operation2", "operation3", "operation4", "operation5", "operation6"];
const DEFAULT_SHORTCUTS: ShortcutMap = {
  operation1: "Meta+Digit1",
  operation2: "Meta+Digit2",
  operation3: "Meta+Digit3",
  operation4: "Meta+Digit4",
  operation5: "Meta+Digit5",
  operation6: "Meta+Digit6",
  previousOperation: "Meta+BracketLeft",
  nextOperation: "Meta+BracketRight",
  openImage: "Meta+KeyO",
  run: "Meta+Enter",
  objectUndo: "Meta+KeyZ",
  settings: "Meta+Comma",
};
const THEME_OPTIONS: Array<{ id: AppTheme; name: string; detailJa: string; detailEn: string; swatches: [string, string, string] }> = [
  { id: "lumiere", name: "Lumière", detailJa: "明るく端正", detailEn: "Bright and refined", swatches: ["#f7f9fc", "#ffffff", "#3e66b5"] },
  { id: "sorbet", name: "Sorbet", detailJa: "POPで軽やか", detailEn: "Playful and airy", swatches: ["#fff4f7", "#ffdbe6", "#bc4d70"] },
  { id: "linen", name: "Linen", detailJa: "やさしい温もり", detailEn: "Soft and warm", swatches: ["#f5efe5", "#fffaf2", "#56705a"] },
  { id: "petale", name: "Pétale", detailJa: "可憐で柔らかい", detailEn: "Delicate and gentle", swatches: ["#fff7fa", "#f7dfe9", "#b6557c"] },
  { id: "versailles", name: "Versailles", detailJa: "古典と品格", detailEn: "Classical elegance", swatches: ["#f2eadb", "#203858", "#7a5e25"] },
  { id: "nocturne", name: "Nocturne", detailJa: "落ち着いたダーク", detailEn: "Calm dark", swatches: ["#080b12", "#111a28", "#5e91d3"] },
  { id: "cosmos", name: "Cosmos", detailJa: "深宇宙と発光", detailEn: "Deep space glow", swatches: ["#050713", "#101735", "#8a78ff"] },
  { id: "graphite", name: "Graphite", detailJa: "無彩色ミニマル", detailEn: "Neutral minimal", swatches: ["#111315", "#1c1f23", "#98a3b2"] },
];
const LANGUAGE_OPTIONS: Array<{ id: AppLanguage; label: string; detailJa: string; detailEn: string }> = [
  { id: "system", label: "System", detailJa: "macOSの言語に合わせる", detailEn: "Follow macOS language" },
  { id: "ja", label: "日本語", detailJa: "日本語で表示", detailEn: "Display in Japanese" },
  { id: "en", label: "English", detailJa: "英語で表示", detailEn: "Display in English" },
];
const UI_COPY = {
  ja: {
    settingsTitle: "設定",
    settingsSubtitle: "外観・言語・出力・命名・ショートカット",
    language: "言語",
    languageDetail: "Systemを選ぶとmacOSの表示言語に合わせます。",
    theme: "Theme",
    themeDetail: "作業内容は変えず、色・素材感・コントラストだけを切り替えます。",
    outputFormats: "出力形式",
    outputFormatsDetail: "通常画面に表示する形式を選べます。主要5形式は初期表示、TIFF / BMPは必要なときだけ有効にできます。",
    outputNaming: "Output Naming",
    outputNamingDetail: "モードごとの自動ファイル名を編集できます。拡張子と複数形式の -png / -jpg 等は自動付与します。",
    outputAlias: "生成画像エイリアス",
    outputAliasDetail: "ONにすると、保存完了後に元画像を複製せず /Users/naomac/Pictures/Agent-2D へ軽量リンクを自動作成します。",
    shortcuts: "Keyboard Shortcuts",
    shortcutsDetail: "キー欄を押して新しい組み合わせを入力。Delete / Backspaceで解除できます。",
    reset: "初期値へ戻す",
    close: "閉じる",
    single: "1枚",
    multiple: "複数選択",
    batchInput: "入力モード",
    loadImage: "画像を読み込んでください",
    loadImages: "複数画像を読み込んでください",
    loadHint: "ここへドロップ、またはボタンから画像を選択できます。",
    loadHintMultiple: "複数画像をまとめてドロップ、またはボタンから選択できます。",
    selectImage: "画像を選択",
    selectImages: "複数画像を選択",
    clear: "クリア",
    imageNotSelected: "画像未選択",
    saveFolder: "保存先フォルダ",
    notSelected: "未選択",
    fileName: "ファイル名",
    finalName: "最終名",
    objectLoadFirst: "まず画像を読み込む",
    objectSelect: "対象をクリックして選択",
    selected: "選択済み",
    selectTarget: "対象をクリック",
    shortcutConflict: "同じキーを別操作へ割り当てた場合は、以前の割り当てを自動で解除します。入力欄へ文字を入力中は、設定を開く操作以外のショートカットを無効化します。",
  },
  en: {
    settingsTitle: "Settings",
    settingsSubtitle: "Appearance, language, output, naming & shortcuts",
    language: "Language",
    languageDetail: "System follows the display language configured in macOS.",
    theme: "Theme",
    themeDetail: "Change color, material feel and contrast without changing the workflow.",
    outputFormats: "Output Formats",
    outputFormatsDetail: "Choose which formats appear in the workspace. The five primary formats are visible by default; TIFF / BMP are optional.",
    outputNaming: "Output Naming",
    outputNamingDetail: "Edit the automatic filename template for each mode. Extensions and multi-format tags such as -png / -jpg are added automatically.",
    outputAlias: "Generated image aliases",
    outputAliasDetail: "When enabled, Agent-2D creates a lightweight link in /Users/naomac/Pictures/Agent-2D after each successful save without duplicating the image.",
    shortcuts: "Keyboard Shortcuts",
    shortcutsDetail: "Click a key field and press a new combination. Delete / Backspace clears it.",
    reset: "Reset defaults",
    close: "Close",
    single: "Single",
    multiple: "Multiple",
    batchInput: "Input mode",
    loadImage: "Load an image",
    loadImages: "Load multiple images",
    loadHint: "Drop an image here, or choose one with the button below.",
    loadHintMultiple: "Drop multiple images here, or choose them with the button below.",
    selectImage: "Choose image",
    selectImages: "Choose images",
    clear: "Clear",
    imageNotSelected: "No image selected",
    saveFolder: "Destination folder",
    notSelected: "Not selected",
    fileName: "File name",
    finalName: "Final name",
    objectLoadFirst: "Load an image first",
    objectSelect: "Click an object to select",
    selected: "Selected",
    selectTarget: "Click an object",
    shortcutConflict: "If the same shortcut is assigned twice, the previous assignment is cleared automatically. Most shortcuts are disabled while typing in a field.",
  },
} as const;
const OUTPUT_FORMATS: Array<{ id: OutputFormat; label: string; detail: string }> = [
  { id: "png", label: "PNG", detail: "Exact" },
  { id: "jpeg", label: "JPG", detail: "High Quality" },
  { id: "webp", label: "WebP", detail: "Lossless / Compact" },
  { id: "avif", label: "AVIF", detail: "Preserve / Compact" },
  { id: "jxl", label: "JXL", detail: "Lossless / Compact" },
  { id: "tiff", label: "TIFF", detail: "Lossless / Editing" },
  { id: "bmp", label: "BMP", detail: "Lossless / Legacy" },
];
const BACKGROUND_OUTPUT_FORMATS: Array<{ id: OutputFormat; label: string; detail: string }> = [
  { id: "png", label: "PNG", detail: "Transparent" },
  { id: "webp", label: "WebP", detail: "Transparent · Lossless" },
];
const OBJECT_ALPHA_OUTPUT_FORMATS: Array<{ id: OutputFormat; label: string; detail: string }> = [
  { id: "png", label: "PNG", detail: "Transparent" },
  { id: "webp", label: "WebP", detail: "Transparent · Lossless" },
];
const DEFAULT_FORMAT_VISIBILITY: Record<OutputFormat, boolean> = {
  png: true,
  jpeg: true,
  webp: true,
  avif: true,
  jxl: true,
  tiff: false,
  bmp: false,
};
const DEFAULT_OUTPUT_NAMING: OutputNamingTemplates = {
  enhance: "{name}-agent2d-enhanced",
  compress: "{name}-agent2d-compressed",
  optimize: "{name}-agent2d-optimized",
  crop: "{name}-agent2d-custom",
  resize: "{name}-agent2d-resized",
  vectorize: "{name}-agent2d-vectorized",
  "remove-bg": "{name}-agent2d-transparent",
  "object-edit": "{name}-agent2d-object-edit",
};
const OUTPUT_NAMING_ROWS: Array<{ id: Operation; label: string; detailJa: string; detailEn: string }> = [
  { id: "enhance", label: "Enhance", detailJa: "AI / Crisp超解像", detailEn: "AI / Crisp upscale" },
  { id: "compress", label: "Compress", detailJa: "圧縮・変換", detailEn: "Compress / convert" },
  { id: "optimize", label: "Optimize", detailJa: "超解像 + 圧縮", detailEn: "Upscale + compress" },
  { id: "crop", label: "Custom · Crop", detailJa: "構図つきCustom出力", detailEn: "Custom framed output" },
  { id: "resize", label: "Custom · Resize", detailJa: "指定サイズ縮小", detailEn: "Resize to target" },
  { id: "remove-bg", label: "Cutout · Auto", detailJa: "FeyNoBg背景透過", detailEn: "FeyNoBg transparency" },
  { id: "object-edit", label: "Cutout · Object", detailJa: "SAM / LaMa編集", detailEn: "SAM / LaMa edit" },
  { id: "vectorize", label: "Vectorize", detailJa: "SVG化", detailEn: "SVG export" },
];
const SOURCE_SCALE_PRESETS = [
  { value: 0.125, label: "⅛×" },
  { value: 0.25, label: "¼×" },
  { value: 0.5, label: "½×" },
  { value: 1, label: "1×" },
  { value: 2, label: "2×" },
  { value: 4, label: "4×" },
] as const;

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

function isAppLanguage(value: unknown): value is AppLanguage {
  return value === "system" || value === "ja" || value === "en";
}

function resolveLanguage(language: AppLanguage): ResolvedLanguage {
  if (language !== "system") return language;
  return navigator.language.toLowerCase().startsWith("ja") ? "ja" : "en";
}

function shortcutRows(language: ResolvedLanguage): Array<{ id: ShortcutAction; label: string; detail: string }> {
  const ja = language === "ja";
  return [
    ...NAV_OPERATION_ORDER.map((operation, index) => ({ id: OPERATION_SHORTCUT_ACTIONS[index], label: `${index + 1}. ${navModeLabel(operation)}`, detail: ja ? "モードへ直接移動" : "Jump directly to this mode" })),
    { id: "previousOperation", label: ja ? "前のモード" : "Previous mode", detail: ja ? "左隣のタブへ移動" : "Move to the tab on the left" },
    { id: "nextOperation", label: ja ? "次のモード" : "Next mode", detail: ja ? "右隣のタブへ移動" : "Move to the tab on the right" },
    { id: "openImage", label: ja ? "画像を開く" : "Open image", detail: ja ? "ファイル選択を開く" : "Open the image picker" },
    { id: "run", label: ja ? "処理を実行" : "Run", detail: ja ? "現在の設定で開始" : "Start with the current settings" },
    { id: "objectUndo", label: ja ? "Object Editを戻す" : "Undo Object Edit", detail: ja ? "選択操作を1段階戻す" : "Undo one selection step" },
    { id: "settings", label: ja ? "設定を開く" : "Open Settings", detail: ja ? "Theme / Shortcut設定" : "Appearance / shortcut settings" },
  ];
}

function navModeLabel(operation: NavOperation): string {
  if (operation === "enhance") return "Enhance";
  if (operation === "compress") return "Compress";
  if (operation === "optimize") return "Optimize";
  if (operation === "crop") return "Custom";
  if (operation === "cutout") return "Cutout";
  return "Vectorize";
}

function operationSubtitle(operation: NavOperation, language: ResolvedLanguage): string {
  if (language === "en") {
    if (operation === "enhance") return "AI / crisp upscaling";
    if (operation === "compress") return "Compress & convert";
    if (operation === "optimize") return "Upscale + compress";
    if (operation === "crop") return "Size, crop & target";
    if (operation === "cutout") return "Auto BG / object edit";
    return "SVG · illustration / line art";
  }
  return operation === "enhance" ? "AI / くっきり超解像"
    : operation === "compress" ? "超圧縮・変換"
      : operation === "optimize" ? "超解像 + 圧縮"
        : operation === "crop" ? "サイズ・構図・容量"
          : operation === "cutout" ? "自動透過 / クリック編集"
            : "SVG化 · イラスト/線画";
}

function navOperationFor(operation: Operation): NavOperation {
  if (operation === "remove-bg" || operation === "object-edit") return "cutout";
  if (operation === "resize") return "crop";
  return operation;
}

function operationForNav(operation: NavOperation, cutoutMode: CutoutMode): Operation {
  return operation === "cutout" ? (cutoutMode === "auto" ? "remove-bg" : "object-edit") : operation;
}

function loadUiPreferences(): UiPreferences {
  const fallback: UiPreferences = {
    theme: "lumiere",
    language: "system",
    shortcuts: { ...DEFAULT_SHORTCUTS },
    formatVisibility: { ...DEFAULT_FORMAT_VISIBILITY },
    outputNaming: { ...DEFAULT_OUTPUT_NAMING },
    outputAliasEnabled: false,
  };
  try {
    const raw = window.localStorage.getItem(UI_PREFERENCES_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<UiPreferences>;
    const shortcuts = parsed.shortcuts && typeof parsed.shortcuts === "object"
      ? Object.fromEntries((Object.keys(DEFAULT_SHORTCUTS) as ShortcutAction[]).map((key) => [key, typeof parsed.shortcuts?.[key] === "string" ? parsed.shortcuts[key] : DEFAULT_SHORTCUTS[key]])) as ShortcutMap
      : { ...DEFAULT_SHORTCUTS };
    const formatVisibility = Object.fromEntries(
      OUTPUT_FORMATS.map(({ id }) => [id, typeof parsed.formatVisibility?.[id] === "boolean" ? parsed.formatVisibility[id] : DEFAULT_FORMAT_VISIBILITY[id]]),
    ) as Record<OutputFormat, boolean>;
    if (!Object.values(formatVisibility).some(Boolean)) formatVisibility.png = true;
    const outputNaming = Object.fromEntries(
      (Object.keys(DEFAULT_OUTPUT_NAMING) as Operation[]).map((operation) => {
        const saved = parsed.outputNaming?.[operation];
        return [operation, typeof saved === "string" && saved.trim() ? saved.slice(0, 180) : DEFAULT_OUTPUT_NAMING[operation]];
      }),
    ) as OutputNamingTemplates;
    return {
      theme: isAppTheme(parsed.theme) ? parsed.theme : fallback.theme,
      language: isAppLanguage(parsed.language) ? parsed.language : fallback.language,
      shortcuts,
      formatVisibility,
      outputNaming,
      outputAliasEnabled: parsed.outputAliasEnabled === true,
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

function shortcutDisplay(shortcut: string, language: ResolvedLanguage = "ja"): string {
  if (!shortcut) return language === "ja" ? "未設定" : "Unassigned";
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

function ShortcutCaptureButton({ value, label, language, onChange }: { value: string; label: string; language: ResolvedLanguage; onChange: (value: string) => void }) {
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
      aria-label={language === "ja" ? `${label}のショートカットを編集` : `Edit ${label} shortcut`}
      onClick={() => setRecording(true)}
    >
      {recording ? (language === "ja" ? "キー入力…" : "Press keys…") : (value ? shortcutDisplay(value) : language === "ja" ? "未設定" : "Unassigned")}
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
  if (format === "jxl") return "JXL Lossless";
  if (format === "tiff") return "TIFF Lossless";
  return "BMP Lossless";
}

type LocalizedHelp = { title: string; bodyJa: string; bodyEn: string; useJa: string; useEn: string };

const MODE_HELP: Record<SrMode, LocalizedHelp> = {
  fidelity: {
    title: "Fidelity",
    bodyJa: "原画像への忠実さを優先するrouting intentです。現行Real-ESRGANではModelを固定するとMode差は小さくなります。",
    bodyEn: "A routing intent that prioritizes fidelity to the source image. With the current Real-ESRGAN stack, Mode differences become smaller when a Model is fixed manually.",
    useJa: "写真・文字入り画像・過剰な質感追加を避けたいとき。",
    useEn: "Use for photos, images with text, and cases where you want to avoid invented texture.",
  },
  balanced: {
    title: "Balanced",
    bodyJa: "品質と自然さの中間を狙う標準routing intentです。迷った場合の初期値です。",
    bodyEn: "The standard routing intent balancing detail and naturalness. This is the default when you are unsure.",
    useJa: "一般写真、Web画像、AI画像など用途が混在するとき。",
    useEn: "Use for mixed workloads such as general photos, web images, and AI-generated images.",
  },
  perceptual: {
    title: "Perceptual",
    bodyJa: "見た目のディテール感を優先するためのrouting intentです。現行モデル群ではModel選択の影響の方が大きいです。",
    bodyEn: "A routing intent that favors perceived detail. With the current model set, the selected Model usually has a larger effect than this Mode.",
    useJa: "小さく柔らかい画像や、多少の推定ディテールを許容できるとき。",
    useEn: "Use for small or soft images when some inferred detail is acceptable.",
  },
};

function modelHelp(modelId: string): LocalizedHelp {
  if (!modelId) {
    return {
      title: "Auto route",
      bodyJa: "Modeと内蔵routing規則から利用可能なReal-ESRGANモデルを選びます。現在は保守的なroutingです。",
      bodyEn: "Selects an available Real-ESRGAN model from the chosen Mode and built-in routing rules. The current routing is intentionally conservative.",
      useJa: "モデル差を意識せず使いたいとき。まずはAuto + Balancedが基準です。",
      useEn: "Use when you do not want to manage model differences manually. Auto + Balanced is the baseline.",
    };
  }
  if (modelId.includes("x4plus-anime")) {
    return {
      title: "realesrgan-x4plus-anime",
      bodyJa: "アニメ・イラスト・輪郭線を持つ画像向けの公式Real-ESRGANモデルです。",
      bodyEn: "The official Real-ESRGAN model for anime, illustrations, and images with strong line work.",
      useJa: "アニメ絵、マンガ調、イラスト、線画主体の画像。",
      useEn: "Use for anime artwork, manga-style images, illustrations, and line art.",
    };
  }
  if (modelId.includes("animevideov3")) {
    return {
      title: "realesr-animevideov3",
      bodyJa: "アニメ映像系を想定した軽量寄りの公式モデルです。静止画にも利用できます。",
      bodyEn: "A lighter official model designed for anime video. It can also be used for still images.",
      useJa: "アニメ系で処理負荷を抑えたい場合や、連続フレーム由来の画像。",
      useEn: "Use for anime content when lower processing cost matters or for images derived from sequential frames.",
    };
  }
  return {
    title: modelId,
    bodyJa: "一般画像向けのReal-ESRGAN x4plus系モデルです。写真と混在コンテンツで基準になります。",
    bodyEn: "A Real-ESRGAN x4plus-family model for general imagery. It is the baseline for photos and mixed-content images.",
    useJa: "写真、Web素材、一般画像。迷って手動固定するならこの系統。",
    useEn: "Use for photos, web assets, and general images. If you want to pin a model manually, start here.",
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
  language = "ja",
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
  language?: ResolvedLanguage;
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
        <button type="button" onClick={() => onChange(normalize(value - step))} disabled={disabled || value <= min} aria-label={language === "ja" ? `${ariaLabel}を減らす` : `Decrease ${ariaLabel}`}>−</button>
        <button type="button" onClick={() => onChange(normalize(value + step))} disabled={disabled || (max != null && value >= max)} aria-label={language === "ja" ? `${ariaLabel}を増やす` : `Increase ${ariaLabel}`}>＋</button>
      </div>
    </div>
  );
}

function SizePresetMenu({
  disabled,
  presets,
  language,
  onApply,
  onDelete,
}: {
  disabled: boolean;
  presets: SavedSizePreset[];
  language: ResolvedLanguage;
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
        <button ref={buttonRef} type="button" onClick={() => setOpenState((value) => !value)} disabled={disabled} aria-expanded={openState}>{language === "ja" ? "サイズプリセット" : "Size presets"} ▾</button>
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
              <button type="button" className="saved-preset-delete" aria-label={language === "ja" ? `${preset.name}を削除` : `Delete ${preset.name}`} onClick={(event) => { event.stopPropagation(); onDelete(preset.id); }}>×</button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

function InfoHint({ title, language, children }: { title: string; language: ResolvedLanguage; children: ReactNode }) {
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
        aria-label={language === "ja" ? `${title}の説明` : `${title} information`}
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

function operationOutputSuffix(operation: Operation): string {
  if (operation === "enhance") return "enhanced";
  if (operation === "compress") return "compressed";
  if (operation === "crop") return "custom";
  if (operation === "resize") return "resized";
  if (operation === "vectorize") return "vectorized";
  if (operation === "remove-bg") return "transparent";
  if (operation === "object-edit") return "object-edit";
  return "optimized";
}

function outputNameFor(
  input: string,
  operation: Operation,
  format: OutputFormat,
  template: string,
  context: { scale: 1 | 2 | 4; targetWidth: number; targetHeight: number },
  batch = false,
): string {
  if (!input) return "";
  const file = basename(input);
  const dot = file.lastIndexOf(".");
  const sourceStem = dot > 0 ? file.slice(0, dot) : file;
  const sourceExt = dot > 0 ? file.slice(dot + 1).toLowerCase() : "image";
  const name = batch ? `${sourceStem}-${sourceExt}` : sourceStem;
  const fallback = DEFAULT_OUTPUT_NAMING[operation];
  const rendered = (template.trim() || fallback)
    .replaceAll("{name}", name)
    .replaceAll("{operation}", operationOutputSuffix(operation))
    .replaceAll("{scale}", `${context.scale}x`)
    .replaceAll("{width}", String(context.targetWidth))
    .replaceAll("{height}", String(context.targetHeight))
    .replaceAll("/", "-")
    .replaceAll("\0", "")
    .trim()
    .replace(/\.+$/, "");
  const stem = rendered || `${name}-agent2d-${operationOutputSuffix(operation)}`;
  const ext = operation === "vectorize" ? "svg" : format === "jpeg" ? "jpg" : format;
  return `${stem}.${ext}`;
}

function directoryOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash > 0 ? path.slice(0, slash) : "";
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

function stageLabel(stage: string | undefined, language: ResolvedLanguage): string {
  const ja = language === "ja";
  switch (stage) {
    case "queued": return ja ? "準備中" : "Preparing";
    case "super_resolution": return ja ? "AI超解像" : "AI upscaling";
    case "super_resolution_then_compression": return ja ? "AI超解像 → 圧縮" : "AI upscaling → compression";
    case "compression": return ja ? "圧縮 / 変換" : "Compression / conversion";
    case "conversion_only": return ja ? "解像度維持 / 変換" : "Keep resolution / convert";
    case "compression_conversion_only": return ja ? "解像度維持 / 圧縮・変換" : "Keep resolution / compress & convert";
    case "crop_to_size": return ja ? "Custom書き出し" : "Custom export";
    case "resize_to_size": return ja ? "指定サイズへ縮小" : "Resize to target";
    case "vectorize_svg": return ja ? "SVGベクター化" : "SVG vectorization";
    case "object_edit_sam2_lama": return "Object Edit · SAM2 / LaMa";
    case "background_removal_feynobg": return ja ? "FeyNoBg 背景透過" : "FeyNoBg background removal";
    case "completed": return ja ? "完了" : "Completed";
    case "cancelling": return ja ? "キャンセル中" : "Cancelling";
    case "cancelled": return ja ? "キャンセル済み" : "Cancelled";
    case "failed": return ja ? "失敗" : "Failed";
    default: return stage || (ja ? "処理中" : "Processing");
  }
}

function durationText(ms: number, language: ResolvedLanguage): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  if (seconds < 60) return language === "ja" ? `${seconds}秒` : `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return language === "ja"
    ? `${minutes}分${String(seconds % 60).padStart(2, "0")}秒`
    : `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
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

function sourceScaleLabel(value: number): string {
  const preset = SOURCE_SCALE_PRESETS.find((item) => Math.abs(item.value - value) < 0.0005);
  return preset?.label ?? `${Number(value.toFixed(3))}×`;
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
  const uiLanguage = resolveLanguage(uiPreferences.language);
  const copy = UI_COPY[uiLanguage];
  const tr = useCallback((ja: string, en: string) => (uiLanguage === "ja" ? ja : en), [uiLanguage]);
  const currentShortcutRows = useMemo(() => shortcutRows(uiLanguage), [uiLanguage]);
  const [operation, setOperation] = useState<Operation>("optimize");
  const [cutoutMode, setCutoutMode] = useState<CutoutMode>("auto");
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
  const [srPreset, setSrPreset] = useState<SrContentPreset>("general");
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
    document.documentElement.lang = uiLanguage;
    try {
      window.localStorage.setItem(UI_PREFERENCES_STORAGE_KEY, JSON.stringify(uiPreferences));
    } catch {
      // UI preferences are optional; image processing must stay usable.
    }
  }, [uiLanguage, uiPreferences]);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void listen("agent2d://open-settings", () => {
      if (active) setSettingsOpen(true);
    }).then((dispose) => {
      if (active) unlisten = dispose;
      else dispose();
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

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
  const activeNavOperation = navOperationFor(operation);
  const formatOptions = operation === "remove-bg"
    ? BACKGROUND_OUTPUT_FORMATS
    : operation === "object-edit"
      ? (objectAction === "remove-and-fill" ? OBJECT_FILL_OUTPUT_FORMATS : OBJECT_ALPHA_OUTPUT_FORMATS)
      : OUTPUT_FORMATS;
  const visibleFormatOptions = formatOptions.filter((item) => uiPreferences.formatVisibility[item.id]);
  const displayedFormatOptions = visibleFormatOptions.length > 0 ? visibleFormatOptions : formatOptions.slice(0, 1);
  const effectiveFormat: OutputFormat = selectedFormats[0] ?? displayedFormatOptions[0]?.id ?? "png";
  const activeComparison = comparisonOutputs.find((entry) => entry.format === comparisonFormat) ?? comparisonOutputs[0] ?? null;
  const displayResult = operation === "crop" ? result : activeComparison?.result ?? result;
  const displayOutputPreview = activeComparison?.preview ?? outputPreview;
  const customTargetBytes = operation === "crop" && sizeCapEnabled
    ? targetBytesFrom(sizeCapValue, sizeCapUnit)
    : null;
  const selectedModeHelp = MODE_HELP[srMode];
  const selectedModelHelp = modelHelp(modelId);
  const batchCapable = operation !== "crop" && operation !== "object-edit";
  const makeOutputName = useCallback((path: string, targetOperation: Operation, targetFormat: OutputFormat, batch = false) => (
    outputNameFor(
      path,
      targetOperation,
      targetFormat,
      uiPreferences.outputNaming[targetOperation],
      { scale, targetWidth, targetHeight },
      batch,
    )
  ), [scale, targetHeight, targetWidth, uiPreferences.outputNaming]);

  useEffect(() => {
    const allowed = new Set(displayedFormatOptions.map((item) => item.id));
    setSelectedFormats((current) => {
      const next = current.filter((format) => allowed.has(format));
      if (next.length > 0) return next;
      return displayedFormatOptions[0] ? [displayedFormatOptions[0].id] : ["png"];
    });
  }, [objectAction, operation, uiPreferences.formatVisibility]);

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
      setOutputName(makeOutputName(path, operation, effectiveFormat));
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
  }, [effectiveFormat, makeOutputName, operation]);

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
      setError(tr("対応画像は PNG / JPEG / WebP / AVIF / JXL / TIFF / BMP です。", "Supported images are PNG / JPEG / WebP / AVIF / JXL / TIFF / BMP."));
      return;
    }
    if (batchCapable && (valid.length > 1 || multiMode)) {
      setMultiMode(true);
      setQueue((current) => {
        const seed = current.length > 0
          ? current
          : inputPath
            ? [{ path: inputPath, state: "pending" as const }]
            : [];
        const known = new Set(seed.map((entry) => entry.path));
        const additions = valid
          .filter((path) => !known.has(path))
          .map((path) => ({ path, state: "pending" as const }));
        return [...seed, ...additions];
      });
    } else {
      setMultiMode(false);
      setQueue([]);
    }
    await loadInput(valid[0]);
  }, [batchCapable, inputPath, loadInput, multiMode, tr]);

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
      setOutputName(makeOutputName(inputPath, operation, effectiveFormat));
      setOutputPath("");
      setResult(null);
      setOutputResults([]);
      setComparisonOutputs([]);
      setComparisonFormat(effectiveFormat);
      setOutputPreview("");
      setComparePosition(50);
    }
  }, [effectiveFormat, inputPath, makeOutputName, operation, running]);

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
      multiple: batchCapable,
      directory: false,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "avif", "jxl", "tif", "tiff", "bmp"] }],
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
    if (!outputDirectory) throw new Error(tr("保存先フォルダを選択してください。", "Choose a destination folder."));
    return invoke<string>("resolve_output_path_command", {
      directory: outputDirectory,
      filename,
      format: targetFormat,
    });
  }, [outputDirectory, tr]);

  const resolveVectorDestination = useCallback(async (filename: string): Promise<string> => {
    if (!outputDirectory) throw new Error(tr("保存先フォルダを選択してください。", "Choose a destination folder."));
    return invoke<string>("resolve_output_path_command", {
      directory: outputDirectory,
      filename,
      format: "svg",
    });
  }, [outputDirectory, tr]);

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
      modelId: srPreset === "graphics" ? null : modelId || null,
      srPreset: operation === "enhance" || operation === "optimize" ? srPreset : null,
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
          if (uiPreferences.outputAliasEnabled) {
            try {
              await invoke<string>("create_output_alias_command", { outputPath: next.result.outputPath });
            } catch (cause) {
              setError(`${tr("画像は保存済みですが、エイリアス作成に失敗しました。", "The image was saved, but creating its alias failed.")} ${errorText(cause)}`);
            }
          }
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
  }, [cropX, cropY, cropZoom, currentObjectSelection, customTargetBytes, modelId, objectAction, operation, scale, srMode, srPreset, targetHeight, targetWidth, tr, uiPreferences.outputAliasEnabled, vectorDetail, vectorMaxColors, vectorPreset]);

  const start = async () => {
    if (running || (operation !== "vectorize" && selectedFormats.length === 0)) return;
    if (operation === "remove-bg" && !backgroundRuntime?.installed) {
      setError(tr("FeyNoBg runtimeを先にインストールしてください。", "Install the FeyNoBg runtime first."));
      return;
    }
    if (operation === "object-edit") {
      if (!objectRuntime?.installed) {
        setError(tr("Object Edit runtimeを先にインストールしてください。", "Install the Object Edit runtime first."));
        return;
      }
      if (currentObjectSelection.points.length === 0 && !currentObjectSelection.boxPrompt) {
        setError(tr("画像上をクリックするかBoxで対象物を選択してください。", "Select an object by clicking the image or drawing a box."));
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
          const batchName = makeOutputName(path, operation, targetFormat, true);
          const destination = operation === "vectorize"
            ? await resolveVectorDestination(batchName)
            : await resolveDestination(outputNameForFormat(batchName, targetFormat, runFormats.length > 1), targetFormat);
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

  const clearQueue = () => {
    if (running) return;
    setQueue([]);
    setMultiMode(false);
  };

  const removeQueueEntry = (path: string) => {
    if (running) return;
    const remaining = queue.filter((entry) => entry.path !== path);
    if (remaining.length <= 1) {
      setQueue([]);
      setMultiMode(false);
      if (remaining[0] && remaining[0].path !== inputPath) void loadInput(remaining[0].path);
      return;
    }
    setQueue(remaining);
  };

  const savings = useMemo(() => {
    if (!displayResult || displayResult.inputBytes <= 0) return null;
    return (1 - displayResult.outputBytes / displayResult.inputBytes) * 100;
  }, [displayResult]);

  const qualityNote = operation === "vectorize"
    ? tr("本物のSVG pathへ変換します。ロゴ・アイコン・線画・フラットイラスト向け。写真や細かな質感主体の画像には非推奨です。", "Converts raster input into real SVG paths. Best for logos, icons, line art, and flat illustrations; not recommended for photos or texture-heavy images.")
    : operation === "remove-bg"
      ? tr("FeyNoBgで前景のalpha matteを推定し、元のピクセル寸法を保った透過画像を書き出します。PNG / WebPのみ対応します。", "FeyNoBg estimates a foreground alpha matte and exports transparency while preserving the original pixel dimensions. PNG and WebP are supported.")
    : operation === "object-edit"
      ? tr("SAM 2.1 Base+で任意物体をクリック選択し、maskを±/Featherで調整。透明化はSAMのみ、自然削除はLaMaで背景を復元します。", "Select any object with SAM 2.1 Base+, then adjust the mask with expand/contract and feathering. Transparency uses the SAM mask; natural removal uses LaMa to reconstruct the background.")
    : (operation === "enhance" || operation === "optimize") && srPreset === "graphics" && scale > 1
      ? tr("Crisp Graphicsは写真向けAI補完を使わず、輪郭保持リサイズと軽いシャープ処理でロゴ/アイコンを拡大します。元にない模様を作らないことを優先します。", "Crisp Graphics bypasses photo-oriented AI and enlarges logos/icons with edge-preserving resize plus light sharpening, prioritizing source geometry over invented detail.")
      : operation === "crop" && customTargetBytes != null
        ? tr(`最大 ${bytes(customTargetBytes)} を優先して品質を自動調整します。PNGはExactで上限を満たせない場合、曖昧に劣化させず失敗として明示します。`, `Automatically adjusts quality to prioritize the ${bytes(customTargetBytes)} maximum. If exact PNG output cannot meet the limit, Agent-2D fails explicitly instead of silently degrading it.`)
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
    ? (uiLanguage === "ja" ? `所要 ${durationText(result.elapsedMs, uiLanguage)}` : `Elapsed ${durationText(result.elapsedMs, uiLanguage)}`)
    : backendRunning && jobTiming
      ? (uiLanguage === "ja" ? `残り 約${durationText(Math.max(0, adaptiveTotalMs - elapsedMs), uiLanguage)}` : `About ${durationText(Math.max(0, adaptiveTotalMs - elapsedMs), uiLanguage)} remaining`)
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
    setSourceSizeMultiplier(Number(multiplier.toFixed(3)));
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
        if (!running) setOperation(operationForNav(NAV_OPERATION_ORDER[directIndex], cutoutMode));
        return;
      }
      if (matchesShortcut(event, shortcuts.previousOperation) || matchesShortcut(event, shortcuts.nextOperation)) {
        event.preventDefault();
        if (running) return;
        const currentNav = navOperationFor(operation);
        const current = Math.max(0, NAV_OPERATION_ORDER.indexOf(currentNav));
        const delta = matchesShortcut(event, shortcuts.previousOperation) ? -1 : 1;
        const nextNav = NAV_OPERATION_ORDER[(current + delta + NAV_OPERATION_ORDER.length) % NAV_OPERATION_ORDER.length];
        setOperation(operationForNav(nextNav, cutoutMode));
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
  }, [cutoutMode, openImage, operation, running, start, uiPreferences.shortcuts, undoObjectSelection]);

  return (
    <main className={`app-shell mode-${operation} ${dragActive ? "dragging" : ""}`}>
      {dragActive && (
        <div className="drag-overlay" aria-hidden="true">
          <div className="drag-overlay-card">
            <span>↘</span>
            <strong>{tr("画像を読み込む", "Load images")}</strong>
            <small>{batchCapable ? tr("1枚なら単体、複数枚なら自動Batch。Batch中の追加ドロップもそのまま追加します。", "One image opens singly; multiple images automatically become a batch. Drops during a batch are appended.") : tr("このモードでは1枚の画像を読み込みます。", "This mode loads one image at a time.")}</small>
          </div>
        </div>
      )}

      {settingsOpen && createPortal(
        <div className="settings-backdrop" role="presentation" onMouseDown={() => setSettingsOpen(false)}>
          <section className="settings-dialog" role="dialog" aria-modal="true" aria-label={`Agent-2D ${copy.settingsTitle}`} onMouseDown={(event) => event.stopPropagation()}>
            <header className="settings-header">
              <div>
                <span>SETTINGS</span>
                <strong>{copy.settingsSubtitle}</strong>
              </div>
              <button type="button" className="settings-close" onClick={() => setSettingsOpen(false)}>{copy.close}</button>
            </header>
            <div className="settings-scroll">
              <section className="settings-section">
                <div className="settings-section-head">
                  <div><strong>{copy.language}</strong><small>{copy.languageDetail}</small></div>
                </div>
                <div className="language-grid" role="group" aria-label={copy.language}>
                  {LANGUAGE_OPTIONS.map((language) => (
                    <button
                      key={language.id}
                      type="button"
                      className={uiPreferences.language === language.id ? "active" : ""}
                      aria-pressed={uiPreferences.language === language.id}
                      onClick={() => setUiPreferences((current) => ({ ...current, language: language.id }))}
                    >
                      <strong>{language.label}</strong>
                      <small>{uiLanguage === "ja" ? language.detailJa : language.detailEn}</small>
                    </button>
                  ))}
                </div>
              </section>
              <section className="settings-section">
                <div className="settings-section-head">
                  <div><strong>{copy.theme}</strong><small>{copy.themeDetail}</small></div>
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
                      <span className="theme-copy"><strong>{theme.name}</strong><small>{uiLanguage === "ja" ? theme.detailJa : theme.detailEn}</small></span>
                    </button>
                  ))}
                </div>
              </section>
              <section className="settings-section">
                <div className="settings-section-head">
                  <div><strong>{copy.outputFormats}</strong><small>{copy.outputFormatsDetail}</small></div>
                </div>
                <div className="format-visibility-grid" role="group" aria-label={copy.outputFormats}>
                  {OUTPUT_FORMATS.map((format, index) => {
                    const active = uiPreferences.formatVisibility[format.id];
                    const visibleCount = Object.values(uiPreferences.formatVisibility).filter(Boolean).length;
                    return (
                      <button
                        key={format.id}
                        type="button"
                        className={active ? "active" : ""}
                        aria-pressed={active}
                        onClick={() => setUiPreferences((current) => {
                          if (current.formatVisibility[format.id] && Object.values(current.formatVisibility).filter(Boolean).length <= 1) return current;
                          return { ...current, formatVisibility: { ...current.formatVisibility, [format.id]: !current.formatVisibility[format.id] } };
                        })}
                      >
                        <span><strong>{format.label}</strong><small>{format.detail}</small></span>
                        <span className="format-visibility-state">{active ? tr("表示", "Shown") : tr("非表示", "Hidden")}</span>
                        {index >= 5 && <em>{tr("追加", "Optional")}</em>}
                        {active && visibleCount === 1 && <i aria-hidden="true">•</i>}
                      </button>
                    );
                  })}
                </div>
              </section>
              <section className="settings-section">
                <div className="settings-section-head shortcut-head">
                  <div><strong>{copy.outputNaming}</strong><small>{copy.outputNamingDetail}</small></div>
                  <button type="button" onClick={() => setUiPreferences((current) => ({ ...current, outputNaming: { ...DEFAULT_OUTPUT_NAMING } }))}>{copy.reset}</button>
                </div>
                <div className="naming-template-grid">
                  {OUTPUT_NAMING_ROWS.map((row) => (
                    <label className="naming-template-row" key={row.id}>
                      <span><strong>{row.label}</strong><small>{uiLanguage === "ja" ? row.detailJa : row.detailEn}</small></span>
                      <input
                        value={uiPreferences.outputNaming[row.id]}
                        onChange={(event) => setUiPreferences((current) => ({
                          ...current,
                          outputNaming: { ...current.outputNaming, [row.id]: event.target.value.slice(0, 180) },
                        }))}
                        placeholder={DEFAULT_OUTPUT_NAMING[row.id]}
                        spellCheck={false}
                      />
                    </label>
                  ))}
                </div>
                <p className="naming-template-note">{tr("使用可能: {name} / {operation} / {scale} / {width} / {height}。拡張子は入力不要です。複数画像では {name} に元拡張子を自動付加して衝突を減らします。", "Available: {name} / {operation} / {scale} / {width} / {height}. Do not type an extension. In batch mode, {name} automatically includes the source extension to reduce collisions.")}</p>
              </section>
              <section className="settings-section">
                <div className="settings-section-head">
                  <div><strong>{copy.outputAlias}</strong><small>{copy.outputAliasDetail}</small></div>
                </div>
                <div className={`settings-alias-row ${uiPreferences.outputAliasEnabled ? "active" : ""}`}>
                  <div><span>{tr("リンク保存先", "Link destination")}</span><code>/Users/naomac/Pictures/Agent-2D</code></div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={uiPreferences.outputAliasEnabled}
                    className={uiPreferences.outputAliasEnabled ? "active" : ""}
                    onClick={() => setUiPreferences((current) => ({ ...current, outputAliasEnabled: !current.outputAliasEnabled }))}
                  >{uiPreferences.outputAliasEnabled ? "ON" : "OFF"}</button>
                </div>
              </section>
              <section className="settings-section">
                <div className="settings-section-head shortcut-head">
                  <div><strong>{copy.shortcuts}</strong><small>{copy.shortcutsDetail}</small></div>
                  <button type="button" onClick={() => setUiPreferences((current) => ({ ...current, shortcuts: { ...DEFAULT_SHORTCUTS } }))}>{copy.reset}</button>
                </div>
                <div className="shortcut-list">
                  {currentShortcutRows.map((item) => (
                    <div className="shortcut-row" key={item.id}>
                      <div><strong>{item.label}</strong><small>{item.detail}</small></div>
                      <ShortcutCaptureButton value={uiPreferences.shortcuts[item.id]} label={item.label} language={uiLanguage} onChange={(value) => assignShortcut(item.id, value)} />
                    </div>
                  ))}
                </div>
                <p className="shortcut-note">{copy.shortcutConflict}</p>
              </section>
            </div>
          </section>
        </div>,
        document.body,
      )}

      {runtimeChecked && !capabilities && (operation === "enhance" || operation === "optimize") && srPreset !== "graphics" && (
        <div className="runtime-alert">
          <span>{tr("Real-ESRGAN runtime未導入", "Real-ESRGAN runtime is not installed")}</span>
          <button className="runtime-install" onClick={installManagedRuntime} disabled={installingRuntime}>
            {installingRuntime ? "Installing…" : "Install runtime"}
          </button>
        </div>
      )}

      <div className="app-navigation">
        <section className="mode-tabs" aria-label="Operation">
          {NAV_OPERATION_ORDER.map((item, index) => (
            <button key={item} className={activeNavOperation === item ? "active" : ""} onClick={() => setOperation(operationForNav(item, cutoutMode))} disabled={running} title={`${shortcutDisplay(uiPreferences.shortcuts[OPERATION_SHORTCUT_ACTIONS[index]], uiLanguage)} · ${navModeLabel(item)}`}>
              {navModeLabel(item)}
              <small>{operationSubtitle(item, uiLanguage)}</small>
            </button>
          ))}
        </section>
      </div>

      <section className="workspace-grid">
        <aside className="control-panel">
          {activeNavOperation === "cutout" && (
            <div className="cutout-mode-tabs" role="tablist" aria-label={tr("切り抜き方法", "Cutout method")}>
              <button type="button" role="tab" aria-selected={cutoutMode === "auto"} className={cutoutMode === "auto" ? "active" : ""} onClick={() => { setCutoutMode("auto"); setOperation("remove-bg"); }} disabled={running}>
                <strong>{tr("自動背景透過", "Auto Remove BG")}</strong><small>FeyNoBg</small>
              </button>
              <button type="button" role="tab" aria-selected={cutoutMode === "object"} className={cutoutMode === "object" ? "active" : ""} onClick={() => { setCutoutMode("object"); setOperation("object-edit"); }} disabled={running}>
                <strong>{tr("クリック選択・削除", "Object Edit")}</strong><small>SAM 2.1 + LaMa</small>
              </button>
            </div>
          )}
          {multiMode && queue.length > 0 && (
            <div className="queue-card">
              <div className="queue-head">
                <span>{queue.length} images</span>
                <button onClick={clearQueue} disabled={running}>{copy.clear}</button>
              </div>
              <div className="queue-list">
                {queue.map((entry, index) => (
                  <div key={entry.path} className={`queue-item ${entry.path === inputPath ? "selected" : ""}`}>
                    <button className="queue-select" onClick={() => void loadInput(entry.path)} disabled={running}>
                      <span className="queue-index">{String(index + 1).padStart(2, "0")}</span>
                      <span className="queue-name">{basename(entry.path)}</span>
                      <span className={`queue-status ${entry.state}`}>{entry.state}</span>
                    </button>
                    <button className="queue-remove" onClick={() => removeQueueEntry(entry.path)} disabled={running} aria-label={tr(`${basename(entry.path)}をキューから削除`, `Remove ${basename(entry.path)} from queue`)}>×</button>
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
                  <NumberStepper value={targetWidth} onChange={(value) => setTargetWidth(Math.round(value))} min={1} max={32768} step={1} disabled={running} ariaLabel={tr("出力幅", "Output width")} language={uiLanguage} />
                </div>
                <div className="field-control">
                  <span>Height · px</span>
                  <NumberStepper value={targetHeight} onChange={(value) => setTargetHeight(Math.round(value))} min={1} max={32768} step={1} disabled={running} ariaLabel={tr("出力高さ", "Output height")} language={uiLanguage} />
                </div>
              </div>
              <div className="source-size-tools">
                <button
                  type="button"
                  className="source-size-button"
                  onClick={() => applySourceSizeMultiplier(1)}
                  disabled={running || !inputInfo}
                >
                  {tr("元画像と同じ", "Match source")} {inputInfo ? `${inputInfo.width}×${inputInfo.height}` : ""}
                </button>
                <div className="source-multiplier-tools" aria-label={tr("元画像サイズ倍率", "Source-size multiplier")}>
                  <div className="source-scale-head"><span>{tr("倍率プリセット", "Scale presets")}</span><small>{tr("縮小から拡大まで元画像基準", "Relative to source size")}</small></div>
                  <div className="source-scale-presets">
                    {SOURCE_SCALE_PRESETS.map(({ value, label }) => (
                      <button
                        key={value}
                        type="button"
                        className={inputInfo
                          && targetWidth === Math.max(1, Math.round(inputInfo.width * value))
                          && targetHeight === Math.max(1, Math.round(inputInfo.height * value))
                          ? "active"
                          : ""}
                        onClick={() => applySourceSizeMultiplier(value)}
                        disabled={running || !inputInfo || value > maxSourceSizeMultiplier}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="source-custom-scale">
                    <span>Custom</span>
                    <div className="source-multiplier-input">
                      <NumberStepper
                        value={sourceSizeMultiplier}
                        onChange={(value) => setSourceSizeMultiplier(clamp(value, 0.1, maxSourceSizeMultiplier))}
                        min={0.1}
                        max={Number(maxSourceSizeMultiplier.toFixed(3))}
                        step={0.025}
                        disabled={running || !inputInfo}
                        ariaLabel={tr("カスタム元画像倍率", "Custom source-size multiplier")}
                        suffix="×"
                        language={uiLanguage}
                        onEnter={() => applySourceSizeMultiplier(sourceSizeMultiplier)}
                      />
                    </div>
                    <button type="button" onClick={() => applySourceSizeMultiplier(sourceSizeMultiplier)} disabled={running || !inputInfo}>{tr("適用", "Apply")}</button>
                  </div>
                </div>
                {inputInfo && (
                  <small className="source-size-preview">
                    {sourceScaleLabel(sourceSizeMultiplier)} → {Math.round(inputInfo.width * sourceSizeMultiplier)}×{Math.round(inputInfo.height * sourceSizeMultiplier)} px
                  </small>
                )}
              </div>
              <div className="size-toolbar custom-size-toolbar">
                <button type="button" onClick={() => { setTargetWidth(targetHeight); setTargetHeight(targetWidth); }} disabled={running}>↔ W/H</button>
                <SizePresetMenu
                  disabled={running}
                  presets={savedSizePresets}
                  language={uiLanguage}
                  onApply={setCropPreset}
                  onDelete={deleteSavedPreset}
                />
              </div>
              <div className="preset-save-row">
                <input value={presetName} onChange={(event) => setPresetName(event.target.value)} placeholder={tr(`名前（未入力なら ${targetWidth}×${targetHeight}）`, `Name (defaults to ${targetWidth}×${targetHeight})`)} disabled={running} />
                <button type="button" onClick={saveCurrentPreset} disabled={running}>{tr("サイズ保存", "Save size")}</button>
              </div>

              <div className={`size-cap-card ${sizeCapEnabled ? "active" : ""}`}>
                <label className="size-cap-toggle">
                  <input type="checkbox" checked={sizeCapEnabled} onChange={(event) => setSizeCapEnabled(event.target.checked)} disabled={running} />
                  <span>{tr("最大ファイルサイズを指定", "Set maximum file size")}</span>
                </label>
                {sizeCapEnabled && (
                  <div className="size-cap-fields">
                    <NumberStepper value={sizeCapValue} onChange={setSizeCapValue} min={0.01} step={0.05} disabled={running} ariaLabel={tr("最大ファイルサイズ", "Maximum file size")} language={uiLanguage} />
                    <select value={sizeCapUnit} onChange={(event) => setSizeCapUnit(event.target.value as "KB" | "MB")} disabled={running}>
                      <option value="KB">KB</option>
                      <option value="MB">MB</option>
                    </select>
                    <strong>≤ {bytes(customTargetBytes)}</strong>
                  </div>
                )}
                <p>{tr("サイズ上限を優先するため、JPG / WebP / AVIF / JXL は必要に応じて品質を下げます。PNGはExactで達成不能なら明示的に停止します。", "To prioritize the size limit, JPG / WebP / AVIF / JXL may reduce quality as needed. PNG stops with an explicit error if Exact output cannot meet the limit.")}</p>
              </div>

              <div className="crop-controls">
                <div className="crop-zoom-head"><span>Zoom</span><strong>{cropZoom.toFixed(2)}×</strong></div>
                <div className="crop-zoom-row">
                  <button type="button" onClick={() => setCropZoom((value) => clamp(value - 0.1, 1, 6))} disabled={running}>−</button>
                  <input type="range" min={1} max={6} step={0.01} value={cropZoom} onChange={(event) => setCropZoom(Number(event.target.value))} disabled={running} />
                  <button type="button" onClick={() => setCropZoom((value) => clamp(value + 0.1, 1, 6))} disabled={running}>＋</button>
                </div>
                <div className="nudge-area">
                  <span>{tr("位置", "Position")}</span>
                  <div className="nudge-pad">
                    <button type="button" className="up" onClick={() => adjustCrop(0, -0.04)} disabled={running}>↑</button>
                    <button type="button" className="left" onClick={() => adjustCrop(-0.04, 0)} disabled={running}>←</button>
                    <button type="button" className="center" onClick={() => { setCropX(0); setCropY(0); }} disabled={running}>●</button>
                    <button type="button" className="right" onClick={() => adjustCrop(0.04, 0)} disabled={running}>→</button>
                    <button type="button" className="down" onClick={() => adjustCrop(0, 0.04)} disabled={running}>↓</button>
                  </div>
                </div>
                <div className="crop-reset-row">
                  <button type="button" onClick={() => { setCropX(0); setCropY(0); }} disabled={running}>{tr("位置Reset", "Reset position")}</button>
                  <button type="button" onClick={() => setCropZoom(1)} disabled={running}>{tr("Zoom Reset", "Reset zoom")}</button>
                  <button type="button" onClick={() => { setCropZoom(1); setCropX(0); setCropY(0); }} disabled={running}>{tr("中央Fit", "Center fit")}</button>
                </div>
                <div className="transform-note compact">
                  <span>{tr("プレビューをドラッグ / ホイール / 矢印キーで調整。Shift+矢印は大きく、Option+矢印は細かく移動。", "Adjust the preview by dragging, using the wheel, or the arrow keys. Shift+Arrow moves farther; Option+Arrow moves precisely.")}</span>
                  {inputInfo && (inputInfo.width < targetWidth || inputInfo.height < targetHeight) && <span className="size-warning">{tr("指定サイズが元画像より大きいため、出力ではLanczos補間が入る場合があります。", "The target size is larger than the source, so Lanczos interpolation may be used in the output.")}</span>}
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
                <p>{tr("人物・商品・動物・細い輪郭までAIで前景を推定し、透明alphaとして出力します。元画像の縦横サイズは維持します。", "AI estimates the foreground for people, products, animals, and fine edges, then exports transparent alpha while preserving the source dimensions.")}</p>
                {backgroundRuntime?.installed ? (
                  <div className="background-runtime-meta">
                    <span>{backgroundRuntime.modelId}</span>
                    <span>NoBg {backgroundRuntime.nobgVersion} · PyTorch {backgroundRuntime.torchVersion}</span>
                  </div>
                ) : (
                  <div className="background-runtime-install">
                    <span>{tr("初回のみ約1GBのモデルとPyTorch runtimeをApplication Supportへ取得します。通常処理は完全ローカルです。", "On first use, Agent-2D downloads about 1 GB of model data and the PyTorch runtime into Application Support. Normal processing is fully local.")}</span>
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
                    <summary>{tr("技術情報", "Technical details")}</summary>
                    <div className="background-runtime-meta"><span>{objectRuntime.samModelId}</span><span>LaMa · shared PyTorch runtime</span></div>
                  </details>
                ) : (
                  <div className="background-runtime-install">
                    <span>{tr("初回のみSAM 2.1 Base+とBig-LaMaを取得。既存FeyNoBgのPyTorch runtimeを再利用します。", "On first use, Agent-2D downloads SAM 2.1 Base+ and Big-LaMa, reusing the existing FeyNoBg PyTorch runtime.")}</span>
                    <button type="button" onClick={installObjectRuntime} disabled={running || installingObjectRuntime}>{installingObjectRuntime ? "Installing…" : "Install Object Edit"}</button>
                  </div>
                )}
              </div>
              <div className="object-control-card">
                <div className="object-quick-guide">
                  <strong>{inputPath ? copy.objectSelect : copy.objectLoadFirst}</strong>
                  <span>{inputPath ? tr(`${shortcutDisplay(uiPreferences.shortcuts.objectUndo, uiLanguage)}で戻す · ⌥クリックで除外 · ⇧ドラッグで範囲`, `${shortcutDisplay(uiPreferences.shortcuts.objectUndo, uiLanguage)} undo · Option-click exclude · Shift-drag box`) : copy.loadHint}</span>
                </div>
                {inputPath && <>
                <div className="object-mask-adjust">
                  <div><span>{tr("Mask範囲", "Mask range")}</span><strong>{objectExpand > 0 ? `+${objectExpand}` : objectExpand}px</strong></div>
                  <div className="crop-zoom-row">
                    <button type="button" onClick={() => adjustObjectExpand(-2)} disabled={running}>−</button>
                    <input type="range" min={-32} max={32} step={1} value={objectExpand} onPointerDown={pushObjectUndo} onChange={(event) => setObjectExpand(Number(event.target.value))} disabled={running} />
                    <button type="button" onClick={() => adjustObjectExpand(2)} disabled={running}>＋</button>
                  </div>
                </div>
                <label className="object-feather-field"><span>{tr("境界ぼかし", "Edge feather")} <b>{objectFeather.toFixed(1)}px</b></span><input type="range" min={0} max={16} step={0.5} value={objectFeather} onPointerDown={pushObjectUndo} onChange={(event) => setObjectFeather(Number(event.target.value))} disabled={running} /></label>
                <div className="object-action-grid">
                  <button type="button" className={objectAction === "keep-selected" ? "active" : ""} onClick={() => setObjectAction("keep-selected")} disabled={running}>{tr("選択だけ残す", "Keep selection")}<small>{tr("外側を透明化", "Make outside transparent")}</small></button>
                  <button type="button" className={objectAction === "make-selected-transparent" ? "active" : ""} onClick={() => setObjectAction("make-selected-transparent")} disabled={running}>{tr("選択だけ透明化", "Make selection transparent")}<small>{tr("対象物を抜く", "Cut out the object")}</small></button>
                  <button type="button" className={objectAction === "remove-and-fill" ? "active" : ""} onClick={() => setObjectAction("remove-and-fill")} disabled={running}>{tr("自然に削除", "Remove naturally")}<small>{tr("LaMaで背景復元", "Reconstruct with LaMa")}</small></button>
                </div>
                <div className="object-selection-meta">
                  <span>＋ {objectPoints.filter((point) => point.label === "include").length}</span>
                  <span>− {objectPoints.filter((point) => point.label === "exclude").length}</span>
                  <span>Box {objectBox ? "1" : "0"}</span>
                  <span title={objectMaskScore != null ? `SAM score ${objectMaskScore.toFixed(3)}` : undefined}>{objectMaskLoading ? tr("AI更新中… 続けてクリック可", "AI updating… you can keep clicking") : objectMaskPreview ? copy.selected : copy.selectTarget}</span>
                  <button type="button" className="undo" onClick={undoObjectSelection} disabled={running || objectUndoDepth === 0}>↶ {tr("戻す", "Undo")} ⌘Z</button>
                  <button type="button" onClick={clearObjectSelection} disabled={running || (objectPoints.length === 0 && !objectBox)}>{tr("リセット", "Reset")}</button>
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
                      <option value="illustration">Illustration · {tr("推奨", "Recommended")}</option>
                      <option value="logo">Logo / Icon</option>
                      <option value="line-art">Line Art</option>
                    </select>
                  </label>
                  <label>
                    <span>Detail</span>
                    <select value={vectorDetail} onChange={(event) => setVectorDetail(event.target.value as VectorDetail)} disabled={running}>
                      <option value="clean">Clean · {tr("少ないpath", "fewer paths")}</option>
                      <option value="balanced">Balanced · {tr("推奨", "Recommended")}</option>
                      <option value="detailed">Detailed · {tr("細部優先", "more detail")}</option>
                    </select>
                  </label>
                </div>
                {vectorPreset !== "line-art" && (
                  <div className="vector-color-field">
                    <span>{tr("最大色数", "Maximum colors")}</span>
                    <NumberStepper value={vectorMaxColors} onChange={(value) => setVectorMaxColors(Math.round(value))} min={2} max={64} step={1} disabled={running} ariaLabel={tr("最大色数", "Maximum colors")} language={uiLanguage} />
                    <small>{tr("少ないほどロゴ的で軽量。多いほど元画像の色を残します。", "Fewer colors produce a lighter, logo-like result; more colors preserve more of the source palette.")}</small>
                  </div>
                )}
                <div className="vectorize-note">
                  <strong>Raster → real SVG paths</strong>
                  <span>{tr("ロゴ・アイコン・線画・フラットイラスト向け。埋め込み画像ではなくベクターpathを生成します。", "Designed for logos, icons, line art, and flat illustrations. It generates vector paths rather than embedding the raster image.")}</span>
                  <span className="vectorize-warning">{tr("写真・複雑な自然画像・微細な質感が主役の素材には非推奨です。", "Not recommended for photos, complex natural imagery, or assets dominated by fine texture.")}</span>
                </div>
              </div>
            </>
          )}

          {(operation === "enhance" || operation === "optimize") && (
            <>
              <div className="section-label">SUPER RESOLUTION</div>
              <div className={`sr-content-field ${srPreset === "graphics" ? "crisp" : ""}`}>
                <div className="field-title"><span>{tr("画像タイプ", "Content")}</span></div>
                <select value={srPreset} onChange={(event) => { const next = event.target.value as SrContentPreset; setSrPreset(next); if (next !== "general") setModelId(""); }} disabled={running || scale === 1}>
                  <option value="general">General · {tr("標準", "Standard")}</option>
                  <option value="photo">Photo</option>
                  <option value="illustration">Illustration</option>
                  <option value="ai-art">AI Art / CG</option>
                  <option value="graphics">Crisp Graphics · {tr("ロゴ/アイコン", "Logo / Icon")}</option>
                </select>
                {srPreset === "graphics" && <div className="crisp-graphics-note"><strong>Crisp Graphics</strong><span>{tr("写真向けAIを使わず、輪郭保持リサイズ+軽いシャープ処理で極小ロゴ/アイコンのモヤつきと架空ディテールを抑えます。", "Bypasses photo-oriented AI and uses edge-preserving resize + light sharpening to keep tiny logos/icons crisp without invented texture.")}</span></div>}
              </div>
              <div className="field-row two sr-mode-row">
                <div className="field-control">
                  <div className="field-title"><span>Scale</span></div>
                  <select value={scale} onChange={(event) => setScale(Number(event.target.value) as 1 | 2 | 4)} disabled={running}>
                    <option value={1}>1× · {tr("解像度維持", "Keep resolution")}</option>
                    <option value={2}>2× · {tr("推奨確認", "Recommended check")}</option>
                    <option value={4}>4× · {tr("最大拡大", "Maximum upscale")}</option>
                  </select>
                </div>
                <div className="field-control">
                  <div className="field-title">
                    <span>Mode</span>
                    <InfoHint title={tr("Mode · 処理方針の選び方", "Mode · Processing strategy")} language={uiLanguage}>
                      <p className="info-lead"><b>{tr("Modeは「処理の方針・優先順位」", "Mode defines the processing strategy and priority")}</b>{tr("です。Modelそのものではなく、Auto route時の選び方と仕上がり意図を指定します。", ". It does not change the model itself; it guides Auto route and the intended output character.")}</p>
                      <p>{tr(selectedModeHelp.bodyJa, selectedModeHelp.bodyEn)}</p>
                      <ul className="info-list">
                        <li><b>Fidelity</b><span>{tr("原画像優先。写真、文字、滑らかなCGで余計な再生成を抑えたい。", "Prioritizes the source. Useful for photos, text, and smooth CG when you want to suppress unnecessary regeneration.")}</span></li>
                        <li><b>Balanced · {tr("推奨", "Recommended")}</b><span>{tr("自然さとディテールの中間。迷ったらこれ。", "Balances naturalness and detail. Start here when unsure.")}</span></li>
                        <li><b>Perceptual</b><span>{tr("見た目の細部感寄り。柔らかい素材では効くが、再生成感も増えやすい。", "Favors perceived fine detail. It can help soft material, but can also increase the sense of regenerated texture.")}</span></li>
                      </ul>
                      <div className="info-callout"><b>{tr("用途例", "Examples")}</b><span>{tr("写真 → Fidelity / Balanced", "Photos → Fidelity / Balanced")}</span><span>{tr("宇宙・近未来CG / 発光ライン → FidelityまたはBalanced", "Space / sci-fi CG / glowing lines → Fidelity or Balanced")}</span><span>{tr("アニメ絵 → Balanced + anime系Model", "Anime artwork → Balanced + an anime Model")}</span></div>
                      <em>{tr("Speed専用Modeはありません。速度差は主にScaleとModelで決まり、軽さ重視なら animevideov3 が候補です。", "There is no speed-only Mode. Runtime is driven mainly by Scale and Model; animevideov3 is an option when lower processing cost matters.")}</em>
                    </InfoHint>
                  </div>
                  <select value={srMode} onChange={(event) => setSrMode(event.target.value as SrMode)} disabled={running || scale === 1 || srPreset === "graphics"}>
                    <option value="fidelity">Fidelity</option>
                    <option value="balanced">Balanced · {tr("推奨", "Recommended")}</option>
                    <option value="perceptual">Perceptual</option>
                  </select>
                </div>
              </div>
              {scale === 1 && <div className="scale-note">{tr("1×ではSR child processを起動せず、寸法を完全維持して変換 / 圧縮のみ行います。", "At 1×, Agent-2D skips the SR child process and only converts or compresses while preserving dimensions exactly.")}</div>}
              <div className="field-control field sr-model-field">
                <div className="field-title">
                  <span>Model</span>
                  <InfoHint title={tr("Model · 学習済みSRモデルの選び方", "Model · Choosing a trained SR model")} language={uiLanguage}>
                    <p className="info-lead"><b>{tr("Modelは「学習済みSRモデルそのもの」", "Model is the trained SR network itself")}</b>{tr("です。Modeよりも、画像ジャンルに対する得意・不得意へ直接効きます。", ". It affects strengths and weaknesses for image genres more directly than Mode.")}</p>
                    <p>{tr(selectedModelHelp.bodyJa, selectedModelHelp.bodyEn)}</p>
                    <ul className="info-list">
                      <li><b>Auto route · {tr("推奨", "Recommended")}</b><span>{tr("Modeと内蔵規則から保守的に選択。一般用途向け。特殊CGでは手動固定の方が読みやすい結果になる場合があります。", "Chooses conservatively from Mode and built-in rules. Good for general use; unusual CG may be more predictable with a manually pinned model.")}</span></li>
                      <li><b>realesrgan-x4plus</b><span>{tr("写真・一般画像・実写寄りCG。宇宙、霧、発光リム、滑らかなラインはまずこれ。", "Photos, general images, and realistic CG. Start here for space scenes, fog, glowing rims, and smooth lines.")}</span></li>
                      <li><b>realesrgan-x4plus-anime</b><span>{tr("アニメ、イラスト、線画。写真や実写寄りCGには不向き。", "Anime, illustrations, and line art. Not intended for photos or realistic CG.")}</span></li>
                      <li><b>realesr-animevideov3</b><span>{tr("アニメ映像寄りの軽量モデル。速度優先や連続フレーム向け。", "A lighter anime-video model for speed-oriented use and sequential frames.")}</span></li>
                    </ul>
                    <div className="info-callout accent"><b>{tr("宇宙 / 近未来CG", "Space / sci-fi CG")}</b><span>realesrgan-x4plus + Fidelity / Balanced</span><span>{tr("まず2×で確認し、必要な場合だけ4×。微細な星・霧・発光線は4×ほど再生成感が増えやすい。", "Check 2× first and use 4× only when needed. Tiny stars, fog, and glowing lines are more likely to look regenerated at 4×.")}</span></div>
                    <em>{tr("Auto routeで質感が抽象化する場合は、宇宙CGでは x4plus を手動固定してください。", "If Auto route abstracts the texture too much, manually pin x4plus for space CG.")}</em>
                  </InfoHint>
                </div>
                <select value={modelId} onChange={(event) => setModelId(event.target.value)} disabled={running || scale === 1 || srPreset === "graphics"}>
                  <option value="">Auto route · {tr("推奨", "Recommended")}</option>
                  {capabilities?.models.map((model) => <option key={model.id} value={model.id}>{model.id}</option>)}
                </select>
              </div>
            </>
          )}

          {operation !== "vectorize" && (
            <>
              <div className="section-label">OUTPUT FORMATS</div>
              <div className={`format-selector ${operation === "remove-bg" || operation === "object-edit" ? "alpha-only" : ""}`} role="group" aria-label={tr("出力形式を複数選択", "Select output formats")}>
                {displayedFormatOptions.map((item) => {
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
              <span>{copy.saveFolder}</span>
              <strong title={outputDirectory}>{outputDirectory || copy.notSelected}</strong>
            </div>
            <button onClick={chooseOutputDirectory} disabled={!inputPath || running}>Finder…</button>
          </div>
          <label className="field output-name-field">
            <span>{copy.fileName}</span>
            <input
              value={multiMode ? tr("入力名-agent2d-*（自動）", "input-name-agent2d-* (automatic)") : outputName}
              onChange={(event) => { setOutputName(event.target.value); setOutputPath(""); }}
              placeholder="image-agent2d-optimized"
              disabled={running || multiMode}
            />
          </label>
          <div className="output-preview-line">
            <span>{copy.finalName}</span>
            <code>{multiMode ? tr(`各入力名 → ${operation === "vectorize" ? "SVG" : operation === "remove-bg" ? selectedFormats.filter((item) => item === "png" || item === "webp").map((item) => item.toUpperCase()).join(" + ") : selectedFormats.map((item) => item.toUpperCase()).join(" + ")} / 衝突時 _02, _03…`, `Each input name → ${operation === "vectorize" ? "SVG" : operation === "remove-bg" ? selectedFormats.filter((item) => item === "png" || item === "webp").map((item) => item.toUpperCase()).join(" + ") : selectedFormats.map((item) => item.toUpperCase()).join(" + ")} / conflicts use _02, _03…`) : visibleOutputName}</code>
          </div>
          {outputPath && <div className="resolved-output" title={outputPath}>{tr("保存先", "Destination")}: {outputPath}</div>}
          {outputResults.length > 1 && (
            <div className="output-results-list">
              {outputResults.map((entry) => <span key={entry.outputPath}>{basename(entry.outputPath)} · {bytes(entry.outputBytes)}</span>)}
            </div>
          )}

          {job && (
            <div className={`job-card ${job.state}`}>
              <div className="job-line">
                <span>{batchRunning ? `batch · ${stageLabel(job.stage, uiLanguage)}` : stageLabel(job.stage, uiLanguage)}</span>
                <strong>{Math.round(progressFraction * 100)}%</strong>
              </div>
              <div className="progress-track"><div className="progress-fill" style={{ width: `${Math.max(4, progressFraction * 100)}%` }} /></div>
              <div className="job-meta"><span>{etaText || tr("時間を計測中", "Measuring time")}</span><span>{operation === "vectorize" ? `${vectorPreset} · ${vectorDetail} · SVG` : operation === "remove-bg" ? `FeyNoBg · ${selectedFormats.filter((item) => item === "png" || item === "webp").length} alpha format` : operation === "object-edit" ? `SAM2 · ${objectAction === "remove-and-fill" ? "LaMa fill" : "alpha edit"}` : operation === "crop" ? `${targetWidth}×${targetHeight}${customTargetBytes ? ` · ≤${bytes(customTargetBytes)}` : ""}` : scale === 1 && (operation === "enhance" || operation === "optimize") ? `SR skip · ${selectedFormats.length} format` : operation === "compress" ? `${selectedFormats.length} format` : `${scale}× · ${selectedFormats.length} format`}</span></div>
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
                {inputPreview ? (
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
                      if (running) return;
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
                    <img className="crop-image" src={inputPreview} alt="Crop source" style={cropImageStyle} draggable={false} />
                    <div className="crop-grid-overlay" aria-hidden="true"><i /><i /><i /><i /></div>
                    <div className="crop-edge-shade" aria-hidden="true" />
                  </div>
                ) : (
                  <div className="canvas-empty-state canvas-empty-state-static">
                    <span className="canvas-empty-mark" aria-hidden="true">＋</span>
                    <strong>{copy.loadImage}</strong>
                    <small>{copy.loadHint}</small>
                    <button type="button" onClick={() => void openImage()} disabled={running}>{copy.selectImage}</button>
                  </div>
                )}
              </div>
              <div className="crop-helpbar">
                <span>Drag · Wheel · ↑↓←→</span>
                <span>{tr("Shift = 大きく / Option = 細かく", "Shift = larger / Option = precise")}</span>
                <span>{tr("最小Zoomは空白が出ないCover", "Minimum zoom uses Cover to avoid empty areas")}</span>
              </div>
            </figure>
          ) : operation === "object-edit" ? (
            <figure className="object-edit-card">
              <figcaption>
                <div><span className="before-label">{inputPreview ? tr("対象を選択", "Select object") : "PREVIEW"}</span>{inputInfo && <b>{inputInfo.width}×{inputInfo.height}</b>}</div>
                <div className="object-view-controls">
                  <button type="button" onClick={() => setObjectZoom((value) => clamp(value - 0.2, 1, 6))} disabled={running || !inputPreview}>−</button>
                  <strong>{objectZoom.toFixed(1)}×</strong>
                  <button type="button" onClick={() => setObjectZoom((value) => clamp(value + 0.2, 1, 6))} disabled={running || !inputPreview}>＋</button>
                  <button type="button" onClick={() => { setObjectZoom(1); setObjectPan({ x: 0, y: 0 }); }} disabled={running || !inputPreview}>Fit</button>
                </div>
                <div title={objectMaskScore != null ? `SAM score ${objectMaskScore.toFixed(3)}` : undefined}><span className="after-label">{!inputPreview ? copy.imageNotSelected : objectMaskLoading ? tr("選択中…", "Selecting…") : objectMaskPreview ? copy.selected : copy.objectSelect}</span></div>
              </figcaption>
              {inputPreview && (
                <div className="object-canvas-toolbar object-canvas-toolbar-docked" role="group" aria-label="Object selection tool">
                  <button type="button" title={tr("対象に含める。通常クリックと同じです", "Include in selection. Same as a normal click.")} className={objectTool === "include" ? "active include" : ""} onClick={() => setObjectTool("include")} disabled={running}>＋ {tr("選択", "Include")}</button>
                  <button type="button" title={tr("対象から除外。Option+クリックでも使えます", "Exclude from selection. Option-click does the same.")} className={objectTool === "exclude" ? "active exclude" : ""} onClick={() => setObjectTool("exclude")} disabled={running}>− {tr("除外", "Exclude")}</button>
                  <button type="button" title={tr("矩形で大まかに指定。Shift+ドラッグでも使えます", "Select a rough rectangle. Shift-drag does the same.")} className={objectTool === "box" ? "active" : ""} onClick={() => setObjectTool("box")} disabled={running}>□ {tr("範囲", "Box")}</button>
                  <button type="button" title={tr("ドラッグで表示位置を移動。マウス中ボタンでも移動できます", "Drag to pan the view. Middle-button drag also works.")} className={objectTool === "pan" ? "active" : ""} onClick={() => setObjectTool("pan")} disabled={running}>{tr("移動", "Pan")}</button>
                  <i aria-hidden="true" />
                  <button type="button" className="utility" onClick={undoObjectSelection} disabled={running || objectUndoDepth === 0}>↶ {tr("戻す", "Undo")}</button>
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
                    <strong>{copy.loadImage}</strong>
                    <small>{copy.loadHint}</small>
                    <button type="button" onClick={(event) => { event.stopPropagation(); void openImage(); }} disabled={running}>{copy.selectImage}</button>
                  </div>
                )}
                {objectMaskLoading && <div className="object-mask-loading">SAM 2.1 selecting…</div>}
              </div>
              {inputPreview && (
                <div className="object-helpbar">
                  <span>{tr(`クリック 選択 · ⌥ 除外 · ⇧ドラッグ 範囲 · ${shortcutDisplay(uiPreferences.shortcuts.objectUndo, uiLanguage)} 戻す`, `Click include · ⌥ exclude · ⇧-drag box · ${shortcutDisplay(uiPreferences.shortcuts.objectUndo, uiLanguage)} undo`)}</span>
                  <span>{tr("Wheel Zoom · 中ドラッグ 移動", "Wheel zoom · middle-drag pan")}</span>
                  {displayOutputPreview && <span className="object-result-ready">{tr("処理結果あり", "Result ready")} · {objectAction === "remove-and-fill" ? tr("背景補完", "background filled") : tr("透明化", "transparency")}</span>}
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
              <div className="compare-help">{tr("← Afterを広く · drag · Beforeを広く →", "← More After · drag · More Before →")}</div>
              <div><span className="after-label">AFTER</span>{displayResult && <b>{displayResult.outputWidth}×{displayResult.outputHeight}</b>}</div>
            </figcaption>
            {comparisonOutputs.length > 1 && (
              <div className="compare-format-tabs" role="tablist" aria-label={tr("Before / After 出力形式", "Before / After output format")}>
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
                      aria-label={tr("Before / After 比較位置", "Before / After comparison position")}
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
                  {!displayOutputPreview && <div className="result-waiting">{tr("処理後、ここで重ね比較できます", "After processing, compare the two images here")}</div>}
                </>
              ) : (
                <div className="canvas-empty-state">
                  <span className="canvas-empty-mark" aria-hidden="true">＋</span>
                  <strong>{multiMode ? copy.loadImages : copy.loadImage}</strong>
                  <small>{multiMode ? copy.loadHintMultiple : copy.loadHint}</small>
                  <button type="button" onClick={() => void openImage()} disabled={running}>{multiMode ? copy.selectImages : copy.selectImage}</button>
                </div>
              )}
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
