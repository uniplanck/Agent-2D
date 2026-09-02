import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "../../..");
const agent2dBin = process.env.AGENT2D_BIN ?? resolve(projectRoot, "target/debug/agent2d");

const server = new Server(
  { name: "agent-2d", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

const pathProperty = { type: "string", minLength: 1 } as const;
const scaleProperty = { type: "integer", enum: [2, 3, 4] } as const;
const srModeProperty = {
  type: "string",
  enum: ["fidelity", "balanced", "perceptual"],
} as const;
const compressionModeProperty = {
  type: "string",
  enum: ["exact", "preserve", "compact"],
} as const;
const outputFormatProperty = {
  type: "string",
  enum: ["png", "jpeg", "webp", "avif"],
} as const;

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "agent2d_inspect",
      description: "Inspect a local PNG/JPEG through the shared Agent-2D Core.",
      inputSchema: {
        type: "object",
        properties: { inputPath: pathProperty },
        required: ["inputPath"],
        additionalProperties: false,
      },
    },
    {
      name: "agent2d_upscale",
      description: "Upscale a local image using Agent-2D's NCNN super-resolution backend.",
      inputSchema: {
        type: "object",
        properties: {
          inputPath: pathProperty,
          outputPath: pathProperty,
          scale: scaleProperty,
          mode: srModeProperty,
          preset: { type: "string", enum: ["general", "photo", "illustration", "ai-art"] },
          modelId: { type: "string", minLength: 1 },
          targetWidth: { type: "integer", minimum: 1 },
          targetHeight: { type: "integer", minimum: 1 },
        },
        required: ["inputPath", "outputPath"],
        additionalProperties: false,
      },
    },
    {
      name: "agent2d_compress",
      description: "Compress a local image using exact or preserve-oriented Agent-2D codecs.",
      inputSchema: {
        type: "object",
        properties: {
          inputPath: pathProperty,
          outputPath: pathProperty,
          mode: compressionModeProperty,
          format: outputFormatProperty,
        },
        required: ["inputPath", "outputPath", "format"],
        additionalProperties: false,
      },
    },
    {
      name: "agent2d_optimize",
      description: "Run super-resolution followed by compression as one Agent-2D pipeline.",
      inputSchema: {
        type: "object",
        properties: {
          inputPath: pathProperty,
          outputPath: pathProperty,
          scale: scaleProperty,
          srMode: srModeProperty,
          compressionMode: compressionModeProperty,
          format: outputFormatProperty,
          targetWidth: { type: "integer", minimum: 1 },
          targetHeight: { type: "integer", minimum: 1 },
        },
        required: ["inputPath", "outputPath"],
        additionalProperties: false,
      },
    },
    {
      name: "agent2d_capabilities",
      description: "Report installed Agent-2D codecs, SR runtime, and discovered models.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = asRecord(request.params.arguments);
  try {
    let result: unknown;
    switch (request.params.name) {
      case "agent2d_inspect":
        result = await runAgent2d(["inspect", requiredString(args, "inputPath")]);
        break;
      case "agent2d_upscale":
        result = await runAgent2d(buildUpscaleArgs(args));
        break;
      case "agent2d_compress":
        result = await runAgent2d(buildCompressArgs(args));
        break;
      case "agent2d_optimize":
        result = await runAgent2d(buildOptimizeArgs(args));
        break;
      case "agent2d_capabilities":
        result = await runAgent2d(["capabilities"]);
        break;
      default:
        return errorResult({
          schemaVersion: "0.1",
          ok: false,
          error: { code: "unknown_tool", message: `Unknown tool: ${request.params.name}` },
        });
    }
    return successResult(result);
  } catch (error) {
    return errorResult(normalizeError(error));
  }
});

function buildUpscaleArgs(args: Record<string, unknown>): string[] {
  const command = [
    "upscale",
    requiredString(args, "inputPath"),
    requiredString(args, "outputPath"),
    "--scale",
    String(optionalScale(args, "scale", 2)),
    "--mode",
    optionalEnum(args, "mode", ["fidelity", "balanced", "perceptual"], "balanced"),
  ];
  appendString(command, "--preset", args.preset);
  appendString(command, "--model", args.modelId);
  appendNumber(command, "--target-width", args.targetWidth);
  appendNumber(command, "--target-height", args.targetHeight);
  return command;
}

function buildCompressArgs(args: Record<string, unknown>): string[] {
  return [
    "compress",
    requiredString(args, "inputPath"),
    requiredString(args, "outputPath"),
    "--mode",
    optionalEnum(args, "mode", ["exact", "preserve", "compact"], "exact"),
    "--format",
    requiredEnum(args, "format", ["png", "jpeg", "webp", "avif"]),
  ];
}

function buildOptimizeArgs(args: Record<string, unknown>): string[] {
  const command = [
    "optimize",
    requiredString(args, "inputPath"),
    requiredString(args, "outputPath"),
    "--scale",
    String(optionalScale(args, "scale", 2)),
    "--sr-mode",
    optionalEnum(args, "srMode", ["fidelity", "balanced", "perceptual"], "balanced"),
    "--compression-mode",
    optionalEnum(args, "compressionMode", ["exact", "preserve", "compact"], "exact"),
    "--format",
    optionalEnum(args, "format", ["png", "jpeg", "webp", "avif"], "png"),
  ];
  appendNumber(command, "--target-width", args.targetWidth);
  appendNumber(command, "--target-height", args.targetHeight);
  return command;
}

function runAgent2d(args: string[]): Promise<unknown> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(agent2dBin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    const maxCharacters = 1_000_000;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = boundedAppend(stdout, chunk, maxCharacters);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = boundedAppend(stderr, chunk, maxCharacters);
    });
    child.on("error", (error) => rejectPromise(error));
    child.on("close", (code) => {
      const raw = code === 0 ? stdout.trim() : stderr.trim();
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (code === 0) {
          resolvePromise(parsed);
        } else {
          rejectPromise(parsed);
        }
      } catch {
        rejectPromise({
          schemaVersion: "0.1",
          ok: false,
          error: {
            code: "cli_protocol_error",
            message: `agent2d exited ${code ?? "unknown"}; output was not valid JSON`,
          },
        });
      }
    });
  });
}

function successResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

function errorResult(value: unknown) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

function normalizeError(error: unknown): unknown {
  if (typeof error === "object" && error !== null) return error;
  return {
    schemaVersion: "0.1",
    ok: false,
    error: { code: "mcp_adapter_error", message: String(error) },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${key} is required`);
  return value;
}

function appendString(command: string[], flag: string, value: unknown): void {
  if (typeof value === "string" && value.length > 0) command.push(flag, value);
}

function appendNumber(command: string[], flag: string, value: unknown): void {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    command.push(flag, String(value));
  }
}

function optionalScale(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = args[key];
  if (value === undefined) return fallback;
  if (value === 2 || value === 3 || value === 4) return value;
  throw new Error(`${key} must be 2, 3, or 4`);
}

function requiredEnum(args: Record<string, unknown>, key: string, allowed: readonly string[]): string {
  const value = requiredString(args, key);
  if (!allowed.includes(value)) throw new Error(`${key} must be one of ${allowed.join(", ")}`);
  return value;
}

function optionalEnum(
  args: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
  fallback: string,
): string {
  if (args[key] === undefined) return fallback;
  return requiredEnum(args, key, allowed);
}

function boundedAppend(current: string, chunk: string, maxCharacters: number): string {
  const combined = current + chunk;
  return combined.length <= maxCharacters ? combined : combined.slice(combined.length - maxCharacters);
}

const transport = new StdioServerTransport();
await server.connect(transport);
