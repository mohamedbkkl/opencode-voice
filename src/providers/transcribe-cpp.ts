/**
 * transcribe.cpp provider (`transcribe-cli`, GGUF models).
 *
 * Preferred provider for OpenCode Voice: local GGUF inference via the ggml
 * runtime with Metal acceleration on Apple Silicon (automatic when built for
 * arm64). Model input is the exact Handy GGUF, e.g.
 * `whisper-large-v3-turbo-Q8_0.gguf` — discovered, never downloaded.
 *
 * transcribe-cli requires **16 kHz mono WAV** input. Recordings already match,
 * but any other audio is normalized with ffmpeg before inference (temporary
 * converted file, always cleaned up).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  VoiceError,
  type SpeechModel,
  type TranscriptionOptions,
  type TranscriptionResult,
  type VoiceConfig,
} from "../core/types.js";
import {
  envExecutable,
  fileExists,
  fileSize,
  runCommand,
  which,
} from "../utils/process.js";
import { cleanTranscript } from "./whisper-cpp.js";
import {
  registerProvider,
  type ProviderCapabilities,
  type SpeechProvider,
} from "./provider.js";

export const TRANSCRIBE_CPP_ID = "transcribe.cpp";

/** Executable names accepted on PATH, in preference order. */
export const TRANSCRIBE_EXECUTABLE_NAMES = ["transcribe-cli", "transcribe"];

const EXTRA_BIN_DIRS =
  process.platform === "darwin"
    ? ["/opt/homebrew/bin", "/usr/local/bin", `${os.homedir()}/.local/bin`]
    : process.platform === "linux"
      ? [`${os.homedir()}/.local/bin`]
      : [];

export function transcribeInstallHint(): string {
  return [
    "Build transcribe-cli from https://github.com/handy-computer/transcribe.cpp",
    "(`cmake -B build && cmake --build build --target transcribe-cli --config Release`,",
    "then `cmake --install build` or set OPENCODE_VOICE_TRANSCRIBE_BIN).",
    "Apple Silicon Metal acceleration is automatic in arm64 builds.",
  ].join(" ");
}

/**
 * Default model search roots. HF hub snapshots are scanned for
 * `models--handy-computer--*` GGUFs; the Handy app dir covers models
 * downloaded by the Handy macOS app. `.partial` downloads are ignored.
 */
export function defaultGgufSearchDirs(): string[] {
  const home = os.homedir();
  const dirs = [
    path.join(home, ".cache", "huggingface", "hub"),
    path.join(home, ".cache", "transcribe.cpp"),
    path.join(home, ".cache", "opencode-voice", "models"),
  ];
  if (process.platform === "darwin") {
    dirs.push(path.join(home, "Library", "Application Support", "com.pais.handy", "models"));
  }
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    dirs.push(path.join(process.env.LOCALAPPDATA, "Handy", "models"));
  }
  return dirs;
}

/** Stable model id from a GGUF filename (stem, lowercased). */
export function ggufModelID(fileName: string): string {
  const base = path.basename(fileName);
  return base.toLowerCase().endsWith(".gguf")
    ? base.slice(0, -".gguf".length).toLowerCase()
    : base.toLowerCase();
}

/** Higher score = more preferred. Turbo Q8_0 (the Handy default) wins. */
export function ggufPreferenceScore(model: SpeechModel): number {
  const id = model.id.toLowerCase();
  let score = 0;
  if (id.includes("turbo")) score += 60;
  else if (id.includes("large-v3")) score += 50;
  else if (id.includes("large")) score += 40;
  else if (id.includes("medium")) score += 30;
  else if (id.includes("small")) score += 20;
  else if (id.includes("base") || id.includes("tiny")) score += 10;
  else score += 5;
  if (id.includes("q8_0")) score += 10;
  else if (id.includes("f16")) score += 9;
  else if (id.includes("f32")) score += 8;
  else if (id.includes("q6_k")) score += 6;
  else if (id.includes("q5_k")) score += 5;
  else if (id.includes("q4_k")) score += 4;
  else score += 1;
  return score;
}

export interface TranscribeCppOptions {
  executablePath?: string;
  modelPath?: string;
  modelSearchDirs?: string[];
  threads?: number;
  timeoutMs?: number;
  extraArgs?: string[];
  /** ffmpeg binary for audio normalization (auto-detected when omitted). */
  ffmpegPath?: string;
}

export class TranscribeCppProvider implements SpeechProvider {
  readonly id = TRANSCRIBE_CPP_ID;
  readonly name = "transcribe.cpp (local, Metal)";
  private opts: TranscribeCppOptions;
  private cachedExecutable?: string;
  private cachedModels?: SpeechModel[];

  constructor(opts: TranscribeCppOptions = {}) {
    this.opts = opts;
  }

  capabilities(): ProviderCapabilities {
    return { supportsDownload: false, persistentServer: false };
  }

  availabilityHint(): string {
    return transcribeInstallHint();
  }

  async resolveExecutable(): Promise<string> {
    if (this.cachedExecutable) return this.cachedExecutable;
    const explicit =
      this.opts.executablePath ?? envExecutable("OPENCODE_VOICE_TRANSCRIBE_BIN");
    if (explicit) {
      if (await fileExists(explicit)) {
        this.cachedExecutable = explicit;
        return explicit;
      }
      throw new VoiceError(
        "executable_missing",
        `Configured transcribe executable not found: ${explicit}`,
        "Check the path or unset OPENCODE_VOICE_TRANSCRIBE_BIN.",
      );
    }
    const found = which(TRANSCRIBE_EXECUTABLE_NAMES, EXTRA_BIN_DIRS);
    if (found) {
      this.cachedExecutable = found;
      return found;
    }
    throw new VoiceError(
      "executable_missing",
      `No transcribe executable found (looked for ${TRANSCRIBE_EXECUTABLE_NAMES.join(", ")} on PATH).`,
      transcribeInstallHint(),
    );
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.resolveExecutable();
      return true;
    } catch {
      return false;
    }
  }

  /** Best-effort version string (undefined when the probe fails). */
  async version(): Promise<string | undefined> {
    for (const args of [["--version"], ["-h"]]) {
      try {
        const exe = await this.resolveExecutable();
        const result = await runCommand(exe, { args, timeoutMs: 10_000 });
        const out = `${result.stdout}\n${result.stderr}`.trim();
        const first = out.split("\n").map((l) => l.trim()).filter(Boolean)[0];
        if (first) return first.slice(0, 200);
      } catch {
        continue;
      }
    }
    return undefined;
  }

  async discoverModels(refresh = false): Promise<SpeechModel[]> {
    if (this.cachedModels && !refresh) return this.cachedModels;
    const found = new Map<string, SpeechModel>();

    if (this.opts.modelPath) {
      const abs = path.resolve(this.opts.modelPath);
      if (await fileExists(abs)) {
        found.set(abs, {
          id: ggufModelID(abs),
          path: abs,
          bytes: await fileSize(abs),
          preferred: true,
        });
      }
    }

    const dirs = [...(this.opts.modelSearchDirs ?? []), ...defaultGgufSearchDirs()];
    for (const dir of dirs) {
      for (const model of await scanGgufDir(dir)) {
        if (!found.has(model.path)) found.set(model.path, model);
      }
    }

    const models = [...found.values()].sort(
      (a, b) => ggufPreferenceScore(b) - ggufPreferenceScore(a),
    );
    if (models.length > 0 && !this.opts.modelPath && models[0]) {
      models[0] = { ...models[0], preferred: true };
    }
    this.cachedModels = models;
    return models;
  }

  async refreshModels(): Promise<SpeechModel[]> {
    return this.discoverModels(true);
  }

  async resolveModel(requested?: string): Promise<SpeechModel> {
    const want = (requested ?? "auto").trim();
    const models = await this.discoverModels();

    if (this.opts.modelPath) {
      const abs = path.resolve(this.opts.modelPath);
      if (!(await fileExists(abs))) {
        throw new VoiceError(
          "model_missing",
          `Configured model file not found: ${abs}`,
          "Check OPENCODE_VOICE_MODEL_PATH. Models are never downloaded automatically.",
        );
      }
      return {
        id: ggufModelID(abs),
        path: abs,
        bytes: await fileSize(abs),
        preferred: true,
      };
    }

    if (want === "" || want === "auto") {
      const best = models[0];
      if (!best) throw missingGgufError(want);
      return best;
    }

    if (
      want.endsWith(".gguf") ||
      want.includes("/") ||
      (process.platform === "win32" && want.includes("\\"))
    ) {
      const abs = path.resolve(want);
      if (!(await fileExists(abs))) {
        throw new VoiceError(
          "model_missing",
          `Model file not found: ${want}`,
          "Pass a valid *.gguf path or use `auto`.",
        );
      }
      return { id: ggufModelID(abs), path: abs, bytes: await fileSize(abs) };
    }

    const normalized = want.toLowerCase().replace(/\.gguf$/, "");
    const exact = models.find(
      (m) =>
        m.id.toLowerCase() === normalized ||
        path.basename(m.path).toLowerCase() === `${normalized}.gguf`,
    );
    if (exact) return exact;
    const family = models
      .filter((m) => m.id.toLowerCase().startsWith(normalized))
      .sort((a, b) => ggufPreferenceScore(b) - ggufPreferenceScore(a))[0];
    if (family) return family;
    throw missingGgufError(want);
  }

  /**
   * CLI args. transcribe-cli takes the audio as a positional argument:
   * `transcribe-cli -m model.gguf input.wav`.
   */
  buildArgs(audioPath: string, modelPath: string, options: TranscriptionOptions): string[] {
    const args = ["--model", modelPath, "--timestamps", "none"];
    if (options.language && options.language !== "" && options.language !== "auto") {
      args.push("--language", options.language);
    }
    const threads = options.threads ?? this.opts.threads ?? defaultThreads();
    if (threads) {
      args.push("--threads", String(threads));
    }
    if (options.extraArgs?.length) args.push(...options.extraArgs);
    else if (this.opts.extraArgs?.length) args.push(...this.opts.extraArgs);
    args.push(audioPath);
    return args;
  }

  /**
   * Ensure 16 kHz mono WAV (transcribe-cli requirement). Returns the path to
   * use plus an optional converted temp file to delete afterwards.
   *
   * Fast path: our own recordings are already 16 kHz mono s16le, detected by
   * reading the 44-byte WAV header in-process (no ffprobe subprocess).
   */
  async ensureAudio(audioPath: string): Promise<{ path: string; converted?: string }> {
    if (await isReadyWav(audioPath).catch(() => false)) {
      return { path: audioPath };
    }
    const probe = await probeAudio(audioPath, this.opts.ffmpegPath).catch(() => undefined);
    if (probe && probe.codec === "pcm_s16le" && probe.sampleRate === 16000 && probe.channels === 1) {
      return { path: audioPath };
    }
    const ffmpeg = this.opts.ffmpegPath ?? which(["ffmpeg"], EXTRA_BIN_DIRS);
    if (!ffmpeg) {
      if (probe) {
        throw new VoiceError(
          "transcription_failed",
          `Audio must be 16 kHz mono WAV (found ${probe.sampleRate} Hz, ${probe.channels}ch, ${probe.codec}); ffmpeg is required to convert it.`,
          "Install ffmpeg (`brew install ffmpeg`).",
        );
      }
      // Unprobed but likely fine (our own recordings) — try directly.
      return { path: audioPath };
    }
    const converted = `${audioPath}.16k.wav`;
    const result = await runCommand(ffmpeg, {
      args: ["-hide_banner", "-loglevel", "error", "-y", "-i", audioPath,
        "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", converted],
      timeoutMs: 120_000,
    });
    if (result.exitCode !== 0 || !(await fileExists(converted))) {
      throw new VoiceError(
        "transcription_failed",
        "Could not convert audio to 16 kHz mono WAV for transcription.",
        result.stderr.trim().split("\n").slice(-2).join(" ").slice(0, 300) || undefined,
      );
    }
    return { path: converted, converted };
  }

  async transcribe(
    audioPath: string,
    options: TranscriptionOptions,
  ): Promise<TranscriptionResult> {
    const started = Date.now();
    if (!(await fileExists(audioPath))) {
      throw new VoiceError(
        "transcription_failed",
        `Audio file not found: ${audioPath}`,
        "The recording may have been cleaned up already.",
      );
    }
    const exe = await this.resolveExecutable();
    const model = await this.resolveModel(options.model);
    if (model.bytes > 0 && model.bytes < 1024 * 1024) {
      throw new VoiceError(
        "model_invalid",
        `Model file looks invalid (only ${model.bytes} bytes): ${model.path}`,
      );
    }

    const { path: inputPath, converted } = await this.ensureAudio(audioPath);
    try {
      const args = this.buildArgs(inputPath, model.path, options);
      const timeoutMs = options.timeoutMs ?? this.opts.timeoutMs ?? 10 * 60 * 1000;
      const result = await runCommand(exe, { args, timeoutMs, signal: options.signal });

      if (options.signal?.aborted) {
        throw new VoiceError("job_cancelled", "Transcription was cancelled.");
      }
      if (result.timedOut) {
        throw new VoiceError(
          "transcription_timeout",
          `Transcription timed out after ${Math.round(timeoutMs / 1000)}s.`,
          "Try a smaller quant or shorter recordings.",
        );
      }
      if (result.exitCode !== 0) {
        const detail = lastLines(`${result.stderr}\n${result.stdout}`, 6);
        throw new VoiceError(
          "transcription_failed",
          `transcribe-cli failed (exit ${result.exitCode ?? "?"}).${detail ? ` ${detail}` : ""}`,
          "Run with debug enabled to see the full command output.",
        );
      }
      // Transcript comes back on stdout inside a result envelope
      // (`text: …`, `detected-language: …`); logs live on stderr.
      const parsed = parseTranscribeStdout(result.stdout);
      return {
        text: parsed.text,
        language: parsed.language ?? (options.language === "auto" ? undefined : options.language),
        durationMs: Date.now() - started,
        providerID: this.id,
        model: model.path,
      };
    } finally {
      if (converted) {
        try {
          await fs.promises.unlink(converted);
        } catch {
          /* ignore */
        }
      }
    }
  }
}

function missingGgufError(want: string): VoiceError {
  return new VoiceError(
    "model_missing",
    `No compatible GGUF model found${want && want !== "auto" ? ` matching "${want}"` : ""}.`,
    "Reuse an existing *.gguf (e.g. the Handy whisper-large-v3-turbo GGUF in ~/.cache/huggingface/hub) or set OPENCODE_VOICE_MODEL_PATH. Models are never downloaded automatically.",
  );
}

export interface AudioProbe {
  codec: string;
  sampleRate: number;
  channels: number;
}

/** Probe the first audio stream with ffprobe (undefined when unavailable). */
export async function probeAudio(
  audioPath: string,
  ffprobePath?: string,
): Promise<AudioProbe | undefined> {
  const ffprobe =
    ffprobePath ??
    which(["ffprobe"], process.platform === "darwin" ? ["/opt/homebrew/bin", "/usr/local/bin"] : []);
  if (!ffprobe) return undefined;
  const result = await runCommand(ffprobe, {
    args: [
      "-v", "error",
      "-select_streams", "a:0",
      "-show_entries", "stream=codec_name,sample_rate,channels",
      "-of", "csv=p=0",
      audioPath,
    ],
    timeoutMs: 15_000,
  });
  if (result.exitCode !== 0) return undefined;
  const parts = result.stdout.trim().split(",");
  if (parts.length < 3) return undefined;
  const sampleRate = Number(parts[1]);
  const channels = Number(parts[2]);
  if (!parts[0] || !Number.isFinite(sampleRate) || !Number.isFinite(channels)) return undefined;
  return { codec: parts[0].trim(), sampleRate, channels };
}

/**
 * Scan one directory for completed GGUFs. HF hub dirs (`.../hub`) are
 * descended one level (`models--*` → `snapshots/*`); `.partial` files and
 * tiny files are ignored.
 */
async function scanGgufDir(dir: string): Promise<SpeechModel[]> {
  const out: SpeechModel[] = [];
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  const isHub = path.basename(dir) === "hub";
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if ((await isRegularFile(full, entry)) && isCompletedGguf(entry.name)) {
      out.push({
        id: ggufModelID(entry.name),
        path: full,
        bytes: await fileSize(full),
      });
    } else if (entry.isDirectory()) {
      if (isHub && entry.name.startsWith("models--handy-computer--")) {
        out.push(...(await scanHandySnapshots(full)));
      } else if (!isHub && !entry.name.startsWith(".")) {
        // Shallow scan of plain model dirs (e.g. the Handy app models dir).
        out.push(...(await scanFlatGguf(full)));
      }
    }
  }
  return out;
}

async function scanFlatGguf(dir: string): Promise<SpeechModel[]> {
  const out: SpeechModel[] = [];
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.slice(0, 100)) {
    if (!(await isRegularFile(path.join(dir, entry.name), entry)) || !isCompletedGguf(entry.name)) continue;
    const full = path.join(dir, entry.name);
    out.push({ id: ggufModelID(entry.name), path: full, bytes: await fileSize(full) });
  }
  return out;
}

async function scanHandySnapshots(hubModelDir: string): Promise<SpeechModel[]> {
  const out: SpeechModel[] = [];
  const snapshotsDir = path.join(hubModelDir, "snapshots");
  let snapshots: fs.Dirent[];
  try {
    snapshots = await fs.promises.readdir(snapshotsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const snap of snapshots.slice(0, 8)) {
    if (!snap.isDirectory()) continue;
    const snapDir = path.join(snapshotsDir, snap.name);
    let files: fs.Dirent[];
    try {
      files = await fs.promises.readdir(snapDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files.slice(0, 50)) {
      if (!(await isRegularFile(path.join(snapDir, file.name), file)) || !isCompletedGguf(file.name)) continue;
      const full = path.join(snapDir, file.name);
      out.push({ id: ggufModelID(file.name), path: full, bytes: await fileSize(full) });
    }
  }
  return out;
}

/** Completed GGUF only: `.gguf` suffix, never `.partial`. */
export function isCompletedGguf(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".partial")) return false;
  return lower.endsWith(".gguf");
}

/**
 * Hugging Face snapshot files are symlinks into the `blobs/` directory.
 * Dirent#isFile() is false for those entries, so resolve the target before
 * deciding whether it is a usable completed GGUF.
 */
async function isRegularFile(filePath: string, entry: fs.Dirent): Promise<boolean> {
  if (entry.isFile()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return (await fs.promises.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

/**
 * Parse transcribe-cli stdout. The CLI prints a result envelope:
 *
 *   audio: ...
 *   model: ... -> ok
 *   run: ok
 *   text: <transcript>
 *   detected-language: en
 *   segments: N
 *     [   0.00 ->    3.60] <segment>
 *
 * The `text:` block (up to detected-language/segments) is the transcript.
 * Falls back to cleaning the whole output when the envelope is absent.
 */
export function parseTranscribeStdout(stdout: string): { text: string; language?: string } {
  const lines = stdout.split("\n");
  const start = lines.findIndex((l) => /^text:\s?/.test(l));
  if (start >= 0) {
    const buf: string[] = [lines[start]?.replace(/^text:\s?/, "") ?? ""];
    let language: string | undefined;
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const langMatch = /^detected-language:\s*(\S+)/.exec(line);
      if (langMatch?.[1]) {
        language = langMatch[1];
        continue;
      }
      if (/^(segments|realtime|run|model|audio)\s*:/.test(line.trim())) break;
      buf.push(line);
    }
    const text = cleanTranscript(buf.join("\n"));
    if (text) return { text, language };
  }
  return { text: cleanTranscript(stdout) };
}

function lastLines(text: string, count: number): string {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.slice(-count).join(" ").slice(0, 500);
}

/** True when the file is already 16 kHz mono 16-bit PCM WAV (header check). */
async function isReadyWav(filePath: string): Promise<boolean> {
  const handle = await fs.promises.open(filePath, "r").catch(() => undefined);
  if (!handle) return false;
  try {
    const buf = Buffer.alloc(44);
    const { bytesRead } = await handle.read(buf, 0, 44, 0);
    if (bytesRead < 44) return false;
    if (buf.toString("ascii", 0, 4) !== "RIFF") return false;
    if (buf.toString("ascii", 8, 12) !== "WAVE") return false;
    const audioFormat = buf.readUInt16LE(20);
    const channels = buf.readUInt16LE(22);
    const sampleRate = buf.readUInt32LE(24);
    const bitsPerSample = buf.readUInt16LE(34);
    return (
      audioFormat === 1 && channels === 1 && sampleRate === 16000 && bitsPerSample === 16
    );
  } catch {
    return false;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function defaultThreads(): number {
  try {
    const { availableParallelism } = os as unknown as {
      availableParallelism?: () => number;
    };
    const n =
      typeof availableParallelism === "function"
        ? availableParallelism()
        : (os.cpus()?.length ?? 4);
    return Math.max(1, Math.min(8, Math.floor(n / 2) || 4));
  } catch {
    return 4;
  }
}

registerProvider({
  id: TRANSCRIBE_CPP_ID,
  create: (config: VoiceConfig) =>
    new TranscribeCppProvider({
      executablePath: config.executablePath,
      modelPath: config.modelPath,
      modelSearchDirs: config.modelSearchDirs,
      threads: config.threads,
      timeoutMs: config.transcriptionTimeoutMs,
      extraArgs: config.transcribeExtraArgs,
    }),
});
