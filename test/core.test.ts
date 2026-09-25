import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULTS, configFromEnv, loadConfig } from "../src/core/config.js";
import {
  cleanTranscript,
  modelIDFromFilename,
  modelPreferenceScore,
  WhisperCppProvider,
} from "../src/providers/whisper-cpp.js";
import { parseAlsaDevices, parseAvDevices, toAvSelector } from "../src/recorder/ffmpeg.js";

describe("config", () => {
  it("defaults work with no file, env, or overrides", () => {
    // Hermetic: a global ~/.config/opencode/opencode-voice.json on the test
    // machine must not leak into the "no file" case.
    const savedHOME = process.env.HOME;
    const savedConfigDir = process.env.OPENCODE_CONFIG_DIR;
    const savedVoiceConfig = process.env.OPENCODE_VOICE_CONFIG;
    process.env.HOME = "/nonexistent-home-xyz";
    delete process.env.OPENCODE_CONFIG_DIR;
    delete process.env.OPENCODE_VOICE_CONFIG;
    try {
      const { config, source } = loadConfig({ env: {}, cwd: "/nonexistent-dir-xyz" });
      assert.equal(config.provider, DEFAULTS.provider);
      assert.equal(config.model, "auto");
      assert.equal(config.language, "auto");
      assert.equal(config.maxConcurrentTranscriptions, 1);
      assert.equal(config.keepAudio, false);
      assert.equal(source, undefined);
    } finally {
      if (savedHOME === undefined) delete process.env.HOME;
      else process.env.HOME = savedHOME;
      if (savedConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
      else process.env.OPENCODE_CONFIG_DIR = savedConfigDir;
      if (savedVoiceConfig === undefined) delete process.env.OPENCODE_VOICE_CONFIG;
      else process.env.OPENCODE_VOICE_CONFIG = savedVoiceConfig;
    }
  });

  it("env overrides defaults", () => {
    const env = {
      OPENCODE_VOICE_PROVIDER: "whisper.cpp",
      OPENCODE_VOICE_MODEL: "tiny",
      OPENCODE_VOICE_MODEL_PATH: "/models/custom.bin",
      OPENCODE_VOICE_LANGUAGE: "en",
      OPENCODE_VOICE_DEVICE: ":1",
      OPENCODE_VOICE_MAX_CONCURRENT: "3",
      OPENCODE_VOICE_KEEP_AUDIO: "true",
      OPENCODE_VOICE_DEBUG: "1",
      OPENCODE_VOICE_THREADS: "6",
    };
    const { config } = loadConfig({ env: env as NodeJS.ProcessEnv, cwd: "/nonexistent-dir-xyz" });
    assert.equal(config.model, "tiny");
    assert.equal(config.modelPath, "/models/custom.bin");
    assert.equal(config.language, "en");
    assert.equal(config.device, ":1");
    assert.equal(config.maxConcurrentTranscriptions, 3);
    assert.equal(config.keepAudio, true);
    assert.equal(config.debug, true);
    assert.equal(config.threads, 6);
  });

  it("explicit overrides beat env", () => {
    const env = { OPENCODE_VOICE_MODEL: "tiny" } as NodeJS.ProcessEnv;
    const { config } = loadConfig({
      env,
      cwd: "/nonexistent-dir-xyz",
      overrides: { model: "base" },
    });
    assert.equal(config.model, "base");
  });

  it("config file is honored and invalid values fall back", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ocv-cfg-"));
    const dotOpencode = path.join(dir, ".opencode");
    await fs.promises.mkdir(dotOpencode, { recursive: true });
    await fs.promises.writeFile(
      path.join(dotOpencode, "opencode-voice.json"),
      JSON.stringify({ model: "small", maxConcurrentTranscriptions: 0, keepAudio: true }),
    );
    const { config, source } = loadConfig({ env: {}, cwd: dir });
    assert.equal(config.model, "small");
    assert.equal(config.maxConcurrentTranscriptions, 1); // clamped
    assert.equal(config.keepAudio, true);
    assert.ok(source?.endsWith("opencode-voice.json"));
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it("config file chatModel is honored", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ocv-cfg-"));
    const dotOpencode = path.join(dir, ".opencode");
    await fs.promises.mkdir(dotOpencode, { recursive: true });
    await fs.promises.writeFile(
      path.join(dotOpencode, "opencode-voice.json"),
      JSON.stringify({ chatModel: "opencode/muse-spark" }),
    );
    const { config } = loadConfig({ env: {}, cwd: dir });
    assert.equal(config.chatModel, "opencode/muse-spark");
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it("configFromEnv parses lists", () => {
    const o = configFromEnv({
      OPENCODE_VOICE_MODEL_DIRS: "/a, /b ,",
      OPENCODE_VOICE_EXTRA_ARGS: "--x,--y",
    } as NodeJS.ProcessEnv);
    assert.deepEqual(o.modelSearchDirs, ["/a", "/b"]);
    assert.deepEqual(o.transcribeExtraArgs, ["--x", "--y"]);
  });
});

describe("whisper output parsing", () => {
  it("cleanTranscript strips timestamps and trims", () => {
    const raw = [
      "[00:00:00.000 --> 00:00:02.000]  hello world",
      "[00:00:02.000 --> 00:00:04.000]  how are you?",
      "",
    ].join("\n");
    assert.equal(cleanTranscript(raw), "hello world\nhow are you?");
    assert.equal(cleanTranscript("   \n \t "), "");
  });

  it("modelIDFromFilename handles ggml prefixes", () => {
    assert.equal(modelIDFromFilename("ggml-large-v3-turbo.bin"), "large-v3-turbo");
    assert.equal(modelIDFromFilename("/x/ggml-base.en.bin"), "base.en");
    assert.equal(modelIDFromFilename("custom.BIN"), "custom");
  });

  it("turbo full precision is preferred", () => {
    const ranked = [
      { id: "tiny", path: "/t", bytes: 1 },
      { id: "large-v3-turbo-q5_0", path: "/q", bytes: 1 },
      { id: "large-v3-turbo", path: "/f", bytes: 1 },
    ].sort((a, b) => modelPreferenceScore(b) - modelPreferenceScore(a));
    assert.deepEqual(ranked.map((m) => m.id), ["large-v3-turbo", "large-v3-turbo-q5_0", "tiny"]);
  });
});

describe("whisper model discovery", () => {
  it("discovers .bin files and prefers turbo", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ocv-models-"));
    await fs.promises.writeFile(path.join(dir, "ggml-tiny.bin"), Buffer.alloc(16));
    await fs.promises.writeFile(path.join(dir, "ggml-large-v3-turbo.bin"), Buffer.alloc(16));
    const provider = new WhisperCppProvider({ modelSearchDirs: [dir] });
    const models = await provider.discoverModels();
    assert.equal(models[0]?.id, "large-v3-turbo");
    assert.equal(models[0]?.preferred, true);
    const resolved = await provider.resolveModel("auto");
    assert.equal(resolved.id, "large-v3-turbo");
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it("explicit model path wins", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ocv-explicit-"));
    const custom = path.join(dir, "my-model.bin");
    await fs.promises.writeFile(custom, Buffer.alloc(32));
    const provider = new WhisperCppProvider({ modelPath: custom });
    const resolved = await provider.resolveModel("auto");
    assert.equal(resolved.path, custom);
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it("missing model raises model_missing (never downloads)", async () => {
    const provider = new WhisperCppProvider({ modelSearchDirs: ["/nonexistent-dir-xyz"] });
    await assert.rejects(() => provider.resolveModel("auto"), (error: unknown) => {
      return (
        error instanceof Error &&
        "code" in error &&
        (error as { code: string }).code === "model_missing"
      );
    });
  });

  it("buildArgs passes model, audio, language and txt output", () => {
    const provider = new WhisperCppProvider({ threads: 2 });
    const args = provider.buildArgs("/tmp/a.wav", "/m/model.bin", { language: "en" });
    assert.ok(args.includes("--model") && args.includes("/m/model.bin"));
    assert.ok(args.includes("--file") && args.includes("/tmp/a.wav"));
    assert.ok(args.includes("--language") && args.includes("en"));
    assert.ok(args.includes("--output-txt"));
    assert.ok(args.includes("--no-prints"));
    assert.equal(provider.outputTextPath("/tmp/a.wav"), "/tmp/a.wav.transcript.txt");
  });
});

describe("recorder helpers", () => {
  it("toAvSelector normalizes device selectors", () => {
    assert.equal(toAvSelector("auto"), ":auto");
    assert.equal(toAvSelector("0"), ":0");
    assert.equal(toAvSelector(":1"), ":1");
    assert.equal(toAvSelector("MacBook Air Microphone"), ":MacBook Air Microphone");
  });

  it("parseAvDevices extracts the audio section only", () => {
    const output = [
      "[AVFoundation indev] AVFoundation video devices:",
      "[AVFoundation indev] [0] FaceTime HD Camera",
      "[AVFoundation indev] AVFoundation audio devices:",
      "[AVFoundation indev] [0] BlackHole 2ch",
      "[AVFoundation indev] [1] MacBook Air Microphone",
    ].join("\n");
    const devices = parseAvDevices(output);
    assert.deepEqual(devices, [
      { id: "0", label: "BlackHole 2ch", isDefault: true },
      { id: "1", label: "MacBook Air Microphone", isDefault: false },
    ]);
  });

  it("parseAlsaDevices parses arecord -l", () => {
    const output = [
      "**** List of CAPTURE Hardware Devices ****",
      "card 0: PCH [HDA Intel PCH], device 0: ALC285 Analog [ALC285 Analog]",
      "  Subdevices: 1/1",
      "card 1: USB [USB Audio], device 0: USB Audio [USB Audio]",
    ].join("\n");
    const devices = parseAlsaDevices(output);
    assert.equal(devices.length, 2);
    assert.equal(devices[0]?.id, "hw:0,0");
    assert.equal(devices[1]?.id, "hw:1,0");
  });
});
