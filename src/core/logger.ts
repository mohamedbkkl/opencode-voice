/**
 * Minimal structured logger.
 *
 * - `debug` gates verbose lifecycle events.
 * - Transcripts and audio contents are NEVER logged (only lengths/paths).
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogSink {
  (level: LogLevel, message: string, extra?: Record<string, unknown>): void;
}

const defaultSink: LogSink = (level, message, extra) => {
  const line = `[opencode-voice] [${level}] ${message}`;
  if (level === "error" || level === "warn") {
    console.error(extra ? `${line} ${JSON.stringify(extra)}` : line);
  } else if (process.env.OPENCODE_VOICE_DEBUG === "1") {
    console.error(extra ? `${line} ${JSON.stringify(extra)}` : line);
  }
};

export class Logger {
  private debugEnabled: boolean;
  private sink: LogSink;

  constructor(options?: { debug?: boolean; sink?: LogSink }) {
    this.debugEnabled =
      options?.debug ?? process.env.OPENCODE_VOICE_DEBUG === "1";
    this.sink = options?.sink ?? defaultSink;
  }

  setDebug(enabled: boolean): void {
    this.debugEnabled = enabled;
  }

  debug(message: string, extra?: Record<string, unknown>): void {
    if (!this.debugEnabled) return;
    this.sink("debug", message, extra);
  }

  info(message: string, extra?: Record<string, unknown>): void {
    this.sink("info", message, extra);
  }

  warn(message: string, extra?: Record<string, unknown>): void {
    this.sink("warn", message, extra);
  }

  error(message: string, extra?: Record<string, unknown>): void {
    this.sink("error", message, extra);
  }
}

/** Lifecycle event names (see spec §15) for consistent debug output. */
export const VoiceEvents = {
  jobCreated: "voice job created",
  recordingStarted: "recording started",
  recordingStopped: "recording stopped",
  recordingCancelled: "recording cancelled",
  audioFileCreated: "audio file created",
  jobQueued: "job queued",
  providerSelected: "provider selected",
  modelSelected: "model selected",
  transcriptionStarted: "transcription started",
  transcriptionCompleted: "transcription completed",
  insertionAttempted: "composer insertion attempted",
  insertionCompleted: "composer insertion completed",
  jobCompleted: "job completed",
  jobFailed: "job failed",
  cleanupCompleted: "cleanup completed",
} as const;
