/**
 * ffmpeg-based recorder.
 *
 * - macOS: AVFoundation (`-f avfoundation -i ":<device>"`)
 * - Linux: ALSA (`-f alsa -i <device>`, default `default`)
 * - Windows: dshow (`-f dshow -i audio="<device>"`)
 *
 * Records whisper-friendly audio (16 kHz mono 16-bit WAV). Stop is graceful
 * (`q` on stdin → SIGINT → SIGKILL escalation) so the WAV header is
 * finalized; cancel kills and deletes the partial file.
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { VoiceError } from "../core/types.js";
import { fileSize, removeQuietly, runCommand, which } from "../utils/process.js";
import {
  microphonePermissionDenied,
  noMicrophone,
  type ActiveRecording,
  type AudioDevice,
  type AudioRecorder,
  type RecorderStartOptions,
} from "./recorder.js";

export const FFMPEG_NAMES = ["ffmpeg"];
const EXTRA_BIN_DIRS =
  process.platform === "darwin"
    ? ["/opt/homebrew/bin", "/usr/local/bin"]
    : [];

export interface FfmpegRecorderOptions {
  executablePath?: string;
}

export class FfmpegRecorder implements AudioRecorder {
  readonly id = "ffmpeg";
  private executablePath?: string;
  private cachedBinary?: string;

  constructor(options: FfmpegRecorderOptions = {}) {
    this.executablePath = options.executablePath;
  }

  async resolveBinary(): Promise<string> {
    if (this.cachedBinary) return this.cachedBinary;
    if (this.executablePath) {
      this.cachedBinary = this.executablePath;
      return this.executablePath;
    }
    const found = which(FFMPEG_NAMES, EXTRA_BIN_DIRS);
    if (!found) {
      throw new VoiceError(
        "recorder_unavailable",
        "ffmpeg was not found on PATH.",
        process.platform === "darwin"
          ? "Install it with `brew install ffmpeg`."
          : "Install ffmpeg and ensure it is on PATH.",
      );
    }
    this.cachedBinary = found;
    return found;
  }

  async isAvailable(): Promise<boolean> {
    if (process.platform !== "darwin" && process.platform !== "linux" && process.platform !== "win32") {
      return false;
    }
    try {
      await this.resolveBinary();
      return true;
    } catch {
      return false;
    }
  }

  availabilityHint(): string {
    if (process.platform !== "darwin" && process.platform !== "linux" && process.platform !== "win32") {
      return `Audio recording is not implemented for ${process.platform} yet.`;
    }
    return "Install ffmpeg and ensure it is on PATH.";
  }

  async listDevices(): Promise<AudioDevice[]> {
    const binary = await this.resolveBinary();
    if (process.platform === "darwin") {
      // AVFoundation enumeration can take a while on a loaded system.
      const result = await runCommand(binary, {
        args: ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""],
        timeoutMs: 30_000,
      });
      if (result.timedOut) return [];
      return parseAvDevices(`${result.stdout}\n${result.stderr}`);
    }
    if (process.platform === "linux") {
      const result = await runCommand("arecord", {
        args: ["-l"],
        timeoutMs: 10_000,
      }).catch(() => undefined);
      if (!result || result.exitCode !== 0) return [];
      return parseAlsaDevices(result.stdout);
    }
    // Windows: dshow listing requires parsing; keep best-effort empty here
    // and let ffmpeg fail loudly with a clear error if the device is wrong.
    return [];
  }

  async start(options: RecorderStartOptions): Promise<ActiveRecording> {
    const binary = await this.resolveBinary();
    const args = buildInputArgs(options.device);
    args.push(
      "-vn",
      "-ar",
      String(options.sampleRate),
      "-ac",
      String(options.channels),
      "-c:a",
      "pcm_s16le",
      "-y",
      options.outputPath,
    );

    const child = spawn(binary, args, {
      stdio: ["pipe", "ignore", "pipe"],
      windowsHide: true,
    });
    const startedAt = Date.now();
    const label = describeDevice(options.device);
    let stderrTail = "";
    let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderrTail = `${stderrTail}${text}`.slice(-4000);
      const line = text.split("\n").map((l) => l.trim()).filter(Boolean).pop();
      if (line) options.onStderrLine?.(line);
    });
    child.on("exit", (code, signal) => {
      exited = { code, signal };
    });
    child.on("error", () => {
      exited = exited ?? { code: 1, signal: null };
    });

    // Give ffmpeg a moment to fail fast (bad device, permission denied…)
    // before reporting success. A healthy recorder stays alive. Do not use
    // the output file size as a startup signal: on macOS AVFoundation, the
    // WAV muxer may keep the file at zero bytes until the recording is
    // finalized, even while ffmpeg is actively receiving audio.
    // Poll in 100ms steps so fast devices return in ~100-200ms instead of
    // always paying the full 700ms.
    for (let waited = 0; waited < 400; waited += 100) {
      await sleep(100);
      if (exited && exited.code !== 0 && exited.code !== null) {
        throw classifyStartError(stderrTail, options.device);
      }
      if (/Stream #\d+:\d+:\s+Audio:/i.test(stderrTail) || /Output #\d+.*wav/i.test(stderrTail)) {
        break;
      }
      if (!isAlive(child)) break;
    }
    if (exited && exited.code !== 0 && exited.code !== null) {
      throw classifyStartError(stderrTail, options.device);
    }
    if (!isAlive(child)) {
      await sleep(700);
      const bytes = await fileSize(options.outputPath).catch(() => 0);
      if (bytes <= 0 || !isAlive(child)) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        throw classifyStartError(stderrTail || "ffmpeg exited immediately.", options.device);
      }
    }
    // AVFoundation can take several seconds to initialize an input stream.
    // Wait for ffmpeg to confirm that it has opened an audio stream before
    // returning control to the TUI. Otherwise a short recording can be
    // stopped before the WAV output is created/finalized.
    const inputReadyAt = Date.now();
    while (
      !/Stream #\d+:\d+:\s+Audio:/i.test(stderrTail) &&
      !/Output #\d+.*wav/i.test(stderrTail) &&
      Date.now() - inputReadyAt <= 10_000
    ) {
      if (!isAlive(child)) break;
      await sleep(100);
    }
    if (!/Stream #\d+:\d+:\s+Audio:/i.test(stderrTail) && !/Output #\d+.*wav/i.test(stderrTail)) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      throw classifyStartError(
        stderrTail || "ffmpeg did not initialize an audio stream within 10s.",
        options.device,
      );
    }
    let settled = false;
    const stop = async (): Promise<{ path: string; bytes: number }> => {
      if (settled) return { path: options.outputPath, bytes: await fileSize(options.outputPath) };
      settled = true;
      await gracefulStop(child);
      // WAV header is finalized on clean exit; wait briefly for the file.
      const bytes = await waitForFile(options.outputPath, 5000);
      if (bytes <= 0) {
        throw new VoiceError(
          "recorder_failed",
          "Recording produced an empty audio file.",
          "Check the microphone is not muted; if the input is a virtual driver (BlackHole, …) with no signal, set `device` explicitly.",
        );
      }
      return { path: options.outputPath, bytes };
    };
    const cancel = async (): Promise<void> => {
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      await sleep(150);
      await removeQuietly(options.outputPath);
    };

    return {
      deviceLabel: label,
      startedAt,
      stop,
      cancel,
      isRunning: () => !settled && isAlive(child),
    };
  }
}

/** Build platform input args for the given device selector. */
export function buildInputArgs(device: string): string[] {
  const want = device.trim() === "" ? "auto" : device;
  if (process.platform === "darwin") {
    // AVFoundation: `-i ":<audio>"`; "auto" uses the system default (index 0).
    const selector = want === "auto" ? ":0" : toAvSelector(want);
    return ["-hide_banner", "-f", "avfoundation", "-i", selector];
  }
  if (process.platform === "linux") {
    return ["-hide_banner", "-f", "alsa", "-i", want === "auto" ? "default" : want];
  }
  // win32
  return ["-hide_banner", "-f", "dshow", "-i", `audio=${want === "auto" ? "default" : want}`];
}

/** `:0`, `:Name` and bare `Name`/`0` all accepted; normalize to `:…`. */
export function toAvSelector(device: string): string {
  if (device.startsWith(":")) return device;
  if (/^\d+$/.test(device)) return `:${device}`;
  return `:${device}`;
}

export function describeDevice(device: string): string {
  return device === "auto" ? "system default microphone" : device;
}

/** Parse `ffmpeg -f avfoundation -list_devices true -i ""` output. */
export function parseAvDevices(output: string): AudioDevice[] {
  const devices: AudioDevice[] = [];
  let inAudio = false;
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (/AVFoundation audio devices/i.test(line)) {
      inAudio = true;
      continue;
    }
    if (/AVFoundation video devices/i.test(line)) {
      inAudio = false;
      continue;
    }
    if (!inAudio) continue;
    const m = /\[(\d+)\]\s+(.+)$/.exec(line);
    if (m?.[1] !== undefined && m[2]) {
      devices.push({ id: m[1], label: m[2].trim(), isDefault: m[1] === "0" });
    }
  }
  return devices;
}

export function parseAlsaDevices(output: string): AudioDevice[] {
  const devices: AudioDevice[] = [];
  const re = /^card\s+(\d+):\s*([^,]+),\s*device\s+(\d+):\s*(.+)$/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    devices.push({
      id: `hw:${m[1]},${m[3]}`,
      label: `${m[2]?.trim()} — ${m[4]?.trim()}`,
      isDefault: m[1] === "0" && m[3] === "0",
    });
  }
  return devices;
}

function classifyStartError(stderrTail: string, device: string): VoiceError {
  const text = stderrTail.toLowerCase();
  if (
    text.includes("permission") ||
    text.includes("not permitted") ||
    text.includes("operation not permitted") ||
    text.includes("kTCCServiceMicrophone".toLowerCase())
  ) {
    return microphonePermissionDenied(
      `Microphone permission denied while opening "${device}". Allow microphone access for your terminal, then try again.`,
    );
  }
  if (
    text.includes("no such device") ||
    text.includes("no such file") ||
    text.includes("device not found") ||
    text.includes("could not find audio device") ||
    text.includes("error opening input")
  ) {
    return noMicrophone(
      `Audio input device "${device}" is not available. Run voice diagnostics to list devices.`,
    );
  }
  const detail = stderrTail.trim().split("\n").slice(-3).join(" ").slice(0, 400);
  return new VoiceError(
    "recorder_failed",
    `Could not start recording from "${device}".${detail ? ` ${detail}` : ""}`,
    "If your default input is a virtual driver (BlackHole, Loopback, …) with no signal, set `device` explicitly (see `npm run diagnose`). Also verify microphone permission for your terminal.",
  );
}

function isAlive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

/** Ask ffmpeg to quit via `q`, escalate SIGINT → SIGKILL. */
async function gracefulStop(child: ChildProcess): Promise<void> {
  if (!isAlive(child)) return;
  try {
    child.stdin?.write("q");
  } catch {
    /* ignore */
  }
  const exited = await waitForExit(child, 2500);
  if (exited) return;
  try {
    child.kill("SIGINT");
  } catch {
    /* ignore */
  }
  if (await waitForExit(child, 2500)) return;
  try {
    child.kill("SIGKILL");
  } catch {
    /* ignore */
  }
  await waitForExit(child, 1500);
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (!isAlive(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(!isAlive(child)), timeoutMs);
    timer.unref?.();
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function waitForFile(filePath: string, timeoutMs: number): Promise<number> {
  const start = Date.now();
  for (;;) {
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.isFile() && stat.size > 0) return stat.size;
    } catch {
      /* not yet */
    }
    if (Date.now() - start > timeoutMs) {
      return fileSize(filePath).catch(() => 0);
    }
    await sleep(100);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Default recorder factory: ffmpeg when available. */
export async function createDefaultRecorder(
  executablePath?: string,
): Promise<AudioRecorder | undefined> {
  const recorder = new FfmpegRecorder({ executablePath });
  if (await recorder.isAvailable()) return recorder;
  return undefined;
}
