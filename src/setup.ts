#!/usr/bin/env node
/**
 * First-run setup wizard for OpenCode Voice.
 *
 * The wizard is deliberately conservative: it detects everything first,
 * explains every install command, and only runs commands after confirmation.
 * It never downloads a model or edits an OpenCode project file silently.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadConfig } from "./core/config.js";
import { FfmpegRecorder } from "./recorder/ffmpeg.js";
import {
  TRANSCRIBE_CPP_ID,
  TranscribeCppProvider,
} from "./providers/transcribe-cpp.js";
import {
  WHISPER_CPP_ID,
  WhisperCppProvider,
} from "./providers/whisper-cpp.js";
import type { SpeechModel, VoiceConfig } from "./core/types.js";
import { runCommand, which } from "./utils/process.js";

export interface SetupArgs {
  check: boolean;
  yes: boolean;
  json: boolean;
  help: boolean;
}

export interface SetupCommand {
  executable: string;
  args: string[];
  display: string;
  interactive?: boolean;
}

export interface SetupAction {
  id: string;
  title: string;
  commands: SetupCommand[];
  note: string;
}

export interface SetupProviderStatus {
  id: string;
  name: string;
  available: boolean;
  executable?: string;
  models: SpeechModel[];
  hint: string;
}

export interface SetupSnapshot {
  configFile?: string;
  providers: SetupProviderStatus[];
  microphone: {
    available: boolean;
    devices: string[];
    hint: string;
  };
  selectedProvider?: string;
  selectedModel?: SpeechModel;
  ready: boolean;
  actions: SetupAction[];
}

interface SetupEnvironment {
  platform: NodeJS.Platform;
  home: string;
  commands: Set<string>;
}

interface SetupOptions {
  cwd?: string;
  env?: SetupEnvironment;
}

const HANDY_REPOSITORY = "handy-computer/whisper-large-v3-turbo-gguf";

export function parseSetupArgs(argv: string[]): SetupArgs {
  const args = argv[0] === "setup" ? argv.slice(1) : argv;
  return {
    check: args.includes("--check"),
    yes: args.includes("--yes") || args.includes("-y"),
    json: args.includes("--json"),
    help: args.includes("--help") || args.includes("-h"),
  };
}

export function setupUsage(): string {
  return [
    "OpenCode Voice setup",
    "",
    "Usage:",
    "  npx opencode-voice setup              detect and configure",
    "  npx opencode-voice setup --check      detect only (CI-friendly)",
    "  npx opencode-voice setup --yes        accept supported installs",
    "  npx opencode-voice setup --json       print machine-readable status",
  ].join("\n");
}

function defaultEnvironment(): SetupEnvironment {
  const names = [
    "brew",
    "cmake",
    "apt-get",
    "dnf",
    "ffmpeg",
    "hf",
    "pip3",
    "python3",
    "pacman",
    "transcribe-cli",
    "transcribe",
    "whisper-cli",
    "whisper-cpp",
    "whisper",
    "winget",
  ];
  return {
    platform: process.platform,
    home: os.homedir(),
    commands: new Set(names.filter((name) => Boolean(which([name])))),
  };
}

function hasCommand(env: SetupEnvironment, name: string): boolean {
  return env.commands.has(name);
}

function commandLine(executable: string, args: string[]): string {
  return [executable, ...args]
    .map((part) => (/^[A-Za-z0-9_./:=@%+,-]+$/.test(part) ? part : JSON.stringify(part)))
    .join(" ");
}

function ffmpegAction(env: SetupEnvironment): SetupAction {
  if (env.platform === "darwin" && hasCommand(env, "brew")) {
    return {
      id: "ffmpeg",
      title: "Install ffmpeg",
      commands: [
        makeCommand("brew", ["install", "ffmpeg"]),
      ],
      note: "ffmpeg records and normalizes microphone audio.",
    };
  }
  if (env.platform === "win32" && hasCommand(env, "winget")) {
    return {
      id: "ffmpeg",
      title: "Install ffmpeg",
      commands: [
        makeCommand("winget", [
          "install",
          "--id",
          "Gyan.FFmpeg.Shared",
          "--exact",
          "--accept-source-agreements",
          "--accept-package-agreements",
        ]),
      ],
      note: "ffmpeg records and normalizes microphone audio.",
    };
  }
  if (env.platform === "linux") {
    if (hasCommand(env, "apt-get")) {
      return manualAction("ffmpeg", "Install ffmpeg", "Run `sudo apt-get install ffmpeg`.");
    }
    if (hasCommand(env, "dnf")) {
      return manualAction("ffmpeg", "Install ffmpeg", "Run `sudo dnf install ffmpeg`.");
    }
    if (hasCommand(env, "pacman")) {
      return manualAction("ffmpeg", "Install ffmpeg", "Run `sudo pacman -S ffmpeg`.");
    }
  }
  return manualAction(
    "ffmpeg",
    "Install ffmpeg",
    "Install ffmpeg with your platform package manager and ensure it is on PATH.",
  );
}

function whisperAction(env: SetupEnvironment): SetupAction {
  if (env.platform === "darwin" && hasCommand(env, "brew")) {
    return {
      id: "whisper-cpp",
      title: "Install whisper.cpp fallback",
      commands: [makeCommand("brew", ["install", "whisper-cpp"])],
      note: "This provides whisper-cli for compatible GGML .bin models.",
    };
  }
  return manualAction(
    "whisper-cpp",
    "Install a transcription runtime",
    "Install transcribe-cli or whisper.cpp from the links in the README, then rerun setup.",
  );
}

function modelAction(env: SetupEnvironment, selectedProvider?: string): SetupAction {
  const modelDir = path.join(env.home, ".cache", "opencode-voice", "models");
  if (selectedProvider === WHISPER_CPP_ID) {
    return manualAction(
      "model",
      "Download a Whisper.cpp model",
      "Download a compatible GGML .bin model from the whisper.cpp model repository, then rerun setup.",
    );
  }
  const download = makeCommand("hf", [
    "download",
    HANDY_REPOSITORY,
    "--include",
    "*.gguf",
    "--local-dir",
    modelDir,
  ]);
  if (hasCommand(env, "hf")) {
    return {
      id: "model",
      title: "Download a Handy Whisper model",
      commands: [download],
      note: `Downloads a compatible GGUF model into ${modelDir}.`,
    };
  }
  const python = hasCommand(env, "python3") ? "python3" : undefined;
  if (python) {
    return {
      id: "model",
      title: "Install the model downloader and download a model",
      commands: [
        makeCommand(python, ["-m", "pip", "install", "-U", "huggingface_hub"]),
        download,
      ],
      note: `Downloads a compatible GGUF model into ${modelDir}.`,
    };
  }
  return manualAction(
    "model",
    "Download a speech model",
    "Install the Hugging Face CLI or use an existing compatible GGUF/.bin model, then rerun setup.",
  );
}

function makeCommand(executable: string, args: string[]): SetupCommand {
  return { executable, args, display: commandLine(executable, args) };
}

function manualAction(id: string, title: string, note: string): SetupAction {
  return { id, title, commands: [], note };
}

async function providerStatus(
  provider: TranscribeCppProvider | WhisperCppProvider,
): Promise<SetupProviderStatus> {
  const [available, models] = await Promise.all([
    provider.isAvailable(),
    provider.discoverModels().catch(() => []),
  ]);
  let executable: string | undefined;
  if (available) executable = await provider.resolveExecutable().catch(() => undefined);
  return {
    id: provider.id,
    name: provider.name,
    available,
    executable,
    models,
    hint: available ? "" : provider.availabilityHint(),
  };
}

function providerOrder(config: VoiceConfig): string[] {
  if (config.provider === WHISPER_CPP_ID) return [WHISPER_CPP_ID];
  return [TRANSCRIBE_CPP_ID, WHISPER_CPP_ID];
}

function makeProviderConfig(config: VoiceConfig, id: string): {
  executablePath?: string;
  modelPath?: string;
  modelSearchDirs: string[];
} {
  const explicitModelMatches = config.modelPath
    ? id === TRANSCRIBE_CPP_ID
      ? config.modelPath.toLowerCase().endsWith(".gguf")
      : config.modelPath.toLowerCase().endsWith(".bin")
    : false;
  return {
    executablePath: config.provider === id ? config.executablePath : undefined,
    modelPath: explicitModelMatches ? config.modelPath : undefined,
    modelSearchDirs: config.modelSearchDirs,
  };
}

export async function inspectSetup(options: SetupOptions = {}): Promise<SetupSnapshot> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? defaultEnvironment();
  const { config, source } = loadConfig({ cwd });
  const transcribe = new TranscribeCppProvider(makeProviderConfig(config, TRANSCRIBE_CPP_ID));
  const whisper = new WhisperCppProvider(makeProviderConfig(config, WHISPER_CPP_ID));
  const providers = await Promise.all([
    providerStatus(transcribe),
    providerStatus(whisper),
  ]);
  const recorder = new FfmpegRecorder();
  const microphoneAvailable = await recorder.isAvailable();
  const devices = microphoneAvailable
    ? await recorder.listDevices().catch(() => [])
    : [];

  let selectedProvider: SetupProviderStatus | undefined;
  for (const id of providerOrder(config)) {
    const candidate = providers.find((item) => item.id === id);
    if (candidate?.available) {
      selectedProvider = candidate;
      break;
    }
  }
  const selectedModel = selectedProvider
    ? selectedProvider.models.find((model) => model.preferred) ?? selectedProvider.models[0]
    : undefined;
  const actions: SetupAction[] = [];
  if (!microphoneAvailable) actions.push(ffmpegAction(env));
  if (!selectedProvider) actions.push(whisperAction(env));
  if (!selectedModel) actions.push(modelAction(env, selectedProvider?.id));

  return {
    configFile: source,
    providers,
    microphone: {
      available: microphoneAvailable,
      devices: devices.map((device) => device.label),
      hint: microphoneAvailable
        ? ""
        : recorder.availabilityHint(),
    },
    selectedProvider: selectedProvider?.id,
    selectedModel,
    ready: Boolean(selectedProvider && selectedModel && microphoneAvailable),
    actions,
  };
}

export function formatSetup(snapshot: SetupSnapshot): string {
  const lines = ["OpenCode Voice setup", ""];
  for (const provider of snapshot.providers) {
    const mark = provider.available ? "✓" : "✗";
    lines.push(`${mark} ${provider.name}: ${provider.available ? provider.executable ?? "available" : "not found"}`);
    if (provider.models.length > 0) {
      const preferred = provider.models.find((model) => model.preferred) ?? provider.models[0];
      lines.push(`  Model: ${preferred?.id ?? "unknown"} (${preferred?.path ?? "unknown"})`);
    }
  }
  lines.push(
    `${snapshot.microphone.available ? "✓" : "✗"} Microphone: ${snapshot.microphone.available ? snapshot.microphone.devices.join(", ") || "available" : "not available"}`,
    "",
    snapshot.ready
      ? `Status: ready (${snapshot.selectedProvider}, ${snapshot.selectedModel?.id ?? "auto"})`
      : "Status: setup required",
  );
  if (snapshot.configFile) lines.push(`Config: ${snapshot.configFile}`);
  for (const action of snapshot.actions) {
    lines.push("", `${action.title}:`, `  ${action.note}`);
    for (const command of action.commands) lines.push(`  $ ${command.display}`);
  }
  return lines.join("\n");
}

async function confirm(rl: readline.Interface, question: string): Promise<boolean> {
  const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

async function runAction(action: SetupAction): Promise<boolean> {
  if (action.commands.length === 0) return false;
  for (const command of action.commands) {
    if (command.interactive) {
      console.log(`Run this command manually, then rerun setup:\n  $ ${command.display}`);
      return false;
    }
    console.log(`Running: ${command.display}`);
    const result = await runCommand(command.executable, {
      args: command.args,
      timeoutMs: 30 * 60 * 1000,
    });
    if (result.exitCode !== 0) {
      const detail = `${result.stderr}\n${result.stdout}`.trim().split("\n").slice(-3).join(" ");
      console.log(`Install command failed${detail ? `: ${detail}` : "."}`);
      return false;
    }
  }
  return true;
}

async function saveGlobalProvider(provider: string): Promise<string> {
  const configDir = process.env.OPENCODE_CONFIG_DIR ?? path.join(os.homedir(), ".config", "opencode");
  const configPath = path.join(configDir, "opencode-voice.json");
  let current: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(configPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed as Record<string, unknown>;
  } catch {
    // Missing config is expected. Invalid JSON is not overwritten.
    try {
      await fs.access(configPath);
      throw new Error(`Existing config is not valid JSON: ${configPath}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Existing config")) throw error;
    }
  }
  current.provider = provider;
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
  return configPath;
}

export async function runSetupWizard(options: {
  cwd?: string;
  yes?: boolean;
  output?: (line: string) => void;
} = {}): Promise<SetupSnapshot> {
  const print = options.output ?? console.log;
  let snapshot = await inspectSetup({ cwd: options.cwd });
  print(formatSetup(snapshot));
  if (snapshot.ready) return snapshot;

  const rl = options.yes ? undefined : readline.createInterface({ input, output });
  try {
    const attempted = new Set<string>();
    while (!snapshot.ready) {
      const action = snapshot.actions.find(
        (candidate) => !attempted.has(`${candidate.id}:${snapshot.selectedProvider ?? "none"}`),
      );
      if (!action) break;
      attempted.add(`${action.id}:${snapshot.selectedProvider ?? "none"}`);
      if (action.commands.length === 0) {
        print(`\n${action.title}: ${action.note}`);
        break;
      }
      const approved = options.yes || (rl ? await confirm(rl, `${action.title}?`) : false);
      if (!approved) {
        print(`Skipped: ${action.title}`);
        continue;
      }
      await runAction(action);
      snapshot = await inspectSetup({ cwd: options.cwd });
    }

    if (snapshot.ready && snapshot.selectedProvider) {
      const shouldSave = options.yes || (rl ? await confirm(rl, `Save ${snapshot.selectedProvider} as the default provider?`) : false);
      if (shouldSave) {
        const configPath = await saveGlobalProvider(snapshot.selectedProvider);
        print(`Saved provider configuration: ${configPath}`);
      }
    }
    print("\n" + formatSetup(snapshot));
    return snapshot;
  } finally {
    rl?.close();
  }
}

async function main(): Promise<void> {
  const args = parseSetupArgs(process.argv.slice(2));
  if (args.help) {
    console.log(setupUsage());
    return;
  }
  const snapshot = args.check
    ? await inspectSetup()
    : await runSetupWizard({ yes: args.yes });
  if (args.check) {
    console.log(args.json ? JSON.stringify(snapshot, null, 2) : formatSetup(snapshot));
  } else if (args.json) {
    console.log(JSON.stringify(snapshot, null, 2));
  }
  if (!snapshot.ready) process.exitCode = 2;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
