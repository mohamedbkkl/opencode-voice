/** Shared fakes for manager tests (no hardware, no subprocesses). */
import * as fs from "node:fs";
import { Logger } from "../src/core/logger.js";
import type {
  SpeechModel,
  TranscriptionOptions,
  TranscriptionResult,
} from "../src/core/types.js";
import { VoiceError } from "../src/core/types.js";
import type {
  ProviderCapabilities,
  SpeechProvider,
} from "../src/providers/provider.js";
import type {
  ActiveRecording,
  AudioDevice,
  AudioRecorder,
  RecorderStartOptions,
} from "../src/recorder/recorder.js";

export function silentLogger(): Logger {
  return new Logger({ debug: false, sink: () => undefined });
}

export class FakeRecorder implements AudioRecorder {
  readonly id = "fake";
  started: RecorderStartOptions[] = [];
  failStart?: VoiceError;
  concurrent = 0;
  maxConcurrent = 0;

  async isAvailable(): Promise<boolean> {
    return true;
  }
  availabilityHint(): string {
    return "fake";
  }
  async listDevices(): Promise<AudioDevice[]> {
    return [{ id: "0", label: "Fake Mic", isDefault: true }];
  }

  async start(options: RecorderStartOptions): Promise<ActiveRecording> {
    if (this.failStart) throw this.failStart;
    this.started.push(options);
    this.concurrent += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    let stopped = false;
    return {
      deviceLabel: "Fake Mic",
      startedAt: Date.now(),
      isRunning: () => !stopped,
      stop: async () => {
        stopped = true;
        this.concurrent -= 1;
        await fs.promises.writeFile(options.outputPath, Buffer.alloc(128, 1));
        return { path: options.outputPath, bytes: 128 };
      },
      cancel: async () => {
        stopped = true;
        this.concurrent -= 1;
      },
    };
  }
}

export interface FakeProviderScript {
  /** Per-call delay in ms. */
  delayMs?: number;
  text?: string;
  fail?: VoiceError;
}

export class FakeProvider implements SpeechProvider {
  readonly id = "fake";
  readonly name = "Fake (tests)";
  calls: { audioPath: string; options: TranscriptionOptions }[] = [];
  inflight = 0;
  maxInflight = 0;
  script: FakeProviderScript;

  constructor(script: FakeProviderScript = {}) {
    this.script = script;
  }

  capabilities(): ProviderCapabilities {
    return { supportsDownload: false, persistentServer: false };
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
  availabilityHint(): string {
    return "fake";
  }
  async discoverModels(): Promise<SpeechModel[]> {
    return [{ id: "fake-model", path: "/tmp/fake.bin", bytes: 10 }];
  }
  async resolveModel(model?: string): Promise<SpeechModel> {
    return { id: model ?? "fake-model", path: "/tmp/fake.bin", bytes: 10 };
  }

  async transcribe(
    audioPath: string,
    options: TranscriptionOptions,
  ): Promise<TranscriptionResult> {
    this.calls.push({ audioPath, options });
    this.inflight += 1;
    this.maxInflight = Math.max(this.maxInflight, this.inflight);
    try {
      const delay = this.script.delayMs ?? 20;
      await sleepAbortable(delay, options.signal);
      if (options.signal?.aborted) {
        throw new VoiceError("job_cancelled", "cancelled");
      }
      if (this.script.fail) throw this.script.fail;
      return {
        text: this.script.text ?? "hello world",
        durationMs: delay,
        providerID: this.id,
        model: "/tmp/fake.bin",
      };
    } finally {
      this.inflight -= 1;
    }
  }
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(new VoiceError("job_cancelled", "cancelled"));
    };
    const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
