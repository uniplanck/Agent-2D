import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(import.meta.dirname, "../../..");
const serverEntry = resolve(root, "mcp/server/dist/index.js");
const agent2dBin = resolve(root, "target/debug/agent2d");
const temp = await mkdtemp(join(tmpdir(), "agent2d-mcp-"));
const input = join(temp, "fixture.png");

try {
  execFileSync("magick", ["-size", "4x3", "xc:#336699", input], { stdio: "pipe" });

  const client = new Client({ name: "agent2d-acceptance", version: "0.1.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: { ...process.env, AGENT2D_BIN: agent2dBin },
    stderr: "pipe",
  });

  await client.connect(transport);
  const tools = await client.listTools();
  const expected = new Set([
    "agent2d_inspect",
    "agent2d_upscale",
    "agent2d_compress",
    "agent2d_optimize",
    "agent2d_capabilities",
  ]);
  for (const name of expected) {
    if (!tools.tools.some((tool) => tool.name === name)) throw new Error(`missing MCP tool ${name}`);
  }

  const capabilities = await client.callTool({ name: "agent2d_capabilities", arguments: {} });
  const capabilityEnvelope = parseTextResult(capabilities);
  if (capabilityEnvelope.ok !== true) throw new Error("capabilities tool returned failure");
  if (!Array.isArray(capabilityEnvelope.data?.superResolution?.models)) {
    throw new Error("capabilities did not expose SR models");
  }

  const inspection = await client.callTool({
    name: "agent2d_inspect",
    arguments: { inputPath: input },
  });
  const inspectionEnvelope = parseTextResult(inspection);
  assertSuccess(inspectionEnvelope, "inspect");
  if (inspectionEnvelope.data?.width !== 4 || inspectionEnvelope.data?.height !== 3) {
    throw new Error(`unexpected inspected dimensions ${JSON.stringify(inspectionEnvelope.data)}`);
  }

  const compressedPath = join(temp, "compressed.png");
  const compression = await client.callTool({
    name: "agent2d_compress",
    arguments: { inputPath: input, outputPath: compressedPath, mode: "exact", format: "png" },
  });
  const compressionEnvelope = parseTextResult(compression);
  assertSuccess(compressionEnvelope, "compress");
  if (compressionEnvelope.data?.pixelExact !== true) throw new Error("compress was not pixel-exact");

  let jxlPixelExact = null;
  if (capabilityEnvelope.data?.compression?.jxlLossless === true) {
    const jxlPath = join(temp, "compressed.jxl");
    const jxlCompression = await client.callTool({
      name: "agent2d_compress",
      arguments: { inputPath: input, outputPath: jxlPath, mode: "exact", format: "jxl" },
    });
    const jxlEnvelope = parseTextResult(jxlCompression);
    assertSuccess(jxlEnvelope, "compress-jxl");
    if (jxlEnvelope.data?.pixelExact !== true) throw new Error("JXL compress was not pixel-exact");
    jxlPixelExact = jxlEnvelope.data.pixelExact;

    const jxlInspection = await client.callTool({
      name: "agent2d_inspect",
      arguments: { inputPath: jxlPath },
    });
    const jxlInspectionEnvelope = parseTextResult(jxlInspection);
    assertSuccess(jxlInspectionEnvelope, "inspect-jxl");
    if (jxlInspectionEnvelope.data?.width !== 4 || jxlInspectionEnvelope.data?.height !== 3) {
      throw new Error(`unexpected JXL dimensions ${JSON.stringify(jxlInspectionEnvelope.data)}`);
    }

    const jxlRoundTripPath = join(temp, "jxl-roundtrip.png");
    const jxlRoundTrip = await client.callTool({
      name: "agent2d_compress",
      arguments: { inputPath: jxlPath, outputPath: jxlRoundTripPath, mode: "exact", format: "png" },
    });
    const jxlRoundTripEnvelope = parseTextResult(jxlRoundTrip);
    assertSuccess(jxlRoundTripEnvelope, "jxl-to-png");
    if (jxlRoundTripEnvelope.data?.pixelExact !== true) throw new Error("JXL to PNG was not pixel-exact");
  }

  const upscaledPath = join(temp, "upscaled.png");
  const upscale = await client.callTool({
    name: "agent2d_upscale",
    arguments: { inputPath: input, outputPath: upscaledPath, scale: 2, mode: "balanced" },
  });
  const upscaleEnvelope = parseTextResult(upscale);
  assertSuccess(upscaleEnvelope, "upscale");
  if (upscaleEnvelope.data?.outputWidth !== 8 || upscaleEnvelope.data?.outputHeight !== 6) {
    throw new Error(`unexpected upscale result ${JSON.stringify(upscaleEnvelope.data)}`);
  }

  const x1Path = join(temp, "x1.png");
  const x1 = await client.callTool({
    name: "agent2d_upscale",
    arguments: { inputPath: input, outputPath: x1Path, scale: 1, mode: "balanced" },
  });
  const x1Envelope = parseTextResult(x1);
  assertSuccess(x1Envelope, "upscale-x1");
  if (x1Envelope.data?.outputWidth !== 4 || x1Envelope.data?.outputHeight !== 3) {
    throw new Error(`x1 changed dimensions ${JSON.stringify(x1Envelope.data)}`);
  }
  if (x1Envelope.data?.modelId != null) throw new Error("x1 unexpectedly ran an SR model");

  const optimizedPath = join(temp, "optimized.png");
  const optimize = await client.callTool({
    name: "agent2d_optimize",
    arguments: {
      inputPath: input,
      outputPath: optimizedPath,
      scale: 2,
      srMode: "balanced",
      compressionMode: "exact",
      format: "png",
    },
  });
  const optimizeEnvelope = parseTextResult(optimize);
  assertSuccess(optimizeEnvelope, "optimize");
  if (optimizeEnvelope.data?.outputWidth !== 8 || optimizeEnvelope.data?.outputHeight !== 6) {
    throw new Error(`unexpected optimize result ${JSON.stringify(optimizeEnvelope.data)}`);
  }

  await client.close();
  console.log(
    JSON.stringify({
      ok: true,
      tools: tools.tools.map((tool) => tool.name).sort(),
      inspected: [inspectionEnvelope.data.width, inspectionEnvelope.data.height],
      compressedPixelExact: compressionEnvelope.data.pixelExact,
      jxlPixelExact,
      upscaled: [upscaleEnvelope.data.outputWidth, upscaleEnvelope.data.outputHeight],
      x1: [x1Envelope.data.outputWidth, x1Envelope.data.outputHeight],
      optimized: [optimizeEnvelope.data.outputWidth, optimizeEnvelope.data.outputHeight],
      discoveredModels: capabilityEnvelope.data.superResolution.models.length,
    }),
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}

function parseTextResult(result) {
  const block = result.content?.find((item) => item.type === "text");
  if (!block || typeof block.text !== "string") throw new Error("MCP result had no text content");
  return JSON.parse(block.text);
}

function assertSuccess(envelope, tool) {
  if (envelope.ok !== true) throw new Error(`${tool} returned failure: ${JSON.stringify(envelope)}`);
}
