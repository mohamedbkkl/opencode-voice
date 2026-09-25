import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { VoiceJobManager } from "../src/core/jobs.js";
import type { VoiceJob } from "../src/core/types.js";
import {
  FakeProvider,
  FakeRecorder,
  silentLogger,
} from "./fakes.js";
import type {
  ActiveRecording,
  RecorderStartOptions,
} from "../src/recorder/recorder.js";

/** Recorder whose startup takes a beat, like real ffmpeg/AVFoundation init. */
class SlowStartRecorder extends FakeRecorder {
  delayMs = 80;

  override async start(options: RecorderStartOptions): Promise<ActiveRecording> {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return super.start(options);
  }
}

function makeManager(recorder = new SlowStartRecorder()) {
  return new VoiceJobManager({
    instanceID: "test-instance",
    provider: new FakeProvider(),
    recorder: recorder,
    logger: silentLogger(),
  });
}

const ORIGIN: VoiceJob["origin"] = { route: "session", sessionID: "sess-1" };

describe("mic lifecycle (R12): no orphan while the recorder is starting", () => {
  it("cancel during startup kills the child, mic released", async () => {
    const recorder = new SlowStartRecorder();
    const manager = makeManager(recorder);
    const started = manager.startRecording({ directory: "/tmp", origin: ORIGIN });
    // Cancel lands while recorder.start() is still in flight.
    const cancelled = await manager.cancelJob();
    const job = await started;
    assert.equal(job.id, cancelled.id);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(manager.recordingJob(), undefined);
    assert.equal(recorder.concurrent, 0);
    assert.equal(cancelled.audioPath, undefined);
    await manager.dispose();
  });

  it("stop during startup stops the live recording (no orphan)", async () => {
    const recorder = new SlowStartRecorder();
    const manager = makeManager(recorder);
    const started = manager.startRecording({ directory: "/tmp", origin: ORIGIN });
    const stopped = await manager.stopRecording();
    const job = await started;
    assert.equal(job.id, stopped.id);
    assert.ok(["queued", "transcribing", "ready"].includes(stopped.status));
    assert.equal(manager.recordingJob(), undefined);
    assert.equal(recorder.concurrent, 0);
    await manager.dispose();
  });

  it("double start during startup spawns exactly one child", async () => {
    const recorder = new SlowStartRecorder();
    const manager = makeManager(recorder);
    const [a, b] = await Promise.all([
      manager.startRecording({ directory: "/tmp", origin: ORIGIN }),
      manager.startRecording({ directory: "/tmp", origin: ORIGIN }),
    ]);
    assert.equal(a.id, b.id);
    assert.equal(recorder.started.length, 1);
    await manager.cancelJob(a.id);
    assert.equal(recorder.concurrent, 0);
    await manager.dispose();
  });

  it("failed startup leaves nothing recording", async () => {
    const recorder = new SlowStartRecorder();
    recorder.failStart = undefined;
    const { VoiceError } = await import("../src/core/types.js");
    recorder.failStart = new VoiceError("recorder_failed", "nope");
    const manager = makeManager(recorder);
    await assert.rejects(() =>
      manager.startRecording({ directory: "/tmp", origin: ORIGIN }),
    );
    assert.equal(manager.recordingJob(), undefined);
    await manager.dispose();
  });
});
