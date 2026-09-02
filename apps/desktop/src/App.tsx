import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import type {
  Agent2DResult,
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

function bytes(value?: number | null): string {
  if (value == null) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(2)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

function outputFor(input: string, operation: Operation, format: OutputFormat): string {
  if (!input) return "";
  const slash = input.lastIndexOf("/");
  const dir = slash >= 0 ? input.slice(0, slash + 1) : "";
  const file = slash >= 0 ? input.slice(slash + 1) : input;
  const dot = file.lastIndexOf(".");
  const stem = dot > 0 ? file.slice(0, dot) : file;
  const suffix = operation === "enhance" ? "enhanced" : operation === "compress" ? "compressed" : "optimized";
  const ext = operation === "enhance" ? "png" : format;
  return `${dir}${stem}-agent2d-${suffix}.${ext}`;
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
  return "Optimize";
}

export default function App() {
  const [operation, setOperation] = useState<Operation>("optimize");
  const [inputPath, setInputPath] = useState("");
  const [outputPath, setOutputPath] = useState("");
  const [inputInfo, setInputInfo] = useState<InspectResult | null>(null);
  const [inputPreview, setInputPreview] = useState("");
  const [outputPreview, setOutputPreview] = useState("");
  const [result, setResult] = useState<Agent2DResult | null>(null);
  const [scale, setScale] = useState<2 | 4>(2);
  const [srMode, setSrMode] = useState<SrMode>("balanced");
  const [format, setFormat] = useState<OutputFormat>("png");
  const [modelId, setModelId] = useState("");
  const [capabilities, setCapabilities] = useState<SrCapabilities | null>(null);
  const [runtimeChecked, setRuntimeChecked] = useState(false);
  const [installingRuntime, setInstallingRuntime] = useState(false);
  const [job, setJob] = useState<DesktopJobStatus | null>(null);
  const [error, setError] = useState("");
  const pollRef = useRef<number | null>(null);

  const running = job?.state === "queued" || job?.state === "running";
  const effectiveFormat: OutputFormat = operation === "enhance" ? "png" : format;

  const stopPolling = useCallback(() => {
    if (pollRef.current != null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const loadInput = useCallback(async (path: string) => {
    if (!path) return;
    setError("");
    setResult(null);
    setOutputPreview("");
    try {
      const [info, preview] = await Promise.all([
        invoke<InspectResult>("inspect_image_command", { path }),
        invoke<string>("preview_image_command", { path }),
      ]);
      setInputPath(path);
      setInputInfo(info);
      setInputPreview(preview);
      setOutputPath(outputFor(path, operation, effectiveFormat));
    } catch (cause) {
      setError(errorText(cause));
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

  useEffect(() => {
    const promise = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "drop" && event.payload.paths.length > 0) {
        void loadInput(event.payload.paths[0]);
      }
    });
    return () => {
      void promise.then((unlisten) => unlisten());
    };
  }, [loadInput]);

  useEffect(() => {
    if (inputPath && !running) {
      setOutputPath(outputFor(inputPath, operation, effectiveFormat));
      setResult(null);
      setOutputPreview("");
    }
  }, [effectiveFormat, inputPath, operation, running]);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const openImage = async () => {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg"] }],
    });
    if (typeof selected === "string") await loadInput(selected);
  };

  const chooseOutput = async () => {
    const ext = effectiveFormat;
    const selected = await save({
      defaultPath: outputPath || outputFor(inputPath, operation, ext),
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    if (selected) setOutputPath(selected);
  };

  const pollJob = useCallback((jobId: string) => {
    stopPolling();
    pollRef.current = window.setInterval(async () => {
      try {
        const next = await invoke<DesktopJobStatus>("job_status_command", { jobId });
        setJob(next);
        if (next.state === "completed") {
          stopPolling();
          setResult(next.result ?? null);
          if (next.result?.outputPath) {
            const preview = await invoke<string>("preview_image_command", { path: next.result.outputPath });
            setOutputPreview(preview);
          }
        } else if (next.state === "failed") {
          stopPolling();
          setError(next.error?.message ?? "Processing failed");
        } else if (next.state === "cancelled") {
          stopPolling();
        }
      } catch (cause) {
        stopPolling();
        setError(errorText(cause));
      }
    }, POLL_MS);
  }, [stopPolling]);

  const start = async () => {
    if (!inputPath || !outputPath || running) return;
    setError("");
    setResult(null);
    setOutputPreview("");
    const request: DesktopJobRequest = {
      operation,
      inputPath,
      outputPath,
      scale,
      srMode,
      compressionMode: effectiveFormat === "avif" ? "preserve" : "exact",
      format: effectiveFormat,
      modelId: modelId || null,
    };
    try {
      const jobId = await invoke<string>("start_job_command", { request });
      setJob({ jobId, state: "queued", fraction: 0, stage: "queued" });
      pollJob(jobId);
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  const cancel = async () => {
    if (!job || !running) return;
    try {
      const next = await invoke<DesktopJobStatus>("cancel_job_command", { jobId: job.jobId });
      setJob(next);
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  const savings = useMemo(() => {
    if (!result || result.inputBytes <= 0) return null;
    return (1 - result.outputBytes / result.inputBytes) * 100;
  }, [result]);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">LOCAL IMAGE ENGINE</div>
          <h1>Agent-2D</h1>
        </div>
        <div className={`runtime-pill ${runtimeChecked && !capabilities ? "missing" : ""}`}>
          <span className={`runtime-dot ${capabilities ? "online" : ""}`} />
          <span>
            {capabilities
              ? `${capabilities.models.length} models · ${capabilities.backend}`
              : runtimeChecked
                ? "Real-ESRGAN runtime not installed"
                : "runtime checking"}
          </span>
          {runtimeChecked && !capabilities && (
            <button className="runtime-install" onClick={installManagedRuntime} disabled={installingRuntime}>
              {installingRuntime ? "Installing…" : "Install runtime"}
            </button>
          )}
        </div>
      </header>

      <section className="mode-tabs" aria-label="Operation">
        {(["enhance", "compress", "optimize"] as Operation[]).map((item) => (
          <button key={item} className={operation === item ? "active" : ""} onClick={() => setOperation(item)} disabled={running}>
            {modeLabel(item)}
            <small>{item === "enhance" ? "AI超解像" : item === "compress" ? "超圧縮" : "超解像 + 圧縮"}</small>
          </button>
        ))}
      </section>

      <section className="workspace-grid">
        <aside className="control-panel">
          <div className="section-label">SOURCE</div>
          <button className={`drop-zone ${inputPath ? "loaded" : ""}`} onClick={openImage} disabled={running}>
            <span className="drop-icon">↘</span>
            <strong>{inputPath ? "画像を変更" : "画像をドロップ"}</strong>
            <span>{inputPath ? inputPath.split("/").pop() : "またはクリックして選択"}</span>
          </button>

          {inputInfo && (
            <div className="mini-stats">
              <span>{inputInfo.width} × {inputInfo.height}</span>
              <span>{bytes(inputInfo.inputBytes)}</span>
              <span>{inputInfo.format.toUpperCase()} · {inputInfo.bitDepth}bit</span>
            </div>
          )}

          {operation !== "compress" && (
            <>
              <div className="section-label">SUPER RESOLUTION</div>
              <div className="field-row two">
                <label>
                  <span>Scale</span>
                  <select value={scale} onChange={(event) => setScale(Number(event.target.value) as 2 | 4)} disabled={running}>
                    <option value={2}>2×</option>
                    <option value={4}>4×</option>
                  </select>
                </label>
                <label>
                  <span>Mode</span>
                  <select value={srMode} onChange={(event) => setSrMode(event.target.value as SrMode)} disabled={running}>
                    <option value="fidelity">Fidelity</option>
                    <option value="balanced">Balanced</option>
                    <option value="perceptual">Perceptual</option>
                  </select>
                </label>
              </div>
              <label className="field">
                <span>Model</span>
                <select value={modelId} onChange={(event) => setModelId(event.target.value)} disabled={running}>
                  <option value="">Auto route</option>
                  {capabilities?.models.map((model) => <option key={model.id} value={model.id}>{model.id}</option>)}
                </select>
              </label>
            </>
          )}

          {operation !== "enhance" && (
            <>
              <div className="section-label">COMPRESSION</div>
              <label className="field">
                <span>Output format</span>
                <select value={format} onChange={(event) => setFormat(event.target.value as OutputFormat)} disabled={running}>
                  <option value="png">PNG · Exact</option>
                  <option value="webp">WebP · Lossless</option>
                  <option value="avif">AVIF · Preserve</option>
                </select>
              </label>
              <div className="quality-note">
                {effectiveFormat === "avif" ? "見た目を維持する高品質AVIF。pixel完全一致ではありません。" : "復号後pixel hashまで照合するExact Lossless。"}
              </div>
            </>
          )}

          <div className="section-label">OUTPUT</div>
          <div className="output-path-row">
            <input value={outputPath} onChange={(event) => setOutputPath(event.target.value)} placeholder="出力先" disabled={running} />
            <button onClick={chooseOutput} disabled={!inputPath || running}>…</button>
          </div>

          {job && (
            <div className={`job-card ${job.state}`}>
              <div className="job-line"><span>{job.stage}</span><strong>{Math.round(job.fraction * 100)}%</strong></div>
              <div className="progress-track"><div className="progress-fill" style={{ width: `${Math.max(4, job.fraction * 100)}%` }} /></div>
            </div>
          )}

          {error && <div className="error-box">{error}</div>}

          <div className="action-row">
            <button className="primary" onClick={start} disabled={!inputPath || !outputPath || running}>
              {running ? "Processing…" : `${modeLabel(operation)} image`}
            </button>
            {running && <button className="danger" onClick={cancel}>Cancel</button>}
          </div>
        </aside>

        <section className="preview-area">
          <div className="preview-grid">
            <figure className="preview-card">
              <figcaption><span>BEFORE</span>{inputInfo && <b>{inputInfo.width}×{inputInfo.height}</b>}</figcaption>
              <div className="image-stage">{inputPreview ? <img src={inputPreview} alt="Before" /> : <div className="empty-preview">Drop an image</div>}</div>
            </figure>
            <figure className="preview-card after">
              <figcaption><span>AFTER</span>{result && <b>{result.outputWidth}×{result.outputHeight}</b>}</figcaption>
              <div className="image-stage">{outputPreview ? <img src={outputPreview} alt="After" /> : <div className="empty-preview">Result preview</div>}</div>
            </figure>
          </div>

          <div className="result-strip">
            <div><span>INPUT</span><strong>{bytes(result?.inputBytes ?? inputInfo?.inputBytes)}</strong></div>
            <div><span>OUTPUT</span><strong>{bytes(result?.outputBytes)}</strong></div>
            <div><span>SIZE CHANGE</span><strong>{savings == null ? "—" : `${savings >= 0 ? "−" : "+"}${Math.abs(savings).toFixed(1)}%`}</strong></div>
            <div><span>TIME</span><strong>{result ? `${(result.elapsedMs / 1000).toFixed(2)}s` : "—"}</strong></div>
            <div><span>VERIFY</span><strong>{result?.pixelExact === true ? "PIXEL EXACT" : result ? "PASS" : "—"}</strong></div>
          </div>

          {result?.warnings?.length ? (
            <div className="warning-row">{result.warnings.map((warning) => <span key={warning}>{warning.replaceAll("_", " ")}</span>)}</div>
          ) : null}
        </section>
      </section>
    </main>
  );
}
