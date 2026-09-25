/**
 * Configuration system for OpenCode Voice.
 *
 * Precedence (highest first):
 *   1. Explicit overrides passed by the plugin entry (from `tui.json` /
 *      `opencode.json` plugin options).
 *   2. Environment variables (`OPENCODE_VOICE_*`).
 *   3. JSON config file (`opencode-voice.json` in `.opencode/` or the global
 *      OpenCode config dir, or `OPENCODE_VOICE_CONFIG` pointing at a file).
 *   4. Built-in defaults (work out of the box, no file required).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { VoiceConfig } from "./types.js";

export const DEFAULTS: VoiceConfig = {
  provider: "transcribe.cpp",
  model: "auto",
  modelPath: undefined,
  executablePath: undefined,
  modelSearchDirs: [],
  language: "auto",
  device: "auto",
  maxConcurrentTranscriptions: 1,
  keepAudio: false,
  debug: false,
  transcribeExtraArgs: [],
  threads: undefined,
  chatModel: undefined,
  transcriptionTimeoutMs: 10 * 60 * 1000,
  sampleRate: 16000,
  channels: 1,
};

const ENV_PREFIX = "OPENCODE_VOICE_";

export type ConfigOverrides = Partial<
  Pick<
    VoiceConfig,
    | "provider"
    | "model"
    | "modelPath"
    | "executablePath"
    | "modelSearchDirs"
    | "language"
    | "device"
    | "maxConcurrentTranscriptions"
    | "keepAudio"
    | "debug"
    | "transcribeExtraArgs"
    | "chatModel"
    | "threads"
    | "transcriptionTimeoutMs"
    | "sampleRate"
    | "channels"
  >
>;

/** Candidate config file locations (first existing file wins). */
export function candidateConfigFiles(cwd?: string): string[] {
  const files: string[] = [];
  const explicit = process.env[`${ENV_PREFIX}CONFIG`];
  if (explicit) files.push(explicit);
  if (cwd) files.push(path.join(cwd, ".opencode", "opencode-voice.json"));
  files.push(
    path.join(configDir(), "opencode-voice.json"),
    path.join(os.homedir(), ".opencode-voice.json"),
  );
  return files;
}

function configDir(): string {
  return (
    process.env.OPENCODE_CONFIG_DIR ??
    path.join(os.homedir(), ".config", "opencode")
  );
}

function readJsonFile(filePath: string): Record<string, unknown> | undefined {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.toLowerCase().trim();
    if (["1", "true", "yes", "on"].includes(v)) return true;
    if (["0", "false", "no", "off"].includes(v)) return false;
  }
  return undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const out = value.filter((v): v is string => typeof v === "string");
    return out;
  }
  if (typeof value === "string" && value.trim() !== "") {
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return undefined;
}

/** Read `OPENCODE_VOICE_*` env vars into partial overrides. */
export function configFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ConfigOverrides {
  const get = (name: string): string | undefined => {
    const v = env[`${ENV_PREFIX}${name}`];
    return v !== undefined && v !== "" ? v : undefined;
  };
  const overrides: ConfigOverrides = {};
  const str = (
    key: "provider" | "model" | "language" | "device",
    envName: string,
  ): void => {
    const v = get(envName);
    if (v !== undefined) overrides[key] = v;
  };
  str("provider", "PROVIDER");
  str("model", "MODEL");
  str("language", "LANGUAGE");
  str("device", "DEVICE");

  const modelPath = get("MODEL_PATH");
  if (modelPath !== undefined) overrides.modelPath = modelPath;
  // Provider-specific executable env vars, scoped to the configured provider
  // so a whisper path never leaks into transcribe.cpp (or vice versa).
  // Providers additionally honor their own env var at runtime, which is what
  // makes `provider: "auto"` work with explicit paths. See providers/.
  const provider = (get("PROVIDER")?.trim() || "transcribe.cpp").toLowerCase();
  const transcribeBin = get("TRANSCRIBE_BIN");
  const whisperBin = get("WHISPER_BIN") ?? get("EXECUTABLE_PATH");
  if (provider === "whisper.cpp") {
    if (whisperBin !== undefined) overrides.executablePath = whisperBin;
  } else if (transcribeBin !== undefined) {
    overrides.executablePath = transcribeBin;
  }

  const dirs = asStringArray(get("MODEL_DIRS"));
  if (dirs !== undefined) overrides.modelSearchDirs = dirs;

  const maxC = asNumber(get("MAX_CONCURRENT"));
  if (maxC !== undefined)
    overrides.maxConcurrentTranscriptions = Math.max(1, Math.floor(maxC));
  const keep = asBoolean(get("KEEP_AUDIO"));
  if (keep !== undefined) overrides.keepAudio = keep;
  const debug =
    asBoolean(get("DEBUG")) ?? (get("DEBUG") !== undefined ? true : undefined);
  if (debug !== undefined) overrides.debug = debug;
  const extra = asStringArray(get("EXTRA_ARGS"));
  if (extra !== undefined) overrides.transcribeExtraArgs = extra;
  const threads = asNumber(get("THREADS"));
  if (threads !== undefined) overrides.threads = Math.max(1, Math.floor(threads));
  const timeout = asNumber(get("TIMEOUT_MS"));
  if (timeout !== undefined)
    overrides.transcriptionTimeoutMs = Math.max(1000, Math.floor(timeout));
  const rate = asNumber(get("SAMPLE_RATE"));
  if (rate !== undefined) overrides.sampleRate = Math.floor(rate);
  const channels = asNumber(get("CHANNELS"));
  if (channels !== undefined) overrides.channels = Math.floor(channels);
  return overrides;
}

function normalizeFileConfig(raw: Record<string, unknown>): ConfigOverrides {
  const out: ConfigOverrides = {};
  const s = asString(raw["provider"]);
  if (s) out.provider = s;
  const m = asString(raw["model"]);
  if (m) out.model = m;
  const mp = asString(raw["modelPath"] ?? raw["model_path"]);
  if (mp) out.modelPath = mp;
  const exe = asString(raw["executablePath"] ?? raw["executable_path"]);
  if (exe) out.executablePath = exe;
  const dirs = asStringArray(raw["modelSearchDirs"] ?? raw["model_search_dirs"]);
  if (dirs) out.modelSearchDirs = dirs;
  const lang = asString(raw["language"]);
  if (lang) out.language = lang;
  const dev = asString(raw["device"]);
  if (dev) out.device = dev;
  const maxC = asNumber(
    raw["maxConcurrentTranscriptions"] ?? raw["max_concurrent_transcriptions"],
  );
  if (maxC !== undefined)
    out.maxConcurrentTranscriptions = Math.max(1, Math.floor(maxC));
  const keep = asBoolean(raw["keepAudio"] ?? raw["keep_audio"]);
  if (keep !== undefined) out.keepAudio = keep;
  const debug = asBoolean(raw["debug"]);
  if (debug !== undefined) out.debug = debug;
  const extra = asStringArray(
    raw["transcribeExtraArgs"] ?? raw["transcribe_extra_args"],
  );
  if (extra) out.transcribeExtraArgs = extra;
  const chat = asString(raw["chatModel"] ?? raw["chat_model"]);
  if (chat !== undefined) out.chatModel = chat;
  const threads = asNumber(raw["threads"]);
  if (threads !== undefined) out.threads = Math.max(1, Math.floor(threads));
  const timeout = asNumber(
    raw["transcriptionTimeoutMs"] ?? raw["transcription_timeout_ms"],
  );
  if (timeout !== undefined)
    out.transcriptionTimeoutMs = Math.max(1000, Math.floor(timeout));
  return out;
}

/**
 * Load the effective config. Never throws for missing files; invalid values
 * fall back to defaults.
 */
export function loadConfig(options?: {
  cwd?: string;
  overrides?: ConfigOverrides;
  env?: NodeJS.ProcessEnv;
}): { config: VoiceConfig; source: string | undefined } {
  const env = options?.env ?? process.env;
  let fileRaw: Record<string, unknown> | undefined;
  let source: string | undefined;
  for (const file of candidateConfigFiles(options?.cwd)) {
    const parsed = readJsonFile(file);
    if (parsed) {
      fileRaw = parsed;
      source = file;
      break;
    }
  }
  const config: VoiceConfig = {
    ...DEFAULTS,
    ...(fileRaw ? normalizeFileConfig(fileRaw) : {}),
    ...configFromEnv(env),
    ...(options?.overrides ?? {}),
  };
  if (config.maxConcurrentTranscriptions < 1)
    config.maxConcurrentTranscriptions = 1;
  return { config, source };
}
