import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { VoiceJobManager } from "../src/core/jobs.js";
import { VoiceError } from "../src/core/types.js";
import { FakeProvider, FakeRecorder, silentLogger } from "./fakes.js";

async function settle(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean, timeoutMs = 20000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (check()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await settle(25);
  }
}

describe("transcription queue", () => {
  it("defaults to one concurrent transcription", async () => {
    const provider = new FakeProvider({ delayMs: 60 });
    const manager = new VoiceJobManager({
      instanceID: "test-instance",
      provider,
      recorder: new FakeRecorder(),
      logger: silentLogger(),
    });
    const origin = { route: "session", sessionID: "s1" } as const;
    for (let i = 0; i < 3; i++) {
      const job = await manager.startRecording({ directory: "/tmp", origin });
      await manager.stopRecording(job.id);
    }
    await waitFor(
      () => manager.listJobs().filter((j) => j.status === "ready").length === 3,
    );
    assert.equal(provider.maxInflight, 1);
    assert.equal(provider.calls.length, 3);
    assert.deepEqual(
      manager.listJobs().map((j) => j.status),
      ["ready", "ready", "ready"],
    );
  });

  it("recording stays possible while transcription runs", async () => {
    const provider = new FakeProvider({ delayMs: 120 });
    const recorder = new FakeRecorder();
    const manager = new VoiceJobManager({
      instanceID: "test-instance",
      provider,
      recorder,
      logger: silentLogger(),
    });
    const origin = { route: "session", sessionID: "s1" } as const;
    const first = await manager.startRecording({ directory: "/tmp", origin });
    await manager.stopRecording(first.id);
    // While job 1 transcribes, start job 2.
    const second = await manager.startRecording({ directory: "/tmp", origin });
    assert.equal(second.status, "recording");
    assert.equal(manager.snapshot().transcribing, 1);
    await manager.stopRecording(second.id);
    await waitFor(
      () =>
        manager.getJob(first.id)?.status === "ready" &&
        manager.getJob(second.id)?.status === "ready",
    );
    assert.equal(manager.getJob(first.id)?.status, "ready");
    assert.equal(manager.getJob(second.id)?.status, "ready");
    assert.equal(recorder.maxConcurrent, 1);
  });

  it("cancelling a queued job prevents transcription", async () => {
    const provider = new FakeProvider({ delayMs: 100 });
    const manager = new VoiceJobManager({
      instanceID: "test-instance",
      provider,
      recorder: new FakeRecorder(),
      logger: silentLogger(),
      maxConcurrentTranscriptions: 1,
    });
    const origin = { route: "session", sessionID: "s1" } as const;
    const first = await manager.startRecording({ directory: "/tmp", origin });
    await manager.stopRecording(first.id);
    const second = await manager.startRecording({ directory: "/tmp", origin });
    await manager.stopRecording(second.id);
    await manager.cancelJob(second.id);
    await waitFor(() => manager.getJob(first.id)?.status === "ready");
    assert.equal(provider.calls.length, 1);
    assert.equal(manager.getJob(second.id)?.status, "cancelled");
    assert.equal(manager.getJob(first.id)?.status, "ready");
  });

  it("cancelling a transcribing job aborts the provider", async () => {
    const provider = new FakeProvider({ delayMs: 5000 });
    const manager = new VoiceJobManager({
      instanceID: "test-instance",
      provider,
      recorder: new FakeRecorder(),
      logger: silentLogger(),
    });
    const origin = { route: "session", sessionID: "s1" } as const;
    const job = await manager.startRecording({ directory: "/tmp", origin });
    await manager.stopRecording(job.id);
    await waitFor(() => manager.getJob(job.id)?.status === "transcribing");
    assert.equal(manager.getJob(job.id)?.status, "transcribing");
    await manager.cancelJob(job.id);
    await waitFor(() => manager.getJob(job.id)?.status === "cancelled");
    assert.equal(manager.getJob(job.id)?.status, "cancelled");
  });

  it("pruneFinished bounds memory", async () => {
    const manager = new VoiceJobManager({
      instanceID: "test-instance",
      provider: new FakeProvider({ delayMs: 5 }),
      recorder: new FakeRecorder(),
      logger: silentLogger(),
    });
    const origin = { route: "session", sessionID: "s1" } as const;
    for (let i = 0; i < 5; i++) {
      const job = await manager.startRecording({ directory: "/tmp", origin });
      await manager.stopRecording(job.id);
    }
    await waitFor(
      () => manager.listJobs().filter((j) => j.status === "ready").length === 5,
    );
    // Parked `ready` transcripts are retained; only terminal jobs prune.
    for (const snap of manager.listJobs()) {
      if (snap.status === "ready") {
        manager.markInserted(snap.id, { route: "session", sessionID: "s1" });
      }
    }
    manager.pruneFinished(2);
    assert.equal(manager.listJobs().length, 2);
  });

  it("dispose cancels recording and queued work", async () => {
    const manager = new VoiceJobManager({
      instanceID: "test-instance",
      provider: new FakeProvider({ delayMs: 5000 }),
      recorder: new FakeRecorder(),
      logger: silentLogger(),
    });
    const origin = { route: "session", sessionID: "s1" } as const;
    await manager.startRecording({ directory: "/tmp", origin });
    await manager.dispose();
    assert.equal(manager.recordingJob(), undefined);
    await assert.rejects(() => manager.startRecording({ directory: "/tmp", origin }), (e: unknown) => e instanceof VoiceError);
  });
});
