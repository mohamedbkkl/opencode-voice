/**
 * TUI plugin entry (`./tui` export).
 *
 * Target-exclusive module: default-exports `{ id, tui }` only (never `server`).
 * Plain TypeScript, no JSX — palette/slash commands, keybindings and toasts.
 * A richer slot UI (mic button in `session_prompt_right`, inline recording
 * indicator) is a follow-up once the pipeline is proven.
 *
 * Flow:
 *   `<leader>v` start → record → `<leader>i` stop+copy (auto-paste into the
 *   focused composer) or `<leader>o` stop+submit (paste + submit through the
 *   composer, guaranteed direct delivery as fallback) → transcribe in
 *   background → settle into the recording session (copy needs no session).
 */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui";
import { loadConfig, type ConfigOverrides } from "./core/config.js";
import { diagnose, formatDiagnostics } from "./core/diagnostics.js";
import { VoiceJobManager, canInsertInto } from "./core/jobs.js";
import {
  createSerializer,
  decideModelAlignment,
  messageContainsText,
  modelLabel,
  parseChatModelOption,
  parseChatModelString,
  type ChatModel,
} from "./core/submit-model.js";
import { copyText } from "./core/clipboard.js";
import { autoPaste, parsePasteMethod, type PasteMethod } from "./core/autopaste.js";
import { setupVoiceUI, type VoiceSlotApi } from "./tui-ui.js";
import { claimProcessSlot } from "./core/singleton.js";
import { Logger, VoiceEvents } from "./core/logger.js";
import type { VoiceJob } from "./core/types.js";
import { VoiceError } from "./core/types.js";
import { createProvider } from "./providers/provider.js";
import type { SpeechProvider } from "./providers/provider.js";
import { selectProvider } from "./providers/index.js";
import "./providers/whisper-cpp.js";
import "./providers/transcribe-cpp.js";
import { createDefaultRecorder } from "./recorder/ffmpeg.js";
import { instanceID } from "./utils/process.js";
import { inspectSetup } from "./setup.js";

export const PLUGIN_ID = "opencode-voice";
const RECORDING_MODE = "opencode-voice.recording";

interface KeybindOptions {
  start?: string | false;
  stopInsert?: string | false;
  stopSend?: string | false;
  cancel?: string | false;
}

const DEFAULT_KEYBINDS: Required<Record<keyof KeybindOptions, string | false>> = {
  // All defaults use the leader key (recommended pattern) and avoid every
  // binding listed in the OpenCode keybind reference.
  start: "<leader>v",
  stopInsert: "<leader>i",
  stopSend: "<leader>o",
  cancel: false,
};

function readPluginOptions(
  raw: unknown,
): Omit<ConfigOverrides, "chatModel"> & {
  keybinds?: KeybindOptions;
  chatModel?: ChatModel;
  autoPaste?: boolean;
  autoPasteApps?: string[];
  pasteMethod?: PasteMethod;
} {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const o = raw as Record<string, unknown>;
  const out: Omit<ConfigOverrides, "chatModel"> & {
    keybinds?: KeybindOptions;
    chatModel?: ChatModel;
    autoPaste?: boolean;
    autoPasteApps?: string[];
    pasteMethod?: PasteMethod;
  } = {};
  if (typeof o["provider"] === "string") out.provider = o["provider"];
  if (typeof o["model"] === "string") out.model = o["model"];
  if (typeof o["modelPath"] === "string") out.modelPath = o["modelPath"];
  if (typeof o["executablePath"] === "string") out.executablePath = o["executablePath"];
  if (typeof o["language"] === "string") out.language = o["language"];
  if (typeof o["device"] === "string") out.device = o["device"];
  if (typeof o["debug"] === "boolean") out.debug = o["debug"];
  if (typeof o["keepAudio"] === "boolean") out.keepAudio = o["keepAudio"];
  if (Array.isArray(o["modelSearchDirs"])) {
    out.modelSearchDirs = o["modelSearchDirs"].filter((v): v is string => typeof v === "string");
  }
  if (typeof o["maxConcurrentTranscriptions"] === "number") {
    out.maxConcurrentTranscriptions = o["maxConcurrentTranscriptions"];
  }
  if (typeof o["threads"] === "number") out.threads = o["threads"];
  if (typeof o["transcriptionTimeoutMs"] === "number") {
    out.transcriptionTimeoutMs = o["transcriptionTimeoutMs"];
  }
  const chatModel =
    parseChatModelOption(o["chatModel"]) ??
    parseChatModelString(process.env["OPENCODE_VOICE_CHAT_MODEL"]);
  if (chatModel) out.chatModel = chatModel;
  const autoPasteEnv = (process.env["OPENCODE_VOICE_AUTO_PASTE"] ?? "").toLowerCase().trim();
  if (typeof o["autoPaste"] === "boolean") out.autoPaste = o["autoPaste"];
  else if (["0", "false", "no", "off"].includes(autoPasteEnv)) out.autoPaste = false;
  else if (["1", "true", "yes", "on"].includes(autoPasteEnv)) out.autoPaste = true;
  if (Array.isArray(o["autoPasteApps"])) {
    const apps = o["autoPasteApps"].filter((v): v is string => typeof v === "string");
    out.autoPasteApps = apps;
  }
  out.pasteMethod = parsePasteMethod(o["pasteMethod"] ?? process.env["OPENCODE_VOICE_PASTE_METHOD"]);
  if (o["keybinds"] && typeof o["keybinds"] === "object") {
    const k = o["keybinds"] as Record<string, unknown>;
    const keybinds: KeybindOptions = {};
    for (const name of ["start", "stopInsert", "stopSend", "cancel"] as const) {
      const v = k[name];
      if (typeof v === "string" || v === false) keybinds[name] = v;
    }
    out.keybinds = keybinds;
  }
  return out;
}

type Origin = VoiceJob["origin"];

function activeTabSessionID(api: TuiPluginApi): string | undefined {
  try {
    const tabs = (api as unknown as { ui?: { tabs?: { list?: () => Array<{ sessionID?: unknown; active?: unknown }> } } }).ui?.tabs;
    const list = tabs?.list?.();
    if (Array.isArray(list)) {
      for (const tab of list) {
        if (tab && tab.active === true && typeof tab.sessionID === "string" && tab.sessionID !== "") {
          return tab.sessionID;
        }
      }
      // No active flag (e.g. tabs disabled): use the single open tab if any.
      if (list.length === 1 && typeof list[0]?.sessionID === "string" && (list[0]?.sessionID as string) !== "") {
        return list[0]?.sessionID as string;
      }
    }
  } catch {
    /* tabs unavailable */
  }
  return undefined;
}

interface CachedSessionInfo {
  id?: string;
  sessionID?: string;
  location?: { directory?: string };
  time?: { updated?: number; created?: number };
  model?: { id?: string; providerID?: string };
  agent?: string;
}



function currentOrigin(api: TuiPluginApi): Origin {
  const route = api.route.current;
  if (route.name === "session") {
    const sessionID = (route.params as { sessionID?: unknown } | undefined)?.sessionID;
    if (typeof sessionID === "string" && sessionID !== "") {
      return { route: "session", sessionID };
    }
  }
  // TUI-local only: router, then active tab. Never fall back to a global
  // most-recent session — that list includes web/agent sessions (like this
  // chat) and voice would leak into the wrong conversation.
  const tabID = activeTabSessionID(api);
  if (tabID) return { route: "session", sessionID: tabID };
  if (route.name === "home") return { route: "home" };
  // Other (plugin) routes have no composer of their own; treat like home so a
  // transcript can still be parked and inserted once the user returns home.
  return { route: "home" };
}

function currentDirectory(api: TuiPluginApi, fallback: string): string {
  try {
    const dir = api.state.path.directory;
    if (typeof dir === "string" && dir !== "") return dir;
  } catch {
    /* ignore */
  }
  return fallback;
}

export const OpenCodeVoiceTui: TuiPlugin = async (api, options) => {
  // Global + project-local entries can both load in one process; the second
  // copy stands down so keybindings/commands register exactly once.
  if (!claimProcessSlot("opencode-voice.tui")) return;
  const pluginOptions = readPluginOptions(options);
  const autoPasteEnabled = pluginOptions.autoPaste ?? true;
  const autoPasteApps = pluginOptions.autoPasteApps ?? [];
  const pasteMethod = pluginOptions.pasteMethod ?? "auto";
  // Core config must not receive TUI-only parsed values (chatModel object
  // vs file-config string); the chain below reconciles them instead.
  const { chatModel: _chatModelOption, ...coreOverrides } = pluginOptions;
  const { config } = loadConfig({
    cwd: safeCwd(api),
    overrides: coreOverrides,
  });
  // Precedence: plugin options > env > shared file config > unset.
  const chatModel =
    _chatModelOption ?? parseChatModelString(config.chatModel);
  const logger = new Logger({ debug: config.debug });
  const instance = instanceID();

  // Do not block command registration on hardware or model discovery. In
  // particular, a V2 host must still expose `/voice-status` and friends when
  // ffmpeg or a local model is missing.
  let selection: Awaited<ReturnType<typeof selectProvider>> | undefined;
  let provider: SpeechProvider | undefined;
  let recorder: Awaited<ReturnType<typeof createDefaultRecorder>> | undefined;
  const initialization = (async () => {
    const [sel, rec] = await Promise.all([
      selectProvider(config, logger).catch(() => undefined),
      createDefaultRecorder().catch(() => undefined),
    ]);
    selection = sel;
    provider =
      selection?.provider ??
      createProvider(config.provider, config) ??
      createProvider("whisper.cpp", config);
    if (selection?.fallbackFrom) {
      logger.info(`using fallback voice provider "${provider?.id ?? "unknown"}" (configured: "${selection.fallbackFrom}")`);
    }
    recorder = rec;
    if (!recorder) {
      logger.warn("no audio recorder available; voice commands will report it", {
        platform: process.platform,
      });
    }
    // Prewarm model + executable caches in background so the first
    // transcription never pays discovery cost. Never blocks.
    void provider?.discoverModels().catch(() => undefined);
    void provider?.isAvailable().catch(() => undefined);
    void recorder?.listDevices().catch(() => undefined);
  })();

  // Lazily created on first use so failed/slow probes never block TUI startup.
  let manager: VoiceJobManager | undefined;
  let popRecordingMode: (() => void) | undefined;
  const announcedReady = new Set<string>();
  const inserting = new Set<string>();
  let settleChain: Promise<void> = Promise.resolve();
  // Exactly one composer paste+submit at a time (auto-settle vs explicit
  // keypress): interleaved submits mix two transcripts into one composer.
  const composerRun = createSerializer();
  function requestSettle(): void {
    settleChain = settleChain.then(() => settleReadyJobsInner()).catch(() => undefined);
  }

  function ensureManager(): VoiceJobManager {
    if (manager) return manager;
    if (!provider) {
      throw new VoiceError(
        "provider_unavailable",
        `Voice provider "${config.provider}" is unavailable.`,
        "Run /voice-diagnose for installation and model details.",
      );
    }
    if (!recorder) {
      throw new VoiceError(
        "recorder_unavailable",
        "Voice recording is not available (no audio recorder).",
        process.platform === "darwin"
          ? "Install ffmpeg (`brew install ffmpeg`) and restart OpenCode."
          : "Install ffmpeg, ensure it is on PATH, and restart OpenCode.",
      );
    }
    manager = new VoiceJobManager({
      instanceID: instance,
      provider,
      recorder,
      logger,
      maxConcurrentTranscriptions: config.maxConcurrentTranscriptions,
      keepAudio: config.keepAudio,
      defaultLanguage: config.language,
      sampleRate: config.sampleRate,
      channels: config.channels,
      device: config.device,
      onChange: () => settleReadyJobs(),
    });
    return manager;
  }

  function toast(
    variant: "info" | "success" | "warning" | "error",
    message: string,
    title = "Voice",
  ): void {
    try {
      api.ui.toast({
        variant,
        title,
        message,
        duration: variant === "error" ? 5000 : 3000,
      });
    } catch {
      /* toast must never break the pipeline */
    }
  }

  function friendlyError(error: unknown): string {
    if (error instanceof VoiceError) {
      return error.hint ? `${error.message} ${error.hint}` : error.message;
    }
    if (error instanceof Error) return error.message;
    return String(error);
  }

  async function handleStart(): Promise<void> {
    try {
      await initialization;
      const mgr = ensureManager();
      const existing = mgr.recordingJob();
      if (existing) {
        const secs = Math.round((Date.now() - existing.createdAt) / 1000);
        toast("info", `Already recording (${secs}s). <leader>i / <leader>e copy, <leader>o send.`);
        return;
      }
      const job = await mgr.startRecording({
        directory: currentDirectory(api, process.cwd()),
        origin: currentOrigin(api),
        model: config.model === "auto" ? undefined : config.model,
        language: config.language,
        requestedAction: "insert",
      });
      try {
        popRecordingMode?.();
        popRecordingMode = api.mode.push(RECORDING_MODE);
      } catch {
        /* mode push is best-effort */
      }
      logger.debug(VoiceEvents.recordingStarted, { job: job.id });
      if (job.origin.route === "home") {
        toast("info", "● Recording… Stop: <leader>i / <leader>e copy, <leader>o send.");
      } else {
        toast("info", "● Recording… <leader>i / <leader>e copy, <leader>o send, esc cancel.");
      }
    } catch (error) {
      toast("error", friendlyError(error));
    }
  }

  async function handleStop(action: "insert" | "insert-and-send"): Promise<void> {
    try {
      await initialization;
      const mgr = ensureManager();
      const recording = mgr.recordingJob();
      if (!recording) {
        // No live recording: NEVER deliver an older parked transcript here —
        // that is how a previous recording gets sent for the current action.
        // Explicit delivery stays on /voice-insert.
        const busy = mgr
          .listJobs()
          .some((j) => ["recording", "queued", "transcribing"].includes(j.status));
        if (busy) {
          toast("info", "Still transcribing — I will deliver the current recording when ready.");
        } else {
          const parked = mgr.listJobs().filter((j) => j.status === "ready");
          toast(
            "info",
            parked.length > 0
              ? "No active recording — /voice-insert delivers the parked transcript."
              : "No active recording.",
          );
        }
        return;
      }
      recording.requestedAction = action;
      // If recording started on home (stale router) but we're now in a
      // session, adopt the current session so submit lands here, not in an
      // old session via most-recent fallback.
      try {
        const now = currentOrigin(api);
        if (recording.origin.route === "home" && now.route === "session" && now.sessionID) {
          recording.origin = { route: "session", sessionID: now.sessionID };
        }
      } catch { /* best effort */ }
      popRecordingMode?.();
      popRecordingMode = undefined;
      const job = await mgr.stopRecording(recording.id);
      const verb = action === "insert-and-send" ? "submit it" : "copy it to clipboard";
      const snap = mgr.snapshot();
      if (snap.queued > 0 || snap.transcribing > 0) {
        toast("info", `Transcribing in background (queued: ${snap.queued}). Keep working — I will ${verb} when ready.`);
      } else {
        toast("info", "Transcribing…");
      }
      // Insertion happens via settleReadyJobs() when transcription finishes.
      void job;
    } catch (error) {
      popRecordingMode?.();
      popRecordingMode = undefined;
      toast("error", friendlyError(error));
    }
  }

  async function handleCancel(): Promise<void> {
    try {
      await initialization;
      const mgr = ensureManager();
      popRecordingMode?.();
      popRecordingMode = undefined;
      await mgr.cancelJob();
      toast("info", "Recording cancelled — nothing was inserted.");
    } catch (error) {
      toast("error", friendlyError(error));
    }
  }

  async function handleInsertReady(): Promise<void> {
    try {
      await initialization;
      const mgr = ensureManager();
      const origin = currentOrigin(api);
      const directory = currentDirectory(api, process.cwd());
      const job = mgr.findInsertable(origin, directory);
      if (!job?.transcript?.trim()) {
        const parked = mgr.listJobs().filter((j) => j.status === "ready");
        if (parked.length > 0) {
          if (origin.route === "home") {
            toast(
              "warning",
              `${parked.length} transcript${parked.length === 1 ? "" : "s"} parked. Run /voice-insert to copy.`,
            );
          } else {
            toast(
              "warning",
              `${parked.length} transcript${parked.length === 1 ? "" : "s"} parked for another session. Switch back there, or record fresh here.`,
            );
          }
        } else {
          toast("info", origin.route === "home" ? "No transcript yet — open a session first, then record." : "No finished voice transcript for this session.");
        }
        return;
      }
      // Guard against double-tap: if a settle is already delivering it, wait.
      if (inserting.has(job.id)) {
        toast("info", "Delivering transcript…");
        return;
      }
      (job as { __insertFailed?: boolean }).__insertFailed = false;
      await insertJob(mgr, job, origin);
    } catch (error) {
      toast("error", friendlyError(error));
    }
  }

  async function handleStatus(): Promise<void> {
    try {
      await initialization;
      const mgr = ensureManager();
      const snap = mgr.snapshot();
      const lines: string[] = [`UI slots: ${uiSlots}/3`];
      if (snap.activeJob) {
        const secs = Math.round((Date.now() - snap.activeJob.createdAt) / 1000);
        lines.push(`● recording ${secs}s (${snap.activeJob.id})`);
      }
      if (snap.transcribing > 0) lines.push(`transcribing: ${snap.transcribing}`);
      if (snap.queued > 0) lines.push(`queued: ${snap.queued}`);
      lines.push(`ready to insert: ${snap.ready.length}`);
      const recent = mgr
        .listJobs()
        .filter((j) => ["failed", "completed", "cancelled"].includes(j.status))
        .slice(0, 3);
      for (const job of recent) {
        lines.push(`${job.status}: ${job.id}${job.error ? ` — ${job.error}` : ""}`);
      }
      toast("info", lines.join("\n") || "idle", "Voice status");
    } catch (error) {
      toast("error", friendlyError(error));
    }
  }

  async function handleDiagnose(): Promise<void> {
    try {
      await initialization;
      if (!provider) {
        toast("error", `Unknown or unavailable provider "${config.provider}".`, "Voice diagnostics");
        return;
      }
      const diagnostics = await diagnose({ config, provider, recorder });
      toast(
        diagnostics.ready ? "success" : "warning",
        formatDiagnostics(diagnostics).slice(0, 900),
        "Voice diagnostics",
      );
    } catch (error) {
      toast("error", friendlyError(error));
    }
  }

  async function handleSetup(): Promise<void> {
    try {
      const snapshot = await inspectSetup({ cwd: safeCwd(api) });
      if (snapshot.ready) {
        toast(
          "success",
          `Ready: ${snapshot.selectedProvider} with ${snapshot.selectedModel?.id ?? "auto"}.`,
          "Voice setup",
        );
        return;
      }
      const missing = snapshot.actions.map((action) => action.title).join(", ");
      toast(
        "warning",
        `${missing || "Setup required"}. Run \`npx opencode-voice setup\` in a terminal for the guided installer.`,
        "Voice setup",
      );
    } catch (error) {
      toast("error", friendlyError(error), "Voice setup");
    }
  }

  function getStoredModel(
    sessionID: string,
  ): { providerID?: string; id?: string } | undefined {
    try {
      const data = (
        api as unknown as {
          data?: { session?: { get?: (id: string) => { model?: { providerID?: string; id?: string } } | undefined } };
        }
      ).data;
      return data?.session?.get?.(sessionID)?.model;
    } catch {
      return undefined;
    }
  }

  function getMessageCount(sessionID: string): number | undefined {
    try {
      const data = (
        api as unknown as {
          data?: { session?: { message?: { list?: (id: string) => Array<unknown> | undefined } } };
        }
      ).data;
      const list = data?.session?.message?.list?.(sessionID);
      if (list === undefined) return undefined;
      return list.length;
    } catch {
      return undefined;
    }
  }

  /**
   * Dispatch a built-in TUI command (v2.0.14: `prompt.paste` reads the system
   * clipboard into the focused composer). Returns false when the host does
   * not expose dispatch.
   */
  function dispatchCommand(id: string): boolean {
    try {
      const keymap = (
        api as unknown as { keymap?: { dispatch?: (cmd: string) => unknown } }
      ).keymap;
      if (typeof keymap?.dispatch !== "function") return false;
      keymap.dispatch(id);
      return true;
    } catch {
      return false;
    }
  }

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function getSessionMessages(sessionID: string): unknown[] {
    try {
      const data = (
        api as unknown as {
          data?: { session?: { message?: { list?: (id: string) => unknown } } };
        }
      ).data;
      const list = data?.session?.message?.list?.(sessionID);
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  function syncSessionMessages(sessionID: string): Promise<void> {
    try {
      const data = (
        api as unknown as {
          data?: { session?: { message?: { sync?: (id: string) => Promise<unknown> } } };
        }
      ).data;
      const sync = data?.session?.message?.sync?.(sessionID);
      if (sync && typeof (sync as Promise<unknown>).then === "function") {
        return (sync as Promise<unknown>).then(() => undefined);
      }
    } catch {
      /* best effort */
    }
    return Promise.resolve();
  }

  /**
   * Native composer submit (`o`): paste, wait for it to land, submit through
   * the composer so the run uses the footer-selected model/agent, then verify
   * a matching user message arrived. Returns false on any doubt — the caller
   * falls back to direct `session.prompt`, which is guaranteed.
   */
  async function submitViaComposer(sessionID: string, text: string): Promise<boolean> {
    // Exclusive: a concurrent paste+submit for another job would land in the
    // same composer and mix two transcripts into one submit.
    return composerRun(async () => {
      if (!dispatchCommand("prompt.paste")) return false;
      // Paste is async inside the host (clipboard read + Solid update); give
      // it room before submitting, otherwise we would send the previously
      // pasted (stale) text.
      await delay(1000);
      if (!dispatchCommand("prompt.submit")) return false;
      const needle = text.trim();
      if (needle === "") return false;
      const started = Date.now();
      let synced = false;
      for (;;) {
        if (messageContainsText(getSessionMessages(sessionID), needle)) return true;
        if (Date.now() - started > 5000) return false;
        if (!synced && Date.now() - started > 1500) {
          synced = true;
          await syncSessionMessages(sessionID);
        }
        await delay(250);
      }
    });
  }

  function getSessionSwitch(): ((input: unknown) => Promise<unknown>) | undefined {
    try {
      const session = (
        api.client as unknown as {
          session?: { switchModel?: (input: unknown) => Promise<unknown> };
        }
      )?.session;
      return session?.switchModel;
    } catch {
      return undefined;
    }
  }

  /**
   * Align a fresh session to the configured chat model (R11). Used sessions
   * keep their stored model; unknown states are left untouched. Returns the
   * label to display so the user always sees which model will run.
   */
  async function alignSessionModel(sessionID: string): Promise<{ label: string }> {
    const stored = getStoredModel(sessionID);
    const fallback = modelLabel(stored);
    if (!chatModel) return { label: fallback };
    const decision = decideModelAlignment({
      stored,
      messageCount: getMessageCount(sessionID),
      configured: chatModel,
    });
    if (!decision.switch) return { label: fallback };
    const switchFn = getSessionSwitch();
    if (!switchFn) return { label: fallback };
    try {
      await switchFn({
        sessionID,
        model: { providerID: chatModel.providerID, id: chatModel.id },
      });
      logger.debug(VoiceEvents.modelSelected, { job: sessionID, model: modelLabel(chatModel) });
    } catch (error) {
      throw new VoiceError(
        "insertion_failed",
        `Could not set chat model ${modelLabel(chatModel)}: ${error instanceof Error ? error.message : String(error)}`,
        "Check the chatModel option, or unset it to use the session default.",
      );
    }
    return { label: modelLabel(chatModel) };
  }

  async function ensureSessionID(origin: Origin, directory: string): Promise<string> {
    if (origin.route === "session" && origin.sessionID) return origin.sessionID;
    const tabID = activeTabSessionID(api);
    if (tabID) return tabID;
    // TUI-local only. Global session lists include web/agent conversations —
    // reusing them leaks voice into the wrong chat, so never do it here.
    // Last resort: create a fresh TUI session, inheriting model/agent from
    // the active tab's session when known (TUI-scoped get, never list scan).
    const client = api.client as unknown as {
      session?: {
        create?: (input?: unknown) => Promise<{ id?: string } | undefined>;
        prompt?: (input: unknown) => Promise<unknown>;
      };
    };
    if (client?.session?.create) {
      try {
        const input: Record<string, unknown> = { location: { directory } };
        try {
          const data = (api as unknown as { data?: { session?: { get?: (id: string) => CachedSessionInfo | undefined } } }).data;
          const donor = tabID ? data?.session?.get?.(tabID) : undefined;
          if (donor?.model) input["model"] = donor.model;
          if (typeof donor?.agent === "string" && donor.agent !== "") input["agent"] = donor.agent;
        } catch { /* ignore */ }
        const created = await client.session.create(input as unknown);
        const id = (created as unknown as { id?: unknown })?.id;
        const sid = typeof id === "string" && id !== "" ? id : (created as unknown as { sessionID?: unknown })?.sessionID;
        if (typeof sid === "string" && sid !== "") {
          try {
            const tabs = (api as unknown as { ui?: { tabs?: { focus?: (id: string) => unknown } } }).ui?.tabs;
            tabs?.focus?.(sid);
          } catch { /* ignore */ }
          try {
            (api.route as unknown as { navigate?: (name: string, params?: Record<string, unknown>) => void }).navigate?.("session", { sessionID: sid });
          } catch { /* ignore */ }
          toast("success", "Created a new session for your transcript.");
          return sid;
        }
      } catch (error) {
        throw new VoiceError(
          "insertion_failed",
          "No active session and auto-create failed.",
          error instanceof Error ? error.message : "Open a session first, then /voice-insert to retry.",
        );
      }
    }
    throw new VoiceError(
      "insertion_failed",
      "No active session to deliver the transcript to.",
      "Open a session first, then use “Voice: copy ready transcript” (/voice-insert) to retry.",
    );
  }

  function getSessionPrompt(): ((input: unknown) => Promise<unknown>) | undefined {
    try {
      const session = (
        api.client as unknown as {
          session?: { prompt?: (input: unknown) => Promise<unknown> };
        }
      )?.session;
      return session?.prompt;
    } catch {
      return undefined;
    }
  }

  /** Insert a ready job's transcript. Single-flight: concurrent callers coalesce. */
  async function insertJob(
    mgr: VoiceJobManager,
    job: VoiceJob,
    origin: Origin,
  ): Promise<void> {
    if (inserting.has(job.id)) return;
    inserting.add(job.id);
    try {
      const raw = job.transcript?.trim() ?? "";
      const directory = currentDirectory(api, process.cwd());
      if (!raw) {
        try {
          mgr.markInserted(job.id, origin, directory);
        } catch {
          /* already terminal */
        }
        announcedReady.delete(job.id);
        return;
      }
      logger.debug(VoiceEvents.insertionAttempted, { job: job.id });
      const targetDir = job.directory || directory;
      const tui = (api.client as unknown as { tui?: unknown } | undefined)?.tui as
        | {
            appendPrompt?: (input: unknown) => Promise<unknown>;
            submitPrompt?: (input: unknown) => Promise<unknown>;
          }
        | undefined;
      if (tui?.appendPrompt) {
        // V1 host: true draft into composer without submitting.
        await tui.appendPrompt({ text: raw, directory: targetDir });
        if (job.requestedAction === "insert-and-send") {
          await tui.submitPrompt?.({ directory: targetDir });
        }
        try {
          if (job.origin.route === "home" && origin.route === "session" && origin.sessionID) {
            job.origin = { route: "session", sessionID: origin.sessionID };
          }
        } catch { /* ignore */ }
        mgr.markInserted(job.id, origin, directory);
        announcedReady.delete(job.id);
        logger.debug(VoiceEvents.insertionCompleted, { job: job.id });
        toast(
          "success",
          job.requestedAction === "insert-and-send"
            ? "Transcript inserted and submitted."
            : "Transcript inserted into the composer.",
        );
        return;
      }
      // V2 host: no draft-append API — session.prompt always submits.
      // <leader>i / <leader>e (insert) = copy + integrated paste into the
      // focused composer (`prompt.paste` dispatch; keystroke fallback;
      // manual ⌘V last resort). No window, no submit, no session targeting.
      // <leader>o (insert-and-send) = submit to the RECORDING session (job
      // origin), never whatever tab is focused now. Home/floating send jobs
      // resolve via current session. Clipboard failure keeps the job parked.
      if (job.requestedAction !== "insert-and-send") {
        await copyText(raw);
        if (autoPasteEnabled && pasteMethod !== "keystroke") {
          // Integrated paste (v2.0.14 `prompt.paste`): in-process, no focus
          // or permission needed, works while the user is in another app.
          if (dispatchCommand("prompt.paste")) {
            const completedDispatch: Origin =
              job.origin.route === "session" && job.origin.sessionID
                ? { route: "session", sessionID: job.origin.sessionID }
                : origin;
            try {
              mgr.markInserted(job.id, completedDispatch, directory);
            } catch {
              mgr.markInserted(job.id, origin, directory);
            }
            announcedReady.delete(job.id);
            logger.debug(VoiceEvents.insertionCompleted, { job: job.id });
            toast("success", "Transcript pasted.");
            return;
          }
        }
        if (autoPasteEnabled && pasteMethod !== "dispatch") {
          // Keystroke fallback (macOS): synthetic ⌘V with a frontmost-app
          // guard. Needs the Accessibility permission on the terminal.
          const paste = await autoPaste(undefined, {
            extraApps: autoPasteApps,
          });
          if (paste.pasted) {
            const completedKeystroke: Origin =
              job.origin.route === "session" && job.origin.sessionID
                ? { route: "session", sessionID: job.origin.sessionID }
                : origin;
            try {
              mgr.markInserted(job.id, completedKeystroke, directory);
            } catch {
              mgr.markInserted(job.id, origin, directory);
            }
            announcedReady.delete(job.id);
            logger.debug(VoiceEvents.insertionCompleted, { job: job.id });
            toast("success", "Transcript pasted.");
            return;
          }
        }
        // Neither paste path fired (no dispatch on this host, keystroke off
        // or blocked): the clipboard still holds the text — complete the job
        // and let the user paste manually. Never fall through to submit.
        const completedManual: Origin =
          job.origin.route === "session" && job.origin.sessionID
            ? { route: "session", sessionID: job.origin.sessionID }
            : origin;
        try {
          mgr.markInserted(job.id, completedManual, directory);
        } catch {
          mgr.markInserted(job.id, origin, directory);
        }
        announcedReady.delete(job.id);
        logger.debug(VoiceEvents.insertionCompleted, { job: job.id });
        toast("success", "Transcript copied — paste with ⌘V / Ctrl+V.");
        return;
      }
      const sessionID =
        job.origin.route === "session" && job.origin.sessionID
          ? job.origin.sessionID
          : await ensureSessionID(origin, targetDir);
      const promptFn = getSessionPrompt();
      if (!promptFn) {
        throw new VoiceError(
          "insertion_failed",
          "Voice transcript delivery is unavailable on this host.",
          "The transcript is kept — use “Voice: copy ready transcript” (/voice-insert) to retry.",
        );
      }
      // Preferred: paste + submit through the composer so the run uses the
      // footer-selected model/agent and the user sees the text first. Falls
      // back to direct submit below — words are never lost either way.
      // Refresh the clipboard FIRST: `prompt.paste` reads the system
      // clipboard, so without this it would paste the previous recording.
      // If the refresh fails, skip the composer path (stale paste) and go
      // direct — never submit someone else's text.
      let clipboardFresh = true;
      try {
        await copyText(raw);
      } catch {
        clipboardFresh = false;
      }
      if (
        clipboardFresh &&
        pasteMethod !== "keystroke" &&
        (await submitViaComposer(sessionID, raw))
      ) {
        const completedNative: Origin =
          job.origin.route === "session" && job.origin.sessionID
            ? { route: "session", sessionID: job.origin.sessionID }
            : { route: "session", sessionID };
        try {
          mgr.markInserted(job.id, completedNative, directory);
        } catch {
          mgr.markInserted(job.id, origin, directory);
        }
        announcedReady.delete(job.id);
        logger.debug(VoiceEvents.insertionCompleted, { job: job.id });
        toast("success", "Pasted & submitted.");
        return;
      }
      const { label: runLabel } = await alignSessionModel(sessionID);
      await promptFn({ sessionID, text: raw });
      try {
        if (job.origin.route === "home") {
          job.origin = { route: "session", sessionID };
        }
      } catch { /* ignore */ }
      const completedOrigin: Origin =
        job.origin.route === "session" && job.origin.sessionID
          ? { route: "session", sessionID: job.origin.sessionID }
          : { route: "session", sessionID };
      mgr.markInserted(job.id, completedOrigin, directory);
      announcedReady.delete(job.id);
      logger.debug(VoiceEvents.insertionCompleted, { job: job.id });
      toast("success", `Transcript submitted with ${runLabel}.`);
    } catch (error) {
      if (error instanceof VoiceError) throw error;
      throw new VoiceError(
        "insertion_failed",
        `Could not insert transcript: ${error instanceof Error ? error.message : String(error)}`,
        "The transcript is kept — use “Voice: copy ready transcript” (/voice-insert) to retry.",
      );
    } finally {
      inserting.delete(job.id);
    }
  }

  /**
   * Settle loop (serialized, single-flight via `inserting`): `insert` jobs
   * auto-copy to the clipboard (paste where focus is, no targeting involved);
   * `insert-and-send` jobs auto-submit to the recording session, oldest
   * first, and never while a newer job is still in flight — an action always
   * delivers CURRENT content only after its transcription ends. Anything for
   * another session stays parked (never inserted into the wrong session).
   * Floating `home` jobs may complete into the next session of the same
   * directory.
   */
  async function settleReadyJobsInner(): Promise<void> {
    if (!manager) return;
    const mgr = manager;
    const origin = currentOrigin(api);
    const directory = currentDirectory(api, process.cwd());
    const ready = mgr
      .snapshot()
      .ready.map((snap) => mgr.getJob(snap.id))
      .filter((job): job is VoiceJob => !!job && job.status === "ready")
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const job of ready) {
      if (!canInsertInto(job, origin, instance, directory)) {
        if (!announcedReady.has(job.id)) {
          announcedReady.add(job.id);
          if (origin.route === "home") {
            toast(
              "warning",
              `Transcript ready (${describeOrigin(job)}). Open a session, then /voice-insert — nothing was moved.`,
            );
          } else {
            toast(
              "warning",
              `Transcript ready for another session (${describeOrigin(job)}). Switch back there to insert it — nothing was moved.`,
            );
          }
        }
        continue;
      }
      announcedReady.delete(job.id);
      if ((job as { __insertFailed?: boolean }).__insertFailed) continue;
      if (inserting.has(job.id)) continue;
      if (
        job.requestedAction === "insert-and-send" &&
        mgr.hasNewerActiveJob(job.id)
      ) {
        // A newer recording/transcription is still running: wait for it so
        // this action delivers current content, never stale content. The
        // chain re-runs when that job finishes.
        continue;
      }
      try {
        await insertJob(mgr, job, origin);
      } catch (error) {
        (job as { __insertFailed?: boolean }).__insertFailed = true;
        toast("error", friendlyError(error));
      }
    }
    // Surface failures (mic errors, missing model, …) exactly once.
    for (const snap of mgr.listJobs().slice(0, 5)) {
      if (
        (snap.status === "failed" || snap.status === "completed") &&
        snap.error &&
        !announcedReady.has(`seen:${snap.id}`)
      ) {
        announcedReady.add(`seen:${snap.id}`);
        if (snap.status === "failed") {
          toast("error", `${snap.id}: ${snap.error}`);
        } else if (snap.error === "No speech detected in the recording.") {
          toast("warning", "No speech detected in the recording — nothing inserted.");
        }
      }
    }
  }

  function settleReadyJobs(): void {
    requestSettle();
  }

  function describeOrigin(job: VoiceJob): string {
    return job.origin.route === "session"
      ? `session ${job.origin.sessionID?.slice(0, 8) ?? "?"}`
      : "home";
  }

  const keybinds = { ...DEFAULT_KEYBINDS, ...(pluginOptions.keybinds ?? {}) };

  // Register commands + keybindings defensively: an unexpected keymap shape
  // must never prevent the rest of the plugin from loading.
  try {
    api.keymap.registerLayer({
      commands: [
        {
          name: "voice.start",
          title: "Voice: start recording",
          category: "Voice",
          namespace: "palette",
          slashName: "voice",
          run: () => void handleStart(),
        },
        {
          name: "voice.stop-insert",
          title: "Voice: stop, transcribe & copy",
          category: "Voice",
          namespace: "palette",
          slashName: "voice-stop",
          run: () => void handleStop("insert"),
        },
        {
          name: "voice.stop-send",
          title: "Voice: stop, transcribe, insert & submit",
          category: "Voice",
          namespace: "palette",
          slashName: "voice-send",
          run: () => void handleStop("insert-and-send"),
        },
        {
          // Alias: users often hit <leader>e for "edit/insert" — same as <leader>i.
          name: "voice.stop-insert-alt",
          title: "Voice: stop, transcribe & copy (alias)",
          category: "Voice",
          run: () => void handleStop("insert"),
        },
        {
          name: "voice.cancel",
          title: "Voice: cancel recording",
          category: "Voice",
          namespace: "palette",
          slashName: "voice-cancel",
          run: () => void handleCancel(),
        },
        {
          name: "voice.insert-ready",
          title: "Voice: copy ready transcript",
          category: "Voice",
          namespace: "palette",
          slashName: "voice-insert",
          run: () => void handleInsertReady(),
        },
        {
          name: "voice.status",
          title: "Voice: status",
          category: "Voice",
          namespace: "palette",
          slashName: "voice-status",
          run: () => void handleStatus(),
        },
        {
          name: "voice.diagnose",
          title: "Voice: diagnostics",
          category: "Voice",
          namespace: "palette",
          slashName: "voice-diagnose",
          run: () => void handleDiagnose(),
        },
        {
          name: "voice.setup",
          title: "Voice: setup wizard",
          category: "Voice",
          namespace: "palette",
          slashName: "voice-setup",
          run: () => void handleSetup(),
        },
      ],
      bindings: [
        ...(keybinds.start ? [{ key: keybinds.start, cmd: "voice.start", desc: "Voice: start recording" }] : []),
        ...(keybinds.stopInsert ? [{ key: keybinds.stopInsert, cmd: "voice.stop-insert", desc: "Voice: stop & insert" }] : []),
        // <leader>e alias for copy (same action as <leader>i).
        ...(keybinds.stopInsert ? [{ key: "<leader>e", cmd: "voice.stop-insert-alt", desc: "Voice: stop & insert (alias)" }] : []),
        ...(keybinds.stopSend ? [{ key: keybinds.stopSend, cmd: "voice.stop-send", desc: "Voice: stop, insert & submit" }] : []),
        ...(keybinds.cancel ? [{ key: keybinds.cancel, cmd: "voice.cancel", desc: "Voice: cancel" }] : []),
      ],
    });
  } catch (error) {
    logger.warn("keymap registration failed; slash/palette commands may be unavailable", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Mode-gated escape → cancel while recording. Best-effort: if the host
  // keymap has no `mode` support the global cancel binding/palette still work.
  try {
    api.keymap.registerLayer({
      mode: RECORDING_MODE,
      commands: [
        {
          name: "voice.cancel-recording",
          title: "Voice: cancel recording",
          category: "Voice",
          run: () => void handleCancel(),
        },
      ],
      bindings: [{ key: "escape", cmd: "voice.cancel-recording", desc: "Voice: cancel recording" }],
    } as Parameters<TuiPluginApi["keymap"]["registerLayer"]>[0]);
  } catch {
    /* mode-gated cancel is optional */
  }

  // Ambient UI (footer timer, composer hint): best-effort, V2 slots only.
  // The count surfaces in /voice-status so a missing UI is diagnosable.
  let uiSlots = 0;
  const sessionTitleOf = (sessionID: string): string | undefined => {
    try {
      const data = (
        api as unknown as {
          data?: { session?: { get?: (id: string) => { title?: string } | undefined } };
        }
      ).data;
      return data?.session?.get?.(sessionID)?.title;
    } catch {
      return undefined;
    }
  };
  try {
    uiSlots = setupVoiceUI(
      api as unknown as VoiceSlotApi,
      () => manager?.snapshot(),
      sessionTitleOf,
    );
  } catch {
    /* UI must never break the pipeline */
  }

  api.lifecycle.onDispose(() => {
    popRecordingMode?.();
    popRecordingMode = undefined;
    announcedReady.clear();
    const m = manager;
    manager = undefined;
    return m?.dispose() ?? Promise.resolve();
  });

  logger.debug("tui plugin initialized", { instance });
};

function safeCwd(api: TuiPluginApi): string {
  try {
    const dir = api.state.path.directory;
    if (typeof dir === "string" && dir !== "") return dir;
  } catch {
    /* ignore */
  }
  return process.cwd();
}

export default {
  id: PLUGIN_ID,
  tui: OpenCodeVoiceTui,
};
