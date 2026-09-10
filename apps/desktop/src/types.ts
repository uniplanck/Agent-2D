export type Operation = "enhance" | "restore" | "compress" | "optimize" | "crop" | "resize" | "vectorize" | "remove-bg" | "object-edit";
export type JobState = "queued" | "running" | "completed" | "failed" | "cancelled";
export type SrMode = "fidelity" | "balanced" | "perceptual";
export type CompressionMode = "exact" | "preserve" | "compact";
export type OutputFormat = "png" | "jpeg" | "webp" | "avif" | "jxl" | "tiff" | "bmp";

export interface ErrorPayload {
  code: string;
  message: string;
}

export interface InspectResult {
  jobId: string;
  inputPath: string;
  format: string;
  width: number;
  height: number;
  inputBytes: number;
  hasAlpha: boolean;
  bitDepth: number;
  colorType: string;
  warnings: string[];
}

export interface Agent2DResult {
  jobId: string;
  inputPath: string;
  outputPath: string;
  inputWidth: number;
  inputHeight: number;
  outputWidth: number;
  outputHeight: number;
  inputBytes: number;
  outputBytes: number;
  compressionRatio: number;
  modelId?: string | null;
  codec?: string | null;
  pixelExact?: boolean | null;
  elapsedMs: number;
  warnings: string[];
}

export type ObjectPointLabel = "include" | "exclude";
export type ObjectEditAction = "keep-selected" | "make-selected-transparent" | "remove-and-fill";
export type RestoreMode = "face" | "denoise" | "deblur";

export interface ObjectPoint {
  x: number;
  y: number;
  label: ObjectPointLabel;
}

export interface ObjectBoxPrompt {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface ObjectSelection {
  points: ObjectPoint[];
  boxPrompt?: ObjectBoxPrompt | null;
  expandPx: number;
  featherPx: number;
}

export interface ObjectSelectionResult {
  jobId: string;
  inputPath: string;
  outputMaskPath: string;
  width: number;
  height: number;
  score: number;
  modelId: string;
  elapsedMs: number;
  warnings: string[];
}

export interface ObjectMaskPreview {
  preview: string;
  score: number;
  width: number;
  height: number;
}

export interface ObjectEditRuntimeStatus {
  installed: boolean;
  managed: boolean;
  releaseId: string;
  root: string;
  pythonPath: string;
  runnerPath: string;
  modelCacheDir: string;
  lamaModelPath: string;
  samModelId: string;
  samModelRevision: string;
  lamaModelUrl: string;
  sharedPythonRuntime: boolean;
}

export interface RestorationRuntimeStatus {
  installed: boolean;
  managed: boolean;
  releaseId: string;
  root: string;
  pythonPath: string;
  runnerPath: string;
  sitePackagesPath: string;
  gfpganModelPath: string;
  nafnetDenoiseModelPath: string;
  nafnetDeblurModelPath: string;
  models: string[];
  sharedPythonRuntime: boolean;
  sizeBytes: number;
}

export interface DesktopJobRequest {
  operation: Operation;
  inputPath: string;
  outputPath: string;
  scale: 1 | 2 | 4;
  srMode: SrMode;
  compressionMode: CompressionMode;
  format: OutputFormat;
  modelId?: string | null;
  srPreset?: "general" | "photo" | "illustration" | "ai-art" | "graphics" | null;
  targetWidth?: number | null;
  targetHeight?: number | null;
  cropZoom?: number | null;
  cropX?: number | null;
  cropY?: number | null;
  targetBytes?: number | null;
  vectorPreset?: "illustration" | "logo" | "line-art" | null;
  vectorDetail?: "clean" | "balanced" | "detailed" | null;
  vectorMaxColors?: number | null;
  vectorThreshold?: number | null;
  objectAction?: ObjectEditAction | null;
  objectSelection?: ObjectSelection | null;
  restoreMode?: RestoreMode | null;
}

export interface DesktopJobStatus {
  jobId: string;
  state: JobState;
  fraction: number;
  stage: string;
  result?: Agent2DResult | null;
  error?: ErrorPayload | null;
}

export interface ModelDescriptor {
  id: string;
  nativeScale: number;
  family: string;
  runtime: string;
}

export interface SrCapabilities {
  backend: string;
  backendPath: string;
  modelDir: string;
  models: ModelDescriptor[];
}

export interface BackendCapabilities {
  ffmpeg: boolean;
  ffprobe: boolean;
  cwebp: boolean;
  cjxl: boolean;
  standardFormats: OutputFormat[];
  compactFormats: OutputFormat[];
}

export interface BackgroundRuntimeStatus {
  installed: boolean;
  managed: boolean;
  releaseId: string;
  root: string;
  pythonPath: string;
  runnerPath: string;
  modelCacheDir: string;
  modelId: string;
  modelRevision: string;
  nobgVersion: string;
  torchVersion: string;
}
