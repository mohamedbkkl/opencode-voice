/**
 * Provider abstraction. Recording, job management and UI must only depend on
 * these interfaces — never on whisper.cpp directly — so future engines
 * (MLX Whisper, faster-whisper, local HTTP servers, custom CLI commands)
 * can be added without touching the rest of the application.
 */
import type {
  SpeechModel,
  TranscriptionOptions,
  TranscriptionResult,
  VoiceConfig,
} from "../core/types.js";

export interface ProviderCapabilities {
  /** True when downloading models on demand is supported (opt-in only). */
  supportsDownload: boolean;
  /** True when the provider runs a persistent local server. */
  persistentServer: boolean;
}

export interface SpeechProvider {
  /** Stable id, e.g. `whisper.cpp`. Matches `VoiceConfig.provider`. */
  readonly id: string;
  /** Human-readable name for status displays. */
  readonly name: string;

  capabilities(): ProviderCapabilities;

  /** True when the provider backend (executable/server) is usable. */
  isAvailable(): Promise<boolean>;

  /** Human-readable reason when unavailable (for diagnostics/errors). */
  availabilityHint(): string;

  /**
   * List locally installed, compatible models. Never downloads anything.
   * Resolves to `[]` when nothing is found (not an error).
   */
  discoverModels(): Promise<SpeechModel[]>;

  /**
   * Resolve which model file to use for `options.model` (`auto`/undefined =
   * preferred discovered model). Throws `VoiceError(model_missing)` when
   * nothing suitable exists.
   */
  resolveModel(model?: string): Promise<SpeechModel>;

  transcribe(
    audioPath: string,
    options: TranscriptionOptions,
  ): Promise<TranscriptionResult>;
}

export interface ProviderFactory {
  readonly id: string;
  create(config: VoiceConfig): SpeechProvider;
}

const factories = new Map<string, ProviderFactory>();

export function registerProvider(factory: ProviderFactory): void {
  factories.set(factory.id, factory);
}

export function providerIDs(): string[] {
  return [...factories.keys()];
}

export function createProvider(
  id: string,
  config: VoiceConfig,
): SpeechProvider | undefined {
  return factories.get(id)?.create(config);
}
