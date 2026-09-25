import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULTS, loadConfig } from "../src/core/config.js";
import { VoiceError } from "../src/core/types.js";
import { selectProvider } from "../src/providers/index.js";
import {
  ggufModelID,
  ggufPreferenceScore,
  isCompletedGguf,
  parseTranscribeStdout,
  probeAudio,
  TranscribeCppProvider,
} from "../src/providers/transcribe-cpp.js";

let dir = "";
let hubSnap = "";

before(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ocv-gguf-"));
  // Plain dir with a completed model, a partial download, and junk.
  await fs.promises.writeFile(path.join(dir, "whisper-large-v3-turbo-Q8_0.gguf"), Buffer.alloc(2 * 1024 * 1024));
  await fs.promises.writeFile(path.join(dir, "whisper-large-v3-turbo-Q8_0.gguf.partial"), Buffer.alloc(16));
  await fs.promises.writeFile(path.join(dir, "notes.txt"), "x");
  // Handy HF hub layout.
  hubSnap = path.join(dir, "hub", "models--handy-computer--whisper-large-v3-turbo-gguf", "snapshots", "abc123");
  await fs.promises.mkdir(hubSnap, { recursive: true });
  const hubBlob = path.join(dir, "hub", "blobs", "turbo-model");
  await fs.promises.mkdir(path.dirname(hubBlob), { recursive: true });
  await fs.promises.writeFile(hubBlob, Buffer.alloc(2 * 1024 * 1024));
  // HF snapshots point at blobs with symlinks rather than copying models.
  const hubModel = path.join(hubSnap, "whisper-large-v3-turbo-Q8_0.gguf");
  if (process.platform === "win32") {
    // Windows runners may not allow unprivileged symlink creation.
    await fs.promises.copyFile(hubBlob, hubModel);
  } else {
    await fs.promises.symlink(hubBlob, hubModel);
  }
  await fs.promises.writeFile(path.join(hubSnap, "whisper-base-Q4_K_M.gguf"), Buffer.alloc(1024 * 1024));
});

after(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true });
});

describe("transcribe.cpp GGUF discovery", () => {
  it("finds completed .gguf and ignores .partial", async () => {
    const provider = new TranscribeCppProvider({ modelSearchDirs: [dir] });
    const models = await provider.discoverModels();
    const names = models.map((m) => path.basename(m.path));
    assert.ok(names.includes("whisper-large-v3-turbo-Q8_0.gguf"));
    assert.ok(!names.some((n) => n.endsWith(".partial")));
    assert.ok(!names.includes("notes.txt"));
  });

  it("discovers the Handy HF hub layout", async () => {
    const provider = new TranscribeCppProvider({
      modelSearchDirs: [path.join(dir, "hub")],
    });
    const models = await provider.discoverModels();
    assert.ok(models.some((m) => m.path.includes("snapshots")));
    assert.ok(models.every((m) => m.path.endsWith(".gguf")));
  });

  it("prefers turbo Q8_0 for auto", async () => {
    const provider = new TranscribeCppProvider({ modelSearchDirs: [dir] });
    const resolved = await provider.resolveModel("auto");
    assert.equal(path.basename(resolved.path), "whisper-large-v3-turbo-Q8_0.gguf");
    assert.equal(resolved.preferred, true);
  });

  it("isCompletedGguf rejects partials", () => {
    assert.equal(isCompletedGguf("a.gguf"), true);
    assert.equal(isCompletedGguf("a.GGUF"), true);
    assert.equal(isCompletedGguf("a.gguf.partial"), false);
    assert.equal(isCompletedGguf("a.bin"), false);
  });

  it("gguf ids and preference order", () => {
    assert.equal(ggufModelID("whisper-large-v3-turbo-Q8_0.gguf"), "whisper-large-v3-turbo-q8_0");
    const ranked = [
      { id: "whisper-base-q4_k_m", path: "/b", bytes: 1 },
      { id: "whisper-large-v3-turbo-q8_0", path: "/t", bytes: 1 },
      { id: "whisper-small-f16", path: "/s", bytes: 1 },
    ].sort((a, b) => ggufPreferenceScore(b) - ggufPreferenceScore(a));
    assert.equal(ranked[0]?.id, "whisper-large-v3-turbo-q8_0");
  });

  it("missing models raise model_missing (never downloads)", async () => {
    // Explicit missing path overrides the machine's real default discovery.
    const provider = new TranscribeCppProvider({ modelPath: "/nonexistent-xyz/model.gguf" });
    await assert.rejects(() => provider.resolveModel("auto"), (e: unknown) => {
      return e instanceof VoiceError && e.code === "model_missing";
    });
  });

  it("buildArgs uses -m plus positional audio, language only when set", () => {    const provider = new TranscribeCppProvider({});
    const auto = provider.buildArgs("/a.wav", "/m.gguf", { language: "auto" });
    assert.ok(auto.includes("--model") && auto.includes("/m.gguf"));
    assert.equal(auto[auto.length - 1], "/a.wav");
    assert.ok(!auto.includes("--language"));
    assert.ok(auto.includes("--timestamps") && auto.includes("none"));
    const en = provider.buildArgs("/a.wav", "/m.gguf", { language: "en" });
    assert.ok(en.includes("--language") && en.includes("en"));
  });
});

describe("audio probing (ffmpeg)", () => {
  it("probeAudio reads a compliant wav; ensureAudio passes it through", async () => {
    const wav = path.join(dir, "good.wav");
    await writeWav(wav, 16000, 1);
    const probe = await probeAudio(wav);
    assert.equal(probe?.codec, "pcm_s16le");
    assert.equal(probe?.sampleRate, 16000);
    assert.equal(probe?.channels, 1);
    const provider = new TranscribeCppProvider({ modelPath: path.join(dir, "x.gguf") });
    const ensured = await provider.ensureAudio(wav);
    assert.equal(ensured.path, wav);
    assert.equal(ensured.converted, undefined);
  });

  it("ensureAudio converts non-compliant audio and convert output is valid", async () => {
    const wav = path.join(dir, "odd.wav");
    await writeWav(wav, 44100, 2);
    const provider = new TranscribeCppProvider({ modelPath: path.join(dir, "x.gguf") });
    const ensured = await provider.ensureAudio(wav);
    assert.ok(ensured.converted?.endsWith(".16k.wav"));
    const probe = await probeAudio(ensured.path);
    assert.equal(probe?.sampleRate, 16000);
    assert.equal(probe?.channels, 1);
    await fs.promises.unlink(ensured.path);
  });
});

describe("transcribe-cli output parsing", () => {
  const ENVELOPE = [
    "audio: /tmp/ocv-say.wav",
    "  samples:    60559",
    "model: /m/whisper-large-v3-turbo-Q8_0.gguf -> ok",
    "  backend:    Metal",
    "run: ok",
    "text: Hello, this is a voice transcription test.",
    "detected-language: en",
    "segments: 1",
    "  [   0.00 ->    3.60] Hello, this is a voice transcription test.",
    "  realtime:   1x (3900 ms for 3.8 s)",
  ].join("\n");

  it("extracts the text block and detected language", () => {
    const parsed = parseTranscribeStdout(ENVELOPE);
    assert.equal(parsed.text, "Hello, this is a voice transcription test.");
    assert.equal(parsed.language, "en");
  });

  it("falls back to cleaning raw text without an envelope", () => {
    const parsed = parseTranscribeStdout("  [   0.00 ->    3.60] hello world  \n");
    assert.equal(parsed.text, "hello world");
    assert.equal(parsed.language, undefined);
  });
});

describe("provider selection (transcribe preferred, whisper fallback)", () => {
  it("falls back to whisper.cpp when transcribe is unavailable", async () => {
    const binDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ocv-bin-"));
    const prevTranscribe = process.env.OPENCODE_VOICE_TRANSCRIBE_BIN;
    const prevWhisper = process.env.OPENCODE_VOICE_WHISPER_BIN;
    try {
      const whisperStub = path.join(binDir, "whisper-cli");
      await fs.promises.writeFile(whisperStub, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      // Providers read explicit paths from process.env at runtime.
      process.env.OPENCODE_VOICE_TRANSCRIBE_BIN = "/nonexistent/transcribe-cli";
      process.env.OPENCODE_VOICE_WHISPER_BIN = whisperStub;
      const { config } = loadConfig({ env: process.env, cwd: "/nonexistent-xyz" });
      const selected = await selectProvider(config);
      assert.equal(selected.id, "whisper.cpp");
      assert.equal(selected.fallbackFrom, "transcribe.cpp");
    } finally {
      if (prevTranscribe === undefined) delete process.env.OPENCODE_VOICE_TRANSCRIBE_BIN;
      else process.env.OPENCODE_VOICE_TRANSCRIBE_BIN = prevTranscribe;
      if (prevWhisper === undefined) delete process.env.OPENCODE_VOICE_WHISPER_BIN;
      else process.env.OPENCODE_VOICE_WHISPER_BIN = prevWhisper;
      await fs.promises.rm(binDir, { recursive: true, force: true });
    }
  });

  it("explicit whisper.cpp is respected without fallback", async () => {
    const { config } = loadConfig({
      env: { OPENCODE_VOICE_PROVIDER: "whisper.cpp" } as NodeJS.ProcessEnv,
      cwd: "/nonexistent-xyz",
    });
    const selected = await selectProvider(config);
    assert.equal(selected.id, "whisper.cpp");
    assert.equal(selected.fallbackFrom, undefined);
  });

  it("default provider is transcribe.cpp", () => {
    assert.equal(DEFAULTS.provider, "transcribe.cpp");
    const { config } = loadConfig({ env: {}, cwd: "/nonexistent-xyz" });
    assert.equal(config.provider, "transcribe.cpp");
  });

  it("TRANSCRIBE_BIN applies to transcribe, WHISPER_BIN stays scoped to whisper", () => {
    const t = loadConfig({
      env: { OPENCODE_VOICE_TRANSCRIBE_BIN: "/t" } as NodeJS.ProcessEnv,
      cwd: "/nonexistent-xyz",
    });
    assert.equal(t.config.executablePath, "/t");
    const w = loadConfig({
      env: {
        OPENCODE_VOICE_PROVIDER: "whisper.cpp",
        OPENCODE_VOICE_WHISPER_BIN: "/w",
      } as NodeJS.ProcessEnv,
      cwd: "/nonexistent-xyz",
    });
    assert.equal(w.config.executablePath, "/w");
    const scoped = loadConfig({
      env: { OPENCODE_VOICE_WHISPER_BIN: "/w" } as NodeJS.ProcessEnv,
      cwd: "/nonexistent-xyz",
    });
    // Default provider is transcribe.cpp: whisper path must not leak into it.
    assert.equal(scoped.config.executablePath, undefined);
  });
});

/** Write a silent WAV with the given rate/channels (ffmpeg sine source). */
async function writeWav(filePath: string, rate: number, channels: number): Promise<void> {
  const { runCommand, which } = await import("../src/utils/process.js");
  const ffmpeg = which(["ffmpeg"], ["/opt/homebrew/bin", "/usr/local/bin"]);
  assert.ok(ffmpeg, "ffmpeg required for audio tests");
  const result = await runCommand(ffmpeg, {
    args: [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", `sine=frequency=440:duration=1`,
      "-ar", String(rate), "-ac", String(channels),
      "-c:a", "pcm_s16le", "-y", filePath,
    ],
    timeoutMs: 30_000,
  });
  assert.equal(result.exitCode, 0);
}
