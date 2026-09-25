import type { Context } from "@opencode/plugin/promise/plugin";
import { loadConfig, type ConfigOverrides } from "./core/config.js";
import { diagnose, formatDiagnostics } from "./core/diagnostics.js";
import { Logger } from "./core/logger.js";
import { createProvider } from "./providers/provider.js";
import { selectProvider } from "./providers/index.js";
import "./providers/whisper-cpp.js";
import "./providers/transcribe-cpp.js";
import { createDefaultRecorder } from "./recorder/ffmpeg.js";
import { claimProcessSlot } from "./core/singleton.js";

export const PLUGIN_ID = "opencode-voice.server";

function readOptions(raw: unknown): ConfigOverrides {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const options = raw as Record<string, unknown>;
  const overrides: ConfigOverrides = {};
  if (typeof options.provider === "string") overrides.provider = options.provider;
  if (typeof options.model === "string") overrides.model = options.model;
  if (typeof options.modelPath === "string") overrides.modelPath = options.modelPath;
  if (typeof options.executablePath === "string") overrides.executablePath = options.executablePath;
  if (typeof options.language === "string") overrides.language = options.language;
  if (typeof options.device === "string") overrides.device = options.device;
  if (typeof options.debug === "boolean") overrides.debug = options.debug;
  if (typeof options.keepAudio === "boolean") overrides.keepAudio = options.keepAudio;
  if (typeof options.maxConcurrentTranscriptions === "number") {
    overrides.maxConcurrentTranscriptions = options.maxConcurrentTranscriptions;
  }
  return overrides;
}

export const OpenCodeVoiceServerV2 = async (context: Context): Promise<void> => {
    // Global + project-local entries can both load in one process; the second
    // copy stands down so tools are registered exactly once.
    if (!claimProcessSlot("opencode-voice.server")) return;
    const { config } = loadConfig({
      cwd: context.location?.directory ?? process.cwd(),
      overrides: readOptions(context.options),
    });
    const logger = new Logger({ debug: config.debug });
    const selection = await selectProvider(config, logger).catch(() => undefined);
    const provider = selection?.provider ?? createProvider(config.provider, config);
    const providerID = selection?.id ?? config.provider;
    const recorder = await createDefaultRecorder().catch(() => undefined);

    await context.tool.transform((editor) => {
      editor.add({
        name: "voice_status",
        description: "Check whether OpenCode Voice is ready.",
        input: { type: "object", properties: {}, additionalProperties: false },
        async execute() {
          if (!provider) {
            return { content: `Unknown provider \"${config.provider}\".` };
          }
          const diagnostics = await diagnose({ config, provider, recorder });
          return {
            content: JSON.stringify(
              { ready: diagnostics.ready, provider: providerID, items: diagnostics.items },
              null,
              2,
            ),
          };
        },
      });
      editor.add({
        name: "voice_diagnose",
        description: "Show OpenCode Voice diagnostics.",
        input: { type: "object", properties: {}, additionalProperties: false },
        async execute() {
          if (!provider) return { content: `Unknown provider \"${config.provider}\".` };
          const diagnostics = await diagnose({ config, provider, recorder });
          return { content: formatDiagnostics(diagnostics) };
        },
      });
    });
};
