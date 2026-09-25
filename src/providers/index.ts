/**
 * Provider selection: transcribe.cpp is preferred; whisper.cpp stays as an
 * optional fallback.
 *
 * - `provider: "transcribe.cpp"` (default): use it when available, otherwise
 *   fall back to whisper.cpp when that one is available.
 * - `provider: "whisper.cpp"`: explicit choice, no fallback.
 * - `provider: "auto"`: first available of [transcribe.cpp, whisper.cpp].
 */
import type { VoiceConfig } from "../core/types.js";
import { Logger } from "../core/logger.js";
import {
  createProvider,
  type SpeechProvider,
} from "./provider.js";
import "./transcribe-cpp.js";
import "./whisper-cpp.js";
import { TRANSCRIBE_CPP_ID } from "./transcribe-cpp.js";
import { WHISPER_CPP_ID } from "./whisper-cpp.js";

export interface SelectedProvider {
  provider: SpeechProvider;
  /** ID of the provider actually selected. */
  id: string;
  /** Set when we fell back from the configured provider. */
  fallbackFrom?: string;
}

export async function selectProvider(
  config: VoiceConfig,
  logger?: Logger,
): Promise<SelectedProvider> {
  const wanted = (config.provider || TRANSCRIBE_CPP_ID).trim();
  const chain =
    wanted === "auto" || wanted === ""
      ? [TRANSCRIBE_CPP_ID, WHISPER_CPP_ID]
      : wanted === TRANSCRIBE_CPP_ID
        ? [TRANSCRIBE_CPP_ID, WHISPER_CPP_ID]
        : [wanted];

  for (const id of chain) {
    // Explicit binary/model paths are scoped to the configured provider id: a
    // whisper path must never be handed to transcribe.cpp (or vice versa).
    // Other candidates use clean discovery plus their own runtime env vars
    // (OPENCODE_VOICE_TRANSCRIBE_BIN / OPENCODE_VOICE_WHISPER_BIN).
    const candidateConfig =
      id === wanted
        ? config
        : { ...config, executablePath: undefined, modelPath: undefined };
    const provider = createProvider(id, candidateConfig);
    if (!provider) {
      logger?.warn(`unknown voice provider "${id}" — skipping`);
      continue;
    }
    if (await provider.isAvailable()) {
      const fallbackFrom = id !== wanted && wanted !== "auto" && wanted !== "" ? wanted : undefined;
      if (fallbackFrom) {
        logger?.info(`voice provider "${wanted}" unavailable — falling back to "${id}"`);
      }
      return { provider, id, fallbackFrom };
    }
  }

  // Nothing available: return the first candidate anyway so callers surface
  // its actionable error (install hint, model hint).
  const fallbackID = chain[0] ?? TRANSCRIBE_CPP_ID;
  const fallback = createProvider(fallbackID, config);
  if (fallback) return { provider: fallback, id: fallbackID };
  throw new Error(`No voice provider available (tried: ${chain.join(", ")}).`);
}
