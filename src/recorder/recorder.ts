/**
 * Recorder abstraction. The job manager and UI only depend on these
 * interfaces; platform specifics (AVFoundation/ALSA/dshow, sox, …) live in
 * the concrete implementations so hardware can be stubbed in tests.
 */
import { VoiceError } from "../core/types.js";

export interface RecorderStartOptions {
  /** Destination WAV path. The recorder must create it. */
  outputPath: string;
  /** `auto` = system default input. Otherwise a device name/index. */
  device: string;
  sampleRate: number;
  channels: number;
  /** For status/telemetry display only. */
  onStderrLine?: (line: string) => void;
}

export interface ActiveRecording {
  /** Resolved device description (for status display). */
  deviceLabel: string;
  startedAt: number;
  /** Stop gracefully and finalize the file. Resolves with final size. */
  stop(): Promise<{ path: string; bytes: number }>;
  /**
   * Abort the recording. The recorder kills the subprocess and deletes any
   * partial file. Never throws for missing files.
   */
  cancel(): Promise<void>;
  /** True while the underlying process appears alive. */
  isRunning(): boolean;
}

export interface AudioRecorder {
  readonly id: string;
  /** Fast capability probe; never throws. */
  isAvailable(): Promise<boolean>;
  /** Human-readable reason when unavailable. */
  availabilityHint(): string;
  /** List input devices (best effort; may be empty with `available:true`). */
  listDevices(): Promise<AudioDevice[]>;
  start(options: RecorderStartOptions): Promise<ActiveRecording>;
}

export interface AudioDevice {
  id: string;
  label: string;
  isDefault?: boolean;
}

export function microphonePermissionDenied(message?: string): VoiceError {
  return new VoiceError(
    "microphone_permission_denied",
    message ??
      "Microphone permission denied. Allow microphone access for your terminal, then try again.",
    process.platform === "darwin"
      ? "System Settings → Privacy & Security → Microphone → enable your terminal app."
      : undefined,
  );
}

export function noMicrophone(message?: string): VoiceError {
  return new VoiceError(
    "no_microphone",
    message ?? "No microphone input device was found.",
    "Connect/enable a microphone and check the configured device.",
  );
}
