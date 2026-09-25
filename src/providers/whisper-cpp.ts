/**
 * whisper.cpp provider (`whisper-cli` compatible).
 *
 * - Detects `whisper-cli` / `whisper-cpp` / `whisper` on PATH (or an explicit
 *   configured path). Never installs or downloads anything.
 * - Discovers existing `ggml-*.bin` models in sensible user locations,
 *   preferring Whisper Large V3 Turbo when present.
 * - Transcribes 16 kHz mono WAV files by spawning the CLI and reading its
 *   `--output-txt` file (with stdout fallback parsing).
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
import {
  registerProvider,
  type ProviderCapabilities,
  type SpeechProvider,
} from "./provider.js";

export const WHISPER_CPP_ID = "whisper.cpp";

/** Executable names accepted on PATH, in preference order. */
export const EXECUTABLE_NAMES = [
  "whisper-cli",
  "whisper-cpp",
  "whisper",
  "main",
];

/** Extra install hint per platform when the executable is missing. */
export function installHint(): string {
  switch (process.platform) {
    case "darwin":
      return "Install whisper.cpp (e.g. `brew install whisper-cpp`) or set OPENCODE_VOICE_WHISPER_BIN to the executable path.";
    case "linux":
      return "Install whisper.cpp (e.g. build from https://github.com/ggml-org/whisper.cpp) or set OPENCODE_VOICE_WHISPER_BIN.";
    case "win32":
      return "Install a whisper.cpp Windows build (see https://github.com/ggml-org/whisper.cpp) or set OPENCODE_VOICE_WHISPER_BIN.";
    default:
      return "Install whisper.cpp or set OPENCODE_VOICE_WHISPER_BIN to the executable path.";
  }
}

/** Default model search directories (only existing ones are scanned). */
export function defaultModelSearchDirs(): string[] {
  const home = os.homedir();
  const dirs = [
    path.join(home, ".cache", "whisper"),
    path.join(home, ".local", "share", "whisper"),
    path.join(home, "whisper.cpp", "models"),
    path.join(home, ".cache", "huggingface", "hub"),
    path.join(home, ".cache", "opencode-voice", "models"),
  ];
  if (process.platform === "darwin") {
    dirs.push(
      path.join(home, "Library", "Caches", "whisper"),
      path.join(home, "Library", "Application Support", "whisper"),
    );
  }
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    dirs.push(path.join(process.env.LOCALAPPDATA, "whisper", "models"));
  }
  return dirs;
}

/** Guess a stable model id from a ggml filename. */
export function modelIDFromFilename(fileName: string): string {
  const base = path.basename(fileName);
  const match = /^(.+)\.bin$/i.exec(base);
  const stem = (match?.[1] ?? base).toLowerCase();
  return stem.startsWith("ggml-") ? stem.slice("ggml-".length) : stem;
}

/** Higher score = more preferred. Turbo full-precision wins. */
export function modelPreferenceScore(model: SpeechModel): number {
  const id = model.id.toLowerCase();
  if (id === "large-v3-turbo") return 100;
  if (id.startsWith("large-v3-turbo-q")) return 90;
  if (id === "large-v3") return 80;
  if (id.startsWith("large-v3-q")) return 70;
  if (id.startsWith("large")) return 60;
  if (id.startsWith("medium")) return 50;
  if (id.startsWith("small")) return 40;
  if (id.startsWith("base")) return 30;
  if (id.startsWith("tiny")) return 20;
  return 10;
}

/**
 * Clean raw whisper/transcribe text output: strip segment timestamps like
 * `[00:00:00.000 --> 00:00:02.000]` (whisper.cpp) or `[   0.00 ->    3.60]`
 * (transcribe.cpp), drop empty lines, trim.
 */
export function cleanTranscript(raw: string): string {
  return raw
    .split("\n")
    .map((line) =>
      line
        .replace(/\[(\d{2}:)?\d{2}:\d{2}[.,]\d{3}\s*-->\s*(\d{2}:)?\d{2}:\d{2}[.,]\d{3}\]/g, "")
        .replace(/\[\s*\d+\.\d+\s*->\s*\d+\.\d+\s*\]/g, "")
        .trim(),
    )
    .filter((line) => line.length > 0)
    .join("\n")
    .trim();
}

export interface WhisperCppOptions {
  executablePath?: string;
  modelPath?: string;
  modelSearchDirs?: string[];
  threads?: number;
  timeoutMs?: number;
  extraArgs?: string[];
}

export class WhisperCppProvider implements SpeechProvider {
  readonly id = WHISPER_CPP_ID;
  readonly name = "whisper.cpp (local)";
  private opts: WhisperCppOptions;
  private cachedExecutable?: string;
  private cachedModels?: SpeechModel[];

  constructor(opts: WhisperCppOptions = {}) {
    this.opts = opts;
  }

  capabilities(): ProviderCapabilities {
    return { supportsDownload: false, persistentServer: false };
  }

  availabilityHint(): string {
    return installHint();
  }

  /** Resolve the executable (cached). Throws VoiceError when missing. */
  async resolveExecutable(): Promise<string> {
    if (this.cachedExecutable) return this.cachedExecutable;
    const explicit =
      this.opts.executablePath ??
      envExecutable("OPENCODE_VOICE_WHISPER_BIN") ??
      envExecutable("OPENCODE_VOICE_EXECUTABLE_PATH");
    if (explicit) {
      if (await fileExists(explicit)) {
        this.cachedExecutable = explicit;
        return explicit;
      }
      throw new VoiceError(
        "executable_missing",
        `Configured whisper executable not found: ${explicit}`,
        "Check the path or unset OPENCODE_VOICE_WHISPER_BIN.",
      );
    }
    const found = which(EXECUTABLE_NAMES, [
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ]);
    if (found) {
      this.cachedExecutable = found;
      return found;
    }
    throw new VoiceError(
      "executable_missing",
      `No whisper executable found (looked for ${EXECUTABLE_NAMES.join(", ")} on PATH).`,
      installHint(),
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
    try {
      const exe = await this.resolveExecutable();
      const result = await runCommand(exe, {
        args: ["--version"],
        timeoutMs: 10_000,
      });
      const out = `${result.stdout}\n${result.stderr}`.trim();
      return out ? out.split("\n")[0]?.trim() : undefined;
    } catch {
      return undefined;
    }
  }

  async discoverModels(refresh = false): Promise<SpeechModel[]> {
    if (this.cachedModels && !refresh) return this.cachedModels;
    const found = new Map<string, SpeechModel>();

    // 1. Explicit model path always wins and is always listed first.
    if (this.opts.modelPath) {
      const p = this.opts.modelPath;
      if (await fileExists(p)) {
        const abs = path.resolve(p);
        found.set(abs, {
          id: modelIDFromFilename(abs),
          path: abs,
          bytes: await fileSize(abs),
          preferred: true,
        });
      }
    }

    const dirs = [
      ...(this.opts.modelSearchDirs ?? []),
      ...defaultModelSearchDirs(),
    ];
    for (const dir of dirs) {
      for (const model of await scanModelsDir(dir)) {
        if (!found.has(model.path)) found.set(model.path, model);
      }
    }

    const models = [...found.values()].sort(
      (a, b) => modelPreferenceScore(b) - modelPreferenceScore(a),
    );
    // Mark the top pick as preferred when no explicit model was given.
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
          "Check OPENCODE_VOICE_MODEL_PATH or place a ggml-*.bin model in a search directory.",
        );
      }
      return {
        id: modelIDFromFilename(abs),
        path: abs,
        bytes: await fileSize(abs),
        preferred: true,
      };
    }

    if (want === "" || want === "auto") {
      const best = models[0];
      if (!best) throw missingModelError(want);
      return best;
    }

    // Accept an absolute/relative path directly.
    if (
      want.endsWith(".bin") ||
      want.includes("/") ||
      (process.platform === "win32" && want.includes("\\"))
    ) {
      const abs = path.resolve(want);
      if (!(await fileExists(abs))) {
        throw new VoiceError(
          "model_missing",
          `Model file not found: ${want}`,
          "Pass a valid ggml-*.bin path or use `auto`.",
        );
      }
      return { id: modelIDFromFilename(abs), path: abs, bytes: await fileSize(abs) };
    }

    // Match by id or filename (with or without ggml- prefix / .bin suffix).
    const normalized = want.toLowerCase().replace(/^ggml-/, "").replace(/\.bin$/, "");
    const exact = models.find(
      (m) =>
        m.id.toLowerCase() === normalized ||
        path.basename(m.path).toLowerCase() === `${normalized}.bin` ||
        path.basename(m.path).toLowerCase() === `ggml-${normalized}.bin`,
    );
    if (exact) return exact;

    // Well-known shorthand: a bare family name picks the best of that family.
    const family = models
      .filter((m) => m.id.toLowerCase().startsWith(normalized))
      .sort((a, b) => modelPreferenceScore(b) - modelPreferenceScore(a))[0];
    if (family) return family;

    throw missingModelError(want);
  }

  buildArgs(audioPath: string, modelPath: string, options: TranscriptionOptions): string[] {
    const outputPrefix = `${audioPath}.transcript`;
    const args = [
      "--model",
      modelPath,
      "--file",
      audioPath,
      "--language",
      options.language && options.language !== "" ? options.language : "auto",
      "--threads",
      String(options.threads ?? this.opts.threads ?? defaultThreads()),
      "--output-txt",
      "--output-file",
      outputPrefix,
      "--no-prints",
    ];
    if (options.extraArgs?.length) args.push(...options.extraArgs);
    else if (this.opts.extraArgs?.length) args.push(...this.opts.extraArgs);
    return args;
  }

  outputTextPath(audioPath: string): string {
    return `${audioPath}.transcript.txt`;
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
        "Re-download the model; see the README for the official source.",
      );
    }

    const args = this.buildArgs(audioPath, model.path, options);
    const timeoutMs = options.timeoutMs ?? this.opts.timeoutMs ?? 10 * 60 * 1000;
    const result = await runCommand(exe, {
      args,
      timeoutMs,
      signal: options.signal,
    });

    if (options.signal?.aborted) {
      await cleanupTranscriptFiles(audioPath);
      throw new VoiceError("job_cancelled", "Transcription was cancelled.");
    }
    if (result.timedOut) {
      await cleanupTranscriptFiles(audioPath);
      throw new VoiceError(
        "transcription_timeout",
        `Transcription timed out after ${Math.round(timeoutMs / 1000)}s.`,
        "Try a smaller/faster (quantized) model or shorter recordings.",
      );
    }
    if (result.exitCode !== 0) {
      await cleanupTranscriptFiles(audioPath);
      const detail = lastLines(`${result.stderr}\n${result.stdout}`, 6);
      throw new VoiceError(
        "transcription_failed",
        `whisper failed (exit ${result.exitCode ?? "?"}).${detail ? ` ${detail}` : ""}`,
        "Run with debug enabled to see the full command output.",
      );
    }

    // Prefer the clean .txt output; fall back to parsing stdout.
    let text = "";
    const txtPath = this.outputTextPath(audioPath);
    if (await fileExists(txtPath)) {
      try {
        text = await fs.promises.readFile(txtPath, "utf8");
      } catch {
        text = "";
      }
    }
    if (!text.trim()) {
      text = cleanTranscript(result.stdout);
    } else {
      text = text.trim();
    }
    await cleanupTranscriptFiles(audioPath);

    if (!text) {
      // Silence / no speech is a successful (empty) result, not an error.
      return {
        text: "",
        language: options.language === "auto" ? undefined : options.language,
        durationMs: Date.now() - started,
        providerID: this.id,
        model: model.path,
      };
    }
    return {
      text,
      language: options.language === "auto" ? undefined : options.language,
      durationMs: Date.now() - started,
      providerID: this.id,
      model: model.path,
    };
  }
}

function missingModelError(want: string): VoiceError {
  return new VoiceError(
    "model_missing",
    `No compatible model found${want && want !== "auto" ? ` matching "${want}"` : ""}.`,
    "Place a ggml-*.bin model (e.g. ggml-large-v3-turbo.bin from https://huggingface.co/ggerganov/whisper.cpp) in ~/.cache/whisper, or set OPENCODE_VOICE_MODEL_PATH. Models are never downloaded automatically.",
  );
}

/** Scan one directory (non-recursive) plus one HF-hub level for ggml bins. */
async function scanModelsDir(dir: string): Promise<SpeechModel[]> {
  const out: SpeechModel[] = [];
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && /\.bin$/i.test(entry.name)) {
      out.push({
        id: modelIDFromFilename(entry.name),
        path: full,
        bytes: await fileSize(full),
      });
    } else if (entry.isDirectory() && dir.endsWith("hub") && entry.name.startsWith("models--")) {
      // HuggingFace hub layout: models--<org>--<repo>/snapshots/<hash>/*.bin
      out.push(...(await scanHfSnapshots(full)));
    }
  }
  return out;
}

async function scanHfSnapshots(hubModelDir: string): Promise<SpeechModel[]> {
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
      if (!file.isFile() || !/\.bin$/i.test(file.name)) continue;
      const full = path.join(snapDir, file.name);
      out.push({
        id: modelIDFromFilename(file.name),
        path: full,
        bytes: await fileSize(full),
      });
    }
  }
  return out;
}

async function cleanupTranscriptFiles(audioPath: string): Promise<void> {
  const prefix = `${audioPath}.transcript`;
  for (const ext of [".txt", ".vtt", ".srt", ".json", ".csv"]) {
    try {
      await fs.promises.unlink(`${prefix}${ext}`);
    } catch {
      /* ignore */
    }
  }
}

function lastLines(text: string, count: number): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^\[.*\b(ggml|whisper|build|system|main)\b.*\]/i.test(l));
  return lines.slice(-count).join(" ").slice(0, 500);
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
  id: WHISPER_CPP_ID,
  create: (config: VoiceConfig) =>
    new WhisperCppProvider({
      executablePath: config.executablePath,
      modelPath: config.modelPath,
      modelSearchDirs: config.modelSearchDirs,
      threads: config.threads,
      timeoutMs: config.transcriptionTimeoutMs,
      extraArgs: config.transcribeExtraArgs,
    }),
});
