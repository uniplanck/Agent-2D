export type Operation = "enhance" | "compress" | "optimize";
export type JobState = "queued" | "running" | "completed" | "failed" | "cancelled";
export type SrMode = "fidelity" | "balanced" | "perceptual";
export type CompressionMode = "exact" | "preserve";
export type OutputFormat = "png" | "jpeg" | "webp" | "avif" | "jxl";

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

export interface DesktopJobRequest {
  operation: Operation;
  inputPath: string;
  outputPath: string;
  scale: 1 | 2 | 4;
  srMode: SrMode;
  compressionMode: CompressionMode;
  format: OutputFormat;
  modelId?: string | null;
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
