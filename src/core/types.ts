/**
 * Shared core types for OpenCode Voice.
 *
 * This module is intentionally free of OpenCode imports so the job logic,
 * providers and recorders can be unit-tested and reused from either the
 * server plugin entry (`src/server.ts`) or the TUI plugin entry (`src/tui.ts`).
 */

/** What should happen once a transcript is ready. */
export type VoiceAction = "insert" | "insert-and-send";

/** Lifecycle of a single voice job. */
export type VoiceStatus =
  | "recording"
  | "queued"
  | "transcribing"
  | "ready"
  | "completed"
  | "cancelled"
  | "failed";

/**
 * A unit of voice work. The `instanceID` + `origin` fields are what keep a
 * transcript recorded in OpenCode window A from ever leaking into window B.
 */
export interface VoiceJob {
  /** Unique per-process job id, e.g. `voice-20260922-0001`. */
  id: string;
  /**
   * Identifies the OpenCode process that created the job
   * (`<hostname>:<pid>:<processStartTime>`). Jobs are never shared across
   * processes; each TUI/server instance only ever touches its own jobs.
   */
  instanceID: string;
  /** Project directory the originating session belongs to. */
  directory: string;
  /**
   * Where the recording was started from. `session` is the normal case;
   * `home` covers the home route prompt.
   */
  origin: { route: "session" | "home"; sessionID?: string };
  createdAt: number;
  updatedAt: number;
  /** Absolute path of the recorded audio file (deleted on cleanup). */
  audioPath?: string;
  providerID: string;
  /** Resolved model id/path used for transcription. */
  model?: string;
  language: string;
  requestedAction: VoiceAction;
  status: VoiceStatus;
  transcript?: string;
  /** Short, actionable error for UI display. Never contains audio data. */
  error?: string;
}

/** Options passed to a provider for one transcription. */
export interface TranscriptionOptions {
  /** BCP-47-ish language tag or `auto`. */
  language: string;
  /** Explicit model id or path. `auto`/undefined lets the provider decide. */
  model?: string;
  /** AbortSignal used for queue cancellation (kills the subprocess). */
  signal?: AbortSignal;
  /** Threads for inference. Undefined = provider default. */
  threads?: number;
  /** Hard timeout in ms. Undefined = provider default. */
  timeoutMs?: number;
  /** Extra provider-specific CLI args (advanced use). */
  extraArgs?: string[];
}

/** Result of a successful transcription. */
export interface TranscriptionResult {
  /** Cleaned transcript text (may be empty for silence). */
  text: string;
  /** Detected/used language, when known. */
  language?: string;
  /** Wall-clock transcription time in ms. */
  durationMs: number;
  /** Provider that produced the result. */
  providerID: string;
  /** Model id/path that was used. */
  model: string;
}

/** A locally installed speech model. */
export interface SpeechModel {
  /** Stable id, e.g. `large-v3-turbo` or `large-v3-turbo-q5_0`. */
  id: string;
  /** Absolute file path. */
  path: string;
  /** File size in bytes (0 when unknown). */
  bytes: number;
  /** True when this model is the recommended default. */
  preferred?: boolean;
}

/** Serializable snapshot used for status displays and debugging. */
export interface VoiceJobSnapshot {
  id: string;
  status: VoiceStatus;
  origin: VoiceJob["origin"];
  providerID: string;
  model?: string;
  requestedAction: VoiceAction;
  createdAt: number;
  updatedAt: number;
  hasTranscript: boolean;
  error?: string;
}

/** Machine-readable error with a stable code plus UI-safe message. */
export class VoiceError extends Error {
  readonly code: VoiceErrorCode;
  /** Actionable hint shown next to the message (may be undefined). */
  readonly hint?: string;

  constructor(code: VoiceErrorCode, message: string, hint?: string) {
    super(message);
    this.name = "VoiceError";
    this.code = code;
    this.hint = hint;
  }
}

export type VoiceErrorCode =
  | "recorder_unavailable"
  | "no_microphone"
  | "microphone_permission_denied"
  | "recorder_failed"
  | "provider_unavailable"
  | "executable_missing"
  | "model_missing"
  | "model_invalid"
  | "transcription_failed"
  | "transcription_timeout"
  | "job_cancelled"
  | "job_not_found"
  | "invalid_transition"
  | "session_mismatch"
  | "temp_file_failed"
  | "unsupported_platform"
  | "insertion_failed";

/** Resolved runtime configuration (see `src/core/config.ts`). */
export interface VoiceConfig {
  provider: string;
  /** `auto` = pick the preferred discovered model. */
  model: string;
  /** Explicit model file path (overrides `model` when set). */
  modelPath?: string;
  /** Explicit provider executable path (overrides PATH lookup). */
  executablePath?: string;
  /** Extra directories searched for models. */
  modelSearchDirs: string[];
  language: string;
  /** Audio input device (`auto` = system default). */
  device: string;
  maxConcurrentTranscriptions: number;
  keepAudio: boolean;
  debug: boolean;
  /** Extra args appended to the provider's transcription command. */
  transcribeExtraArgs: string[];
  /**
   * Chat model for fresh sessions (`"providerID/modelID"`), used only when a
   * session has no messages yet. TUI plugin options / env override this.
   */
  chatModel?: string;
  threads?: number;
  transcriptionTimeoutMs: number;
  /** Sample rate / channels for recordings (whisper-friendly defaults). */
  sampleRate: number;
  channels: number;
}
