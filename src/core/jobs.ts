/**
 * VoiceJobManager: owns the UX state machine, the transcription queue and
 * session/instance isolation.
 *
 * State model (per job):
 *   recording → (stop) → queued → transcribing → ready → completed
 *      │                     │          │            │
 *      └──── cancel ─────────┴──────────┴──── … ────┘
 *                                    failed (error retained)
 *
 * Session ownership:
 * - Every job records the `instanceID` of the creating process plus the
 *   originating route (`session:<id>` or `home`). A transcript may only be
 *   auto-inserted when the *currently active* route still matches the job's
 *   origin. Otherwise the job parks in `ready` and waits for an explicit,
 *   session-scoped insert.
 * - The manager instance itself is per-process, so jobs can never cross
 *   OpenCode windows in the first place; the origin check additionally
 *   protects against session switches *within* one window.
 *
 * Concurrency:
 * - `maxConcurrentTranscriptions` (default 1) bounds simultaneous provider
 *   calls; extra jobs wait in `queued`. Recording is independent of the
 *   transcription queue, so a new recording can start while another job
 *   transcribes.
 */
import type { Logger } from "./logger.js";
import { VoiceEvents } from "./logger.js";
import {
  VoiceError,
  type TranscriptionOptions,
  type VoiceAction,
  type VoiceJob,
  type VoiceJobSnapshot,
  type VoiceStatus,
} from "./types.js";
import type { SpeechProvider } from "../providers/provider.js";
import type { ActiveRecording, AudioRecorder } from "../recorder/recorder.js";
import { removeQuietly, tempFile } from "../utils/process.js";

export interface JobManagerOptions {
  instanceID: string;
  provider: SpeechProvider;
  recorder: AudioRecorder;
  logger: Logger;
  maxConcurrentTranscriptions?: number;
  keepAudio?: boolean;
  defaultLanguage?: string;
  sampleRate?: number;
  channels?: number;
  device?: string;
  /** Called after every mutation (TUI uses it to refresh toasts/status). */
  onChange?: (snapshot: ManagerSnapshot) => void;
}

export interface ManagerSnapshot {
  activeJob?: VoiceJobSnapshot;
  queued: number;
  transcribing: number;
  recording: boolean;
  ready: VoiceJobSnapshot[];
}

export interface StartRecordingOptions {
  directory: string;
  origin: VoiceJob["origin"];
  providerID?: string;
  model?: string;
  language?: string;
  requestedAction?: VoiceAction;
  device?: string;
}

const VALID_TRANSITIONS: Record<VoiceStatus, VoiceStatus[]> = {
  recording: ["queued", "cancelled", "failed"],
  queued: ["transcribing", "cancelled", "failed"],
  transcribing: ["ready", "completed", "cancelled", "failed"],
  ready: ["completed", "cancelled", "failed"],
  completed: [],
  cancelled: [],
  failed: [],
};

let jobCounter = 0;

export function snapshotJob(job: VoiceJob): VoiceJobSnapshot {
  return {
    id: job.id,
    status: job.status,
    origin: { ...job.origin },
    providerID: job.providerID,
    model: job.model,
    requestedAction: job.requestedAction,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    hasTranscript: (job.transcript?.trim().length ?? 0) > 0,
    error: job.error,
  };
}

/** True when `currentRoute` is the job's origin (safe to auto-insert). */
export function ownsSession(
  job: VoiceJob,
  currentRoute: VoiceJob["origin"],
  instanceID: string,
): boolean {
  if (job.instanceID !== instanceID) return false;
  if (job.origin.route !== currentRoute.route) return false;
  if (job.origin.route === "session") {
    return job.origin.sessionID === currentRoute.sessionID;
  }
  return true;
}

/**
 * True when a transcript may be delivered into `currentRoute`.
 * Strict ownership always passes. Additionally a `home`-origin (floating)
 * job may be delivered into a `session` of the same instance — this covers
 * recording on an empty/home screen then opening a session. When
 * `currentDirectory` is given the floating job must also share the directory,
 * preventing cross-project leaks. Never allows session→different-session.
 */
export function canInsertInto(
  job: VoiceJob,
  currentRoute: VoiceJob["origin"],
  instanceID: string,
  currentDirectory?: string,
): boolean {
  if (ownsSession(job, currentRoute, instanceID)) return true;
  if (
    job.instanceID === instanceID &&
    job.origin.route === "home" &&
    currentRoute.route === "session"
  ) {
    if (currentDirectory !== undefined && job.directory !== undefined) {
      return job.directory === currentDirectory;
    }
    return true;
  }
  return false;
}

export class VoiceJobManager {
  private opts: JobManagerOptions;
  private jobs = new Map<string, VoiceJob>();
  private activeRecording?: { jobID: string; recording: ActiveRecording };
  /**
   * Recorder startup in flight (`recorder.start()` not yet resolved). The OS
   * microphone is already open during this window, so stop/cancel/double-start
   * must rendezvous here instead of reporting "nothing to stop" and orphaning
   * the ffmpeg child (stuck mic indicator = privacy bug). Never rejects.
   */
  private pendingStart?: { jobID: string; settled: Promise<void> };
  private runningTranscriptions = 0;
  private queue: string[] = [];
  private transcribeTokens = new Map<string, AbortController>();
  private disposed = false;

  constructor(options: JobManagerOptions) {
    this.opts = options;
  }

  /** All jobs (newest first) — for status displays. */
  listJobs(): VoiceJobSnapshot[] {
    return [...this.jobs.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(snapshotJob);
  }

  getJob(id: string): VoiceJob | undefined {
    return this.jobs.get(id);
  }

  /** The job currently recording (at most one), including startup. */
  recordingJob(): VoiceJob | undefined {
    if (this.activeRecording) return this.jobs.get(this.activeRecording.jobID);
    if (this.pendingStart) return this.jobs.get(this.pendingStart.jobID);
    return undefined;
  }

  snapshot(): ManagerSnapshot {
    const jobs = [...this.jobs.values()];
    const recording = jobs.find((j) => j.status === "recording");
    const transcribing = jobs.filter((j) => j.status === "transcribing").length;
    const queued = jobs.filter((j) => j.status === "queued").length;
    const ready = jobs
      .filter((j) => j.status === "ready")
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(snapshotJob);
    return {
      activeJob: recording ? snapshotJob(recording) : undefined,
      queued,
      transcribing,
      recording: recording !== undefined,
      ready,
    };
  }

  private emit(): void {
    try {
      this.opts.onChange?.(this.snapshot());
    } catch {
      /* listener errors must not break the pipeline */
    }
  }

  private transition(job: VoiceJob, next: VoiceStatus, extra?: Partial<VoiceJob>): void {
    const allowed = VALID_TRANSITIONS[job.status] ?? [];
    if (!allowed.includes(next)) {
      throw new VoiceError(
        "invalid_transition",
        `Cannot move voice job ${job.id} from ${job.status} to ${next}.`,
      );
    }
    job.status = next;
    job.updatedAt = Date.now();
    if (extra) Object.assign(job, extra);
    this.emit();
  }

  /**
   * Start a recording. Only one recording at a time per instance; a second
   * `startRecording` while recording returns the existing job id (idempotent)
   * rather than failing.
   */
  async startRecording(options: StartRecordingOptions): Promise<VoiceJob> {
    this.assertUsable();
    const existing = this.recordingJob();
    if (existing) return existing;

    jobCounter += 1;
    const now = Date.now();
    const job: VoiceJob = {
      id: `voice-${new Date(now).toISOString().slice(0, 10).replace(/-/g, "")}-${String(jobCounter).padStart(3, "0")}`,
      instanceID: this.opts.instanceID,
      directory: options.directory,
      origin: { ...options.origin },
      createdAt: now,
      updatedAt: now,
      providerID: options.providerID ?? this.opts.provider.id,
      model: options.model,
      language: options.language ?? this.opts.defaultLanguage ?? "auto",
      requestedAction: options.requestedAction ?? "insert",
      status: "recording",
    };
    this.jobs.set(job.id, job);
    this.opts.logger.debug(VoiceEvents.jobCreated, {
      job: job.id,
      origin: job.origin,
    });

    // Track the startup window from here (before any await): the mic may
    // already be opening, so stop/cancel must rendezvous instead of orphaning.
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    this.pendingStart = { jobID: job.id, settled };
    const clearPending = (): void => {
      if (this.pendingStart?.jobID === job.id) this.pendingStart = undefined;
      resolveSettled();
    };

    const audioPath = await tempFile("opencode-voice-rec", ".wav").catch(() => {
      clearPending();
      this.transition(job, "failed", {
        error: "Could not create a temporary audio file.",
      });
      throw new VoiceError(
        "temp_file_failed",
        "Could not create a temporary audio file.",
        "Check TMPDIR permissions and free disk space.",
      );
    });
    // tempFile() creates a directory placeholder; the actual wav sits inside.
    job.audioPath = audioPath;

    try {
      const recording = await this.opts.recorder.start({
        outputPath: audioPath,
        device: options.device ?? this.opts.device ?? "auto",
        sampleRate: this.opts.sampleRate ?? 16000,
        channels: this.opts.channels ?? 1,
      });
      this.activeRecording = { jobID: job.id, recording };
      this.opts.logger.debug(VoiceEvents.recordingStarted, { job: job.id });
      this.emit();
      return job;
    } catch (error) {
      await removeQuietly(audioPath);
      await removeQuietly(audioPath ? parentDir(audioPath) : undefined);
      const message =
        error instanceof VoiceError ? error.message : "Could not start recording.";
      this.transition(job, "failed", { error: message });
      this.opts.logger.debug(VoiceEvents.jobFailed, { job: job.id, error: message });
      throw error instanceof VoiceError
        ? error
        : new VoiceError("recorder_failed", message);
    } finally {
      clearPending();
    }
  }

  /**
   * Stop the active recording and enqueue transcription. Returns the job;
   * transcription continues asynchronously (see `drainQueue`).
   */
  async stopRecording(jobID?: string): Promise<VoiceJob> {
    // Rendezvous with recorder startup: the mic is already open while
    // `recorder.start()` is in flight, so wait for it instead of orphaning it.
    if (
      (!this.activeRecording ||
        (jobID && this.activeRecording.jobID !== jobID)) &&
      this.pendingStart &&
      (!jobID || this.pendingStart.jobID === jobID)
    ) {
      await this.pendingStart.settled;
    }
    const active = this.activeRecording;
    if (!active || (jobID && active.jobID !== jobID)) {
      throw new VoiceError("job_not_found", "No active recording to stop.");
    }
    const job = this.jobs.get(active.jobID);
    if (!job) throw new VoiceError("job_not_found", "Recording job disappeared.");
    this.activeRecording = undefined;

    try {
      const { bytes } = await active.recording.stop();
      this.opts.logger.debug(VoiceEvents.recordingStopped, { job: job.id, bytes });
      this.opts.logger.debug(VoiceEvents.audioFileCreated, { job: job.id, bytes });
      if (bytes <= 44) {
        // WAV header only — nothing was captured.
        this.transition(job, "failed", {
          error: "Recording captured no audio.",
        });
        await this.cleanupAudio(job);
        throw new VoiceError(
          "recorder_failed",
          "Recording captured no audio.",
          "Check the microphone is not muted and the correct device is selected.",
        );
      }
    } catch (error) {
      if (error instanceof VoiceError && job.status === "failed") throw error;
      const message =
        error instanceof VoiceError ? error.message : "Could not stop recording.";
      if (job.status === "recording") {
        this.transition(job, "failed", { error: message });
      }
      await this.cleanupAudio(job);
      throw error instanceof VoiceError
        ? error
        : new VoiceError("recorder_failed", message);
    }

    this.transition(job, "queued");
    this.opts.logger.debug(VoiceEvents.jobQueued, { job: job.id });
    this.queue.push(job.id);
    void this.drainQueue();
    return job;
  }

  /** Cancel the active recording (or a queued/transcribing job). */
  async cancelJob(jobID?: string): Promise<VoiceJob> {
    const pending = this.pendingStart;
    if (
      !this.activeRecording &&
      pending &&
      (!jobID || pending.jobID === jobID)
    ) {
      // Recorder still starting: wait for it, then cancel the live child so
      // the microphone is released instead of orphaned.
      await pending.settled;
    }
    const targetID = jobID ?? this.activeRecording?.jobID ?? pending?.jobID;
    if (!targetID) throw new VoiceError("job_not_found", "Nothing to cancel.");
    const job = this.jobs.get(targetID);
    if (!job) throw new VoiceError("job_not_found", `Unknown voice job ${targetID}.`);

    if (job.status === "recording" && this.activeRecording?.jobID === job.id) {
      const active = this.activeRecording;
      this.activeRecording = undefined;
      await active.recording.cancel().catch(() => undefined);
      this.transition(job, "cancelled");
      await this.cleanupAudio(job);
      this.opts.logger.debug(VoiceEvents.recordingCancelled, { job: job.id });
      return job;
    }

    if (job.status === "queued" || job.status === "transcribing") {
      this.transcribeTokens.get(job.id)?.abort();
      this.queue = this.queue.filter((id) => id !== job.id);
      if (job.status === "queued") {
        this.transition(job, "cancelled");
        await this.cleanupAudio(job);
      }
      // A transcribing job completes its own transition to `cancelled`
      // when the provider observes the abort.
      return job;
    }

    if (job.status === "ready") {
      this.transition(job, "cancelled");
      await this.cleanupAudio(job);
      return job;
    }

    // completed/cancelled/failed: idempotent no-op.
    return job;
  }

  /**
   * Mark a `ready` job as completed after the transcript was inserted into
   * its originating composer. Enforces session ownership: the caller must
   * pass the currently active route, which must match the job origin —
   * except floating `home` jobs, which may complete into a session of the
   * same instance/directory (see `canInsertInto`).
   */
  markInserted(
    jobID: string,
    currentRoute: VoiceJob["origin"],
    currentDirectory?: string,
  ): VoiceJob {
    const job = this.jobs.get(jobID);
    if (!job) throw new VoiceError("job_not_found", `Unknown voice job ${jobID}.`);
    if (
      !canInsertInto(job, currentRoute, this.opts.instanceID, currentDirectory)
    ) {
      throw new VoiceError(
        "session_mismatch",
        `Voice job ${job.id} belongs to a different session and was not inserted.`,
        "Switch back to the originating session (or cancel the job).",
      );
    }
    if (job.status !== "ready") {
      throw new VoiceError(
        "invalid_transition",
        `Voice job ${job.id} is ${job.status}, not ready for insertion.`,
      );
    }
    this.transition(job, "completed");
    this.opts.logger.debug(VoiceEvents.jobCompleted, { job: job.id });
    void this.cleanupAudio(job);
    void this.drainQueue();
    return job;
  }

  /**
   * Find a `ready` job safe to insert into `currentRoute`:
   * newest ready job whose origin matches. Exact-origin matches win; then
   * floating `home` jobs when current is a `session` (same instance, and
   * same directory when known). Returns undefined when the transcript must
   * stay parked (wrong session).
   */
  findInsertable(
    currentRoute: VoiceJob["origin"],
    currentDirectory?: string,
  ): VoiceJob | undefined {
    const ready = [...this.jobs.values()]
      .filter((j) => j.status === "ready")
      .sort((a, b) => b.updatedAt - a.updatedAt);
    // Exact-origin matches first (never let a newer floating home job jump
    // ahead of this session's own transcript), then floating home jobs.
    const exact = ready.find((j) =>
      ownsSession(j, currentRoute, this.opts.instanceID),
    );
    if (exact) return exact;
    return ready.find(
      (j) =>
        j.origin.route === "home" &&
        canInsertInto(j, currentRoute, this.opts.instanceID, currentDirectory),
    );
  }

  /**
   * True when a newer job is still in flight. The settle loop uses this so an
   * action always delivers the CURRENT recording: an older send job waits
   * while a newer recording/transcription runs instead of submitting stale
   * content first.
   */
  hasNewerActiveJob(jobID: string): boolean {
    const job = this.jobs.get(jobID);
    if (!job) return false;
    for (const j of this.jobs.values()) {
      if (
        j.id !== jobID &&
        j.createdAt >= job.createdAt &&
        (j.status === "recording" || j.status === "queued" || j.status === "transcribing")
      ) {
        return true;
      }
    }
    return false;
  }

  /** Direct access for the TUI layer to complete insertion bookkeeping. */
  setTranscriptReady(job: VoiceJob, transcript: string): void {
    job.transcript = transcript;
    job.updatedAt = Date.now();
  }

  private async drainQueue(): Promise<void> {
    if (this.disposed) return;
    const max = Math.max(
      1,
      this.opts.maxConcurrentTranscriptions ?? 1,
    );
    while (this.runningTranscriptions < max) {
      const nextID = this.queue.shift();
      if (!nextID) return;
      const job = this.jobs.get(nextID);
      if (!job || job.status !== "queued") continue;
      this.runningTranscriptions += 1;
      void this.transcribeJob(job).finally(() => {
        this.runningTranscriptions -= 1;
        void this.drainQueue();
      });
    }
  }

  private async transcribeJob(job: VoiceJob): Promise<void> {
    const controller = new AbortController();
    this.transcribeTokens.set(job.id, controller);
    this.transition(job, "transcribing");
    this.opts.logger.debug(VoiceEvents.providerSelected, {
      job: job.id,
      provider: this.opts.provider.id,
    });
    this.opts.logger.debug(VoiceEvents.transcriptionStarted, { job: job.id });

    const transcribeOptions: TranscriptionOptions = {
      language: job.language,
      model: job.model,
      signal: controller.signal,
    };
    try {
      const model = await this.opts.provider.resolveModel(job.model).catch(() => undefined);
      if (model) {
        job.model = model.path;
        this.opts.logger.debug(VoiceEvents.modelSelected, {
          job: job.id,
          model: model.path,
        });
      }
      const result = await this.opts.provider.transcribe(
        job.audioPath ?? "",
        transcribeOptions,
      );
      this.transcribeTokens.delete(job.id);
      if (controller.signal.aborted) {
        if (job.status === "transcribing") {
          this.transition(job, "cancelled");
          await this.cleanupAudio(job);
        }
        return;
      }
      job.transcript = result.text;
      job.updatedAt = Date.now();
      this.transition(job, "ready");
      this.opts.logger.debug(VoiceEvents.transcriptionCompleted, {
        job: job.id,
        chars: result.text.length,
      });
      // Empty (silence) results complete immediately without insertion.
      if (result.text.trim().length === 0) {
        job.error = "No speech detected in the recording.";
        this.transition(job, "completed");
        await this.cleanupAudio(job);
      } else if (!this.opts.keepAudio) {
        await this.cleanupAudio(job);
      }
    } catch (error) {
      this.transcribeTokens.delete(job.id);
      const cancelled =
        controller.signal.aborted ||
        (error instanceof VoiceError && error.code === "job_cancelled");
      if (cancelled && job.status === "transcribing") {
        this.transition(job, "cancelled");
        await this.cleanupAudio(job);
        return;
      }
      const message =
        error instanceof VoiceError ? error.message : "Transcription failed.";
      if (job.status === "transcribing") {
        this.transition(job, "failed", { error: message });
      }
      this.opts.logger.debug(VoiceEvents.jobFailed, { job: job.id, error: message });
      await this.cleanupAudio(job);
    }
  }

  private async cleanupAudio(job: VoiceJob): Promise<void> {
    if (this.opts.keepAudio) return;
    const audioPath = job.audioPath;
    job.audioPath = undefined;
    await removeQuietly(audioPath);
    if (audioPath) await removeQuietly(parentDir(audioPath));
    this.opts.logger.debug(VoiceEvents.cleanupCompleted, { job: job.id });
    this.emit();
  }

  /** Forget terminal jobs (completed/cancelled/failed) to bound memory. */
  pruneFinished(keepLast = 10): void {
    const terminal = [...this.jobs.values()]
      .filter((j) => ["completed", "cancelled", "failed"].includes(j.status))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    for (const job of terminal.slice(keepLast)) {
      this.jobs.delete(job.id);
    }
    this.emit();
  }

  private assertUsable(): void {
    if (this.disposed) {
      throw new VoiceError("recorder_failed", "Voice manager is disposed.");
    }
  }

  /** Cancel everything and release resources (called on plugin unload). */
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.pendingStart) {
      await this.pendingStart.settled;
    }
    if (this.activeRecording) {
      const active = this.activeRecording;
      this.activeRecording = undefined;
      await active.recording.cancel().catch(() => undefined);
      const job = this.jobs.get(active.jobID);
      if (job && job.status === "recording") {
        try {
          this.transition(job, "cancelled");
        } catch {
          /* already terminal */
        }
        await this.cleanupAudio(job);
      }
    }
    for (const controller of this.transcribeTokens.values()) {
      controller.abort();
    }
    this.queue = [];
  }
}

function parentDir(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  if (idx <= 0) return filePath;
  const parent = filePath.slice(0, idx);
  // Only remove our own temp dirs, never arbitrary parents.
  if (/opencode-voice-rec-[A-Za-z0-9]+$/.test(parent)) return parent;
  return filePath;
}
