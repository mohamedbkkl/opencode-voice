/**
 * Public surface of the `opencode-voice` package core (provider-agnostic).
 * Plugin entries (`src/server.ts`, `src/tui.ts`) and tests import from here.
 */
export * from "./core/types.js";
export * from "./core/config.js";
export * from "./core/logger.js";
export * from "./core/jobs.js";
export * from "./core/diagnostics.js";
export * from "./core/singleton.js";
export * from "./core/clipboard.js";
export * from "./core/autopaste.js";
export * from "./core/submit-model.js";
export * from "./providers/provider.js";
export * from "./providers/index.js";
export * from "./providers/whisper-cpp.js";
export * from "./providers/transcribe-cpp.js";
export * from "./recorder/recorder.js";
export * from "./recorder/ffmpeg.js";
export * from "./utils/process.js";
