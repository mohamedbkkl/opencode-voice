/**
 * Server plugin entry (`./server` export).
 *
 * Target-exclusive module: exports `{ id, server }` only (never `tui`).
 *
 * Responsibilities for Milestone 1:
 * - Expose `voice_status` / `voice_diagnose` agent tools so users (and the
 *   agent) can check readiness without touching the TUI.
 * - Log lifecycle for debuggability; never slow down or fail startup.
 *
 * The interactive pipeline (recording, keybindings, composer insertion)
 * lives in the TUI entry (`src/tui.ts`) because only the TUI has keybindings,
 * the current route/session, and per-window process isolation.
 */
import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { loadConfig, type ConfigOverrides } from "./core/config.js";
import { diagnose, formatDiagnostics } from "./core/diagnostics.js";
import { Logger } from "./core/logger.js";
import { createProvider } from "./providers/provider.js";
import { selectProvider } from "./providers/index.js";
import "./providers/whisper-cpp.js";
import "./providers/transcribe-cpp.js";
import { createDefaultRecorder } from "./recorder/ffmpeg.js";
import { instanceID } from "./utils/process.js";
import { claimProcessSlot } from "./core/singleton.js";

export const PLUGIN_ID = "opencode-voice";

function readOptions(raw: unknown): ConfigOverrides {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const o = raw as Record<string, unknown>;
  const out: ConfigOverrides = {};
  if (typeof o["provider"] === "string") out.provider = o["provider"];
  if (typeof o["model"] === "string") out.model = o["model"];
  if (typeof o["modelPath"] === "string") out.modelPath = o["modelPath"];
  if (typeof o["executablePath"] === "string") out.executablePath = o["executablePath"];
  if (typeof o["language"] === "string") out.language = o["language"];
  if (typeof o["device"] === "string") out.device = o["device"];
  if (typeof o["debug"] === "boolean") out.debug = o["debug"];
  if (typeof o["keepAudio"] === "boolean") out.keepAudio = o["keepAudio"];
  if (typeof o["maxConcurrentTranscriptions"] === "number") {
    out.maxConcurrentTranscriptions = o["maxConcurrentTranscriptions"];
  }
  return out;
}

export const OpenCodeVoiceServer: Plugin = async ({ client, directory }, options) => {
  // Global + project-local entries can both load in one process; the second
  // copy stands down so tools are registered exactly once.
  if (!claimProcessSlot("opencode-voice.server")) return {};
  const overrides = readOptions(options);
  const { config } = loadConfig({ cwd: directory, overrides });
  const logger = new Logger({ debug: config.debug });

  // Preferred provider first (transcribe.cpp), whisper.cpp as fallback.
  const selection = await selectProvider(config, logger).catch(() => undefined);
  const provider =
    selection?.provider ?? createProvider(config.provider, config);
  const providerID = selection?.id ?? config.provider;
  const recorder = await createDefaultRecorder().catch(() => undefined);

  await client.app
    .log({
      body: {
        service: "opencode-voice",
        level: "info",
        message: "server plugin loaded",
        extra: {
          instance: instanceID(),
          provider: providerID,
          fallbackFrom: selection?.fallbackFrom,
          directory,
        },
      },
    })
    .catch(() => undefined);

  logger.debug("server plugin initialized", { instance: instanceID() });

  return {
    tool: {
      voice_status: tool({
        description:
          "Check whether local voice-to-text (OpenCode Voice) is ready: provider executable, installed models, and microphone. Never records or downloads anything.",
        args: {},
        async execute() {
          if (!provider) {
            return JSON.stringify({
              status: "error",
              ready: false,
              message: `Unknown provider "${config.provider}".`,
            });
          }
          const diagnostics = await diagnose({ config, provider, recorder });
          return JSON.stringify(
            {
              status: "ok",
              ready: diagnostics.ready,
              provider: providerID,
              fallbackFrom: selection?.fallbackFrom,
              instance: instanceID(),
              items: diagnostics.items,
            },
            null,
            2,
          );
        },
      }),
      voice_diagnose: tool({
        description:
          "Full OpenCode Voice diagnostics as human-readable text (provider path, models found, microphone devices). Read-only.",
        args: {},
        async execute() {
          if (!provider) {
            return `OpenCode Voice\n\nUnknown provider "${config.provider}".`;
          }
          const diagnostics = await diagnose({ config, provider, recorder });
          return formatDiagnostics(diagnostics);
        },
      }),
    },
    dispose: async () => {
      logger.debug("server plugin disposed");
    },
  };
};

export default {
  id: PLUGIN_ID,
  server: OpenCodeVoiceServer,
};
