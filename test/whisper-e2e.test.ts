/**
 * Hermetic end-to-end test of WhisperCppProvider against a stub executable
 * that honors the real whisper-cli arg contract (--model/--file/--output-file
 * + `<prefix>.txt` output). No network, no model, no microphone.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WhisperCppProvider } from "../src/providers/whisper-cpp.js";
import { VoiceError } from "../src/core/types.js";

let dir = "";
let stub = "";
let model = "";
let audio = "";

const STUB_NODE_SCRIPT = `
import fs from "node:fs";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("whisper.cpp stub");
  process.exit(0);
}
let model = "";
let file = "";
let outputPrefix = "";
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--model") model = args[++i] ?? "";
  else if (args[i] === "--file") file = args[++i] ?? "";
  else if (args[i] === "--output-file") outputPrefix = args[++i] ?? "";
}
if (!fs.existsSync(model)) {
  console.error("failed to open model");
  process.exit(1);
}
if (!fs.existsSync(file)) {
  console.error("failed to open audio");
  process.exit(1);
}
if (process.env.STUB_SLEEP) {
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.STUB_SLEEP) * 1000));
}
fs.writeFileSync(outputPrefix + ".txt", "stub transcript line\\n");
`;

/** Minimal 16-bit mono WAV (1s of silence at 16kHz) — content irrelevant. */
function writeSilentWav(filePath: string): void {
  const sampleRate = 16000;
  const samples = sampleRate;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + samples * 2, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(samples * 2, 40);
  fs.writeFileSync(filePath, Buffer.concat([header, Buffer.alloc(samples * 2)]));
}

before(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ocv-e2e-"));
  const nodeStub = path.join(dir, "stub.mjs");
  await fs.promises.writeFile(nodeStub, STUB_NODE_SCRIPT);
  if (process.platform === "win32") {
    stub = path.join(dir, "whisper-cli.cmd");
    await fs.promises.writeFile(
      stub,
      `@echo off\r\n"${process.execPath}" "%~dp0stub.mjs" %*\r\n`,
    );
  } else {
    stub = path.join(dir, "whisper-cli");
    await fs.promises.writeFile(
      stub,
      `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/stub.mjs" "$@"\n`,
      { mode: 0o755 },
    );
  }
  model = path.join(dir, "ggml-large-v3-turbo.bin");
  await fs.promises.writeFile(model, Buffer.alloc(2 * 1024 * 1024));
  audio = path.join(dir, "rec.wav");
  writeSilentWav(audio);
});

after(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true });
});

describe("whisper.cpp provider end-to-end (stub binary)", () => {
  it("transcribes via .txt output and cleans up", async () => {
    const provider = new WhisperCppProvider({ executablePath: stub, modelPath: model });
    assert.equal(await provider.isAvailable(), true);
    const result = await provider.transcribe(audio, { language: "en" });
    assert.equal(result.text, "stub transcript line");
    assert.equal(result.providerID, "whisper.cpp");
    assert.equal(result.model, model);
    assert.equal(fs.existsSync(`${audio}.transcript.txt`), false);
  });

  it("surfaces whisper exit codes as transcription_failed", async () => {
    const provider = new WhisperCppProvider({
      executablePath: stub,
      modelPath: path.join(dir, "missing.bin"),
    });
    await assert.rejects(() => provider.transcribe(audio, { language: "en" }), (e: unknown) => {
      return e instanceof VoiceError && e.code === "model_missing";
    });
  });

  it("abort cancels transcription with job_cancelled", async () => {
    process.env.STUB_SLEEP = "30";
    try {
      const provider = new WhisperCppProvider({
        executablePath: stub,
        modelPath: model,
        timeoutMs: 30_000,
      });
      const controller = new AbortController();
      const pending = provider.transcribe(audio, { language: "en", signal: controller.signal });
      await new Promise((resolve) => setTimeout(resolve, 300));
      controller.abort();
      await assert.rejects(() => pending, (e: unknown) => {
        return e instanceof VoiceError && e.code === "job_cancelled";
      });
    } finally {
      delete process.env.STUB_SLEEP;
    }
  });
});
