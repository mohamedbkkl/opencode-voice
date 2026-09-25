/**
 * Lazy, non-blocking diagnostics. Never throws and never blocks startup:
 * every probe is independent, time-bounded, and failures degrade to
 * `available: false` with a hint.
 */
import type { VoiceConfig } from "./types.js";
import type { SpeechProvider } from "../providers/provider.js";
import type { AudioRecorder } from "../recorder/recorder.js";

export interface DiagnosticItem {
  label: string;
  ok: boolean;
  detail: string;
  hint?: string;
}

export interface VoiceDiagnostics {
  ready: boolean;
  items: DiagnosticItem[];
  generatedAt: number;
}

export async function diagnose(options: {
  config: VoiceConfig;
  provider: SpeechProvider;
  recorder?: AudioRecorder;
  timeoutMs?: number;
}): Promise<VoiceDiagnostics> {
  const timeout = options.timeoutMs ?? 8000;
  const items: DiagnosticItem[] = [];

  // Run independent probes in parallel — sequential awaits made diagnose
  // take ~3x longer than needed. Each probe is still individually bounded.
  const [exeResult, recAvailable] = await Promise.all([
    withTimeout(options.provider.isAvailable(), timeout, false),
    options.recorder
      ? withTimeout(options.recorder.isAvailable(), timeout, false)
      : Promise.resolve(undefined as boolean | undefined),
  ]);
  items.push({
    label: `Provider: ${options.provider.name}`,
    ok: exeResult,
    detail: exeResult ? "executable found" : "executable not found",
    hint: exeResult ? undefined : options.provider.availabilityHint(),
  });

  // Models (only when the provider itself is available)
  if (exeResult) {
    const models = await withTimeout(
      options.provider.discoverModels().catch(() => []),
      timeout,
      [],
    );
    const preferred = models.find((m) => m.preferred) ?? models[0];
    items.push({
      label: "Model",
      ok: models.length > 0,
      detail: preferred
        ? `${preferred.id} (${preferred.path})`
        : "no compatible local model found",
      hint: models.length > 0 ? undefined : missingModelHint(options.config),
    });
  } else {
    items.push({
      label: "Model",
      ok: false,
      detail: "skipped (provider unavailable)",
    });
  }

  // Microphone
  if (options.recorder) {
    const recOk = recAvailable === true;
    let micDetail = recOk ? "recorder available" : "recorder unavailable";
    let micHint = recOk ? undefined : options.recorder.availabilityHint();
    if (recOk) {
      const devices = await withTimeout(
        options.recorder.listDevices().catch(() => []),
        timeout,
        [],
      );
      if (devices.length > 0) {
        micDetail = `recorder available (${devices.length} input${devices.length === 1 ? "" : "s"}: ${devices.slice(0, 3).map((d) => d.label).join(", ")})`;
      }
    }
    items.push({ label: "Microphone", ok: recOk, detail: micDetail, hint: micHint });
  } else {
    items.push({
      label: "Microphone",
      ok: false,
      detail: "no recorder configured for this platform",
      hint: `Recording is not implemented for ${process.platform} yet.`,
    });
  }

  return {
    ready: items.every((i) => i.ok),
    items,
    generatedAt: Date.now(),
  };
}

export function formatDiagnostics(d: VoiceDiagnostics): string {
  const lines = ["OpenCode Voice", ""];
  for (const item of d.items) {
    lines.push(`${item.ok ? "✓" : "✗"} ${item.label}: ${item.detail}`);
    if (item.hint) lines.push(`  → ${item.hint}`);
  }
  lines.push("", d.ready ? "Status: ready" : "Status: not ready");
  return lines.join("\n");
}

function missingModelHint(config: VoiceConfig): string {
  if (config.modelPath) {
    return `Configured model not found: ${config.modelPath}.`;
  }
  return "Place a ggml-*.bin model (e.g. ggml-large-v3-turbo.bin from https://huggingface.co/ggerganov/whisper.cpp) in ~/.cache/whisper, or set OPENCODE_VOICE_MODEL_PATH. Models are never downloaded automatically.";
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } catch {
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
