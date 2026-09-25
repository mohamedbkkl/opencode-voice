import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { VoiceJobManager, canInsertInto, ownsSession } from "../src/core/jobs.js";
import { VoiceError, type VoiceJob } from "../src/core/types.js";
import { FakeProvider, FakeRecorder, silentLogger } from "./fakes.js";

function makeManager(provider = new FakeProvider(), recorder = new FakeRecorder()) {
  return new VoiceJobManager({
    instanceID: "test-instance",
    provider,
    recorder,
    logger: silentLogger(),
  });
}

async function settle(ms = 10): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until `check()` is true (no fixed sleeps — robust under load). */
async function waitFor(check: () => boolean, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (check()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await settle(25);
  }
}

async function recordAndStop(
  manager: VoiceJobManager,
  origin: VoiceJob["origin"] = { route: "session", sessionID: "sess-1" },
): Promise<VoiceJob> {
  const job = await manager.startRecording({ directory: "/tmp", origin });
  return manager.stopRecording(job.id);
}

describe("VoiceJob state machine", () => {
  it("stop → transcribe → ready → completed (insert)", async () => {
    const manager = makeManager();
    const job = await recordAndStop(manager);
    // drainQueue picks the job up immediately (queued → transcribing).
    assert.ok(["queued", "transcribing"].includes(job.status));
    await waitFor(() => manager.getJob(job.id)?.status === "ready");
    const ready = manager.getJob(job.id);
    assert.equal(ready?.status, "ready");
    assert.equal(ready?.transcript, "hello world");

    const done = manager.markInserted(job.id, { route: "session", sessionID: "sess-1" });
    assert.equal(done.status, "completed");
  });

  it("cancel during recording leaves no transcript and cleans up", async () => {
    const provider = new FakeProvider();
    const manager = makeManager(provider);
    const job = await manager.startRecording({
      directory: "/tmp",
      origin: { route: "session", sessionID: "sess-1" },
    });
    const cancelled = await manager.cancelJob(job.id);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(provider.calls.length, 0);
    assert.equal(cancelled.audioPath, undefined);
  });

  it("starting twice while recording is idempotent", async () => {
    const manager = makeManager();
    const origin = { route: "session", sessionID: "sess-1" } as const;
    const first = await manager.startRecording({ directory: "/tmp", origin });
    const second = await manager.startRecording({ directory: "/tmp", origin });
    assert.equal(first.id, second.id);
    await manager.cancelJob(first.id);
  });

  it("stop with no recording throws job_not_found", async () => {
    const manager = makeManager();
    await assert.rejects(() => manager.stopRecording(), (error: unknown) => {
      return error instanceof VoiceError && error.code === "job_not_found";
    });
  });

  it("failed recording surfaces recorder errors", async () => {
    const recorder = new FakeRecorder();
    recorder.failStart = new VoiceError("no_microphone", "no mic");
    const manager = makeManager(new FakeProvider(), recorder);
    await assert.rejects(
      () =>
        manager.startRecording({
          directory: "/tmp",
          origin: { route: "session", sessionID: "sess-1" },
        }),
      (error: unknown) => error instanceof VoiceError && error.code === "no_microphone",
    );
    const failed = manager.listJobs()[0];
    assert.equal(failed?.status, "failed");
  });

  it("empty transcript completes without insertion", async () => {
    const manager = makeManager(new FakeProvider({ text: "   \n " }));
    const job = await recordAndStop(manager);
    await waitFor(() => manager.getJob(job.id)?.status === "completed");
    assert.equal(manager.getJob(job.id)?.status, "completed");
  });

  it("provider failure marks the job failed with the message", async () => {
    const manager = makeManager(
      new FakeProvider({ fail: new VoiceError("model_missing", "no model") }),
    );
    const job = await recordAndStop(manager);
    await waitFor(() => manager.getJob(job.id)?.status === "failed");
    const failed = manager.getJob(job.id);
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.error, "no model");
  });
});

describe("session ownership", () => {
  it("ownsSession matrix", () => {
    const base: VoiceJob = {
      id: "voice-1",
      instanceID: "inst-A",
      directory: "/tmp",
      origin: { route: "session", sessionID: "sess-1" },
      createdAt: 0,
      updatedAt: 0,
      providerID: "fake",
      language: "auto",
      requestedAction: "insert",
      status: "ready",
    };
    assert.equal(ownsSession(base, { route: "session", sessionID: "sess-1" }, "inst-A"), true);
    assert.equal(ownsSession(base, { route: "session", sessionID: "sess-2" }, "inst-A"), false);
    assert.equal(ownsSession(base, { route: "session", sessionID: "sess-1" }, "inst-B"), false);
    assert.equal(ownsSession(base, { route: "home" }, "inst-A"), false);
    const home: VoiceJob = { ...base, origin: { route: "home" } };
    assert.equal(ownsSession(home, { route: "home" }, "inst-A"), true);
    assert.equal(
      ownsSession(home, { route: "session", sessionID: "sess-1" }, "inst-A"),
      false,
    );
  });

  it("markInserted rejects a job from another session", async () => {
    const manager = makeManager();
    const job = await recordAndStop(manager, { route: "session", sessionID: "sess-A" });
    await waitFor(() => manager.getJob(job.id)?.status === "ready");
    assert.equal(manager.getJob(job.id)?.status, "ready");
    assert.throws(
      () => manager.markInserted(job.id, { route: "session", sessionID: "sess-B" }),
      (error: unknown) =>
        error instanceof VoiceError && error.code === "session_mismatch",
    );
    // Still parked, transcript retained.
    assert.equal(manager.getJob(job.id)?.status, "ready");
    assert.equal(manager.getJob(job.id)?.transcript, "hello world");
  });

  it("findInsertable only returns jobs for the current session", async () => {
    const manager = makeManager();
    await recordAndStop(manager, { route: "session", sessionID: "sess-A" });
    await recordAndStop(manager, { route: "session", sessionID: "sess-B" });
    await waitFor(
      () => manager.listJobs().filter((j) => j.status === "ready").length === 2,
    );
    const forB = manager.findInsertable({ route: "session", sessionID: "sess-B" });
    assert.equal(forB?.origin.sessionID, "sess-B");
    assert.equal(
      manager.findInsertable({ route: "session", sessionID: "sess-C" }),
      undefined,
    );
  });
});

describe("tab isolation rules (R1-R4)", () => {
  function job(
    origin: VoiceJob["origin"],
    extra?: Partial<VoiceJob>,
  ): VoiceJob {
    return {
      id: "voice-x",
      instanceID: "inst-A",
      directory: "/proj",
      origin,
      createdAt: 0,
      updatedAt: 0,
      providerID: "fake",
      language: "auto",
      requestedAction: "insert",
      status: "ready",
      transcript: "hello",
      ...extra,
    };
  }

  it("R1: session A never delivers into session B", () => {
    const j = job({ route: "session", sessionID: "sess-A" });
    assert.equal(
      canInsertInto(j, { route: "session", sessionID: "sess-B" }, "inst-A", "/proj"),
      false,
    );
  });

  it("R2: floating home delivers into same-directory session only", () => {
    const j = job({ route: "home" });
    assert.equal(
      canInsertInto(j, { route: "session", sessionID: "sess-NEW" }, "inst-A", "/proj"),
      true,
    );
    assert.equal(
      canInsertInto(j, { route: "session", sessionID: "sess-NEW" }, "inst-A", "/other"),
      false,
    );
    assert.equal(
      canInsertInto(j, { route: "session", sessionID: "sess-NEW" }, "inst-B", "/proj"),
      false,
    );
  });

  it("R3: exact match wins over newer floating home job", async () => {
    const manager = makeManager();
    await recordAndStop(manager, { route: "session", sessionID: "sess-A" });
    const home = await manager.startRecording({ directory: "/proj", origin: { route: "home" } });
    await manager.stopRecording(home.id);
    await waitFor(
      () => manager.listJobs().filter((j) => j.status === "ready").length === 2,
    );
    const pick = manager.findInsertable({ route: "session", sessionID: "sess-A" }, "/proj");
    assert.equal(pick?.origin.route, "session");
    assert.equal(pick?.origin.sessionID, "sess-A");
  });

  it("R4: markInserted completes floating home into session, rejects mismatch", async () => {
    const manager = makeManager();
    const home = await manager.startRecording({ directory: "/proj", origin: { route: "home" } });
    await manager.stopRecording(home.id);
    await waitFor(() => manager.getJob(home.id)?.status === "ready");
    const done = manager.markInserted(
      home.id,
      { route: "session", sessionID: "sess-NEW" },
      "/proj",
    );
    assert.equal(done.status, "completed");
  });

  it("R4b: markInserted rejects cross-directory floating", async () => {
    const manager = makeManager();
    const home = await manager.startRecording({ directory: "/proj", origin: { route: "home" } });
    await manager.stopRecording(home.id);
    await waitFor(() => manager.getJob(home.id)?.status === "ready");
    assert.throws(
      () => manager.markInserted(home.id, { route: "session", sessionID: "sess-NEW" }, "/other"),
      (error: unknown) =>
        error instanceof VoiceError && error.code === "session_mismatch",
    );
  });
});

describe("freshness gate (current content only)", () => {
  it("older send job waits while a newer job is in flight", async () => {
    const manager = makeManager();
    const first = await recordAndStop(manager, { route: "session", sessionID: "sess-A" });
    const second = await manager.startRecording({
      directory: "/tmp",
      origin: { route: "session", sessionID: "sess-A" },
    });
    assert.equal(manager.hasNewerActiveJob(first.id), true);
    assert.equal(manager.hasNewerActiveJob(second.id), false);
    await manager.cancelJob(second.id);
    assert.equal(manager.hasNewerActiveJob(first.id), false);
  });

  it("unknown job id never blocks", () => {
    const manager = makeManager();
    assert.equal(manager.hasNewerActiveJob("nope"), false);
  });
});
