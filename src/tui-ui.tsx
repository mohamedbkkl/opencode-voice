/**
 * Windowless UI for OpenCode Voice (V2 slot layer).
 *
 * Palette/slash/toasts stay in `tui.ts`. This module owns *ambient* UI only:
 * a recording timer in the prompt/home footer status rows and a state line
 * above the session composer. No dialogs, no panels — the transcript flow
 * itself stays keybinding-driven and silent.
 *
 * Plain polling (500ms) over the manager snapshot keeps this decoupled from
 * the job state machine; the host owns all rendering. Skipped entirely on
 * hosts without `ui.slot` (e.g. V1).
 */
import { createSignal } from "solid-js";
import type { ManagerSnapshot } from "./core/jobs.js";

export interface VoiceSlotClaim {
  append?: string;
  render: (input: { sessionID?: string }) => unknown;
}

export interface VoiceSlotApi {
  ui: {
    slot?: (claim: VoiceSlotClaim) => () => void;
  };
  lifecycle: {
    onDispose(cleanup: () => void | Promise<void>): void;
  };
}

export type SessionTitleOf = (sessionID: string) => string | undefined;

function originLabel(
  origin: { route: string; sessionID?: string },
  titleOf?: SessionTitleOf,
): string {
  if (origin.route !== "session" || !origin.sessionID) return "home";
  if (titleOf) {
    try {
      const title = titleOf(origin.sessionID);
      if (title && title.trim() !== "") return `“${title.trim().slice(0, 28)}”`;
    } catch {
      /* fall through to short id */
    }
  }
  return `session ${origin.sessionID.slice(0, 8)}`;
}

function recordingSecs(activeJob: NonNullable<ManagerSnapshot["activeJob"]>): number {
  return Math.max(0, Math.floor((Date.now() - activeJob.createdAt) / 1000));
}

/**
 * One-line footer status, aware of which tab owns the recording.
 * `viewSessionID` is the tab the line renders in (undefined = unknown).
 * Undefined return = render nothing (idle).
 */
export function statusLine(
  snap: ManagerSnapshot | undefined,
  viewSessionID?: string,
  titleOf?: SessionTitleOf,
): string | undefined {
  if (!snap) return undefined;
  if (snap.recording && snap.activeJob) {
    const secs = recordingSecs(snap.activeJob);
    const origin = snap.activeJob.origin;
    const mine =
      origin.route !== "session" ||
      !origin.sessionID ||
      !viewSessionID ||
      origin.sessionID === viewSessionID;
    if (mine) return `● REC ${secs}s · i/e copy · o send · esc cancel`;
    return `● REC ${secs}s · recording in ${originLabel(origin, titleOf)} — switch back to stop`;
  }
  if (snap.transcribing > 0 || snap.queued > 0) return "◌ transcribing…";
  if (snap.ready.length > 0) return "◇ transcript ready — /voice-insert to copy";
  return undefined;
}

/**
 * Home-screen line. Unlike session areas, home shows an idle hint so there
 * is always visible proof the UI layer is alive.
 */
export function homeLine(snap: ManagerSnapshot | undefined): string {
  return statusLine(snap) ?? "🎙 voice ready — v start · i copy · o send";
}

/**
 * Voice bar directly above the session composer — the closest v2.0.14 gets to
 * the field itself becoming voice UI (no slot exists for the prompt input).
 * Renders full controls on the recording tab, a pointer elsewhere.
 */
export function composerLine(
  snap: ManagerSnapshot | undefined,
  viewSessionID?: string,
  titleOf?: SessionTitleOf,
): string | undefined {
  if (!snap) return undefined;
  if (snap.recording && snap.activeJob) {
    const secs = recordingSecs(snap.activeJob);
    const origin = snap.activeJob.origin;
    const mine =
      origin.route !== "session" ||
      !origin.sessionID ||
      !viewSessionID ||
      origin.sessionID === viewSessionID;
    if (mine) {
      return `🎙 ● ${secs}s · speak now · <leader>i / <leader>e copy · <leader>o send · esc cancel`;
    }
    return `● Recording in ${originLabel(origin, titleOf)} — switch back to stop it`;
  }
  if (snap.transcribing > 0 || snap.queued > 0) {
    return "◌ Transcribing in background — keep working, delivery is automatic";
  }
  return undefined;
}

export function setupVoiceUI(
  api: VoiceSlotApi,
  getSnapshot: () => ManagerSnapshot | undefined,
  titleOf?: SessionTitleOf,
): number {
  const slot = api.ui.slot;
  if (typeof slot !== "function") return 0;
  const [snap, setSnap] = createSignal<ManagerSnapshot | undefined>(undefined);
  const timer = setInterval(() => {
    try {
      setSnap(getSnapshot());
    } catch {
      /* snapshot must never break the host */
    }
  }, 500);
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    (timer as unknown as { unref: () => void }).unref?.();
  }

  const Status = (props: { sessionID?: string }) => {
    const line = statusLine(snap(), props.sessionID, titleOf);
    if (!line) return null;
    return <text>{line}</text>;
  };
  const HomeStatus = () => {
    return <text>{homeLine(snap())}</text>;
  };
  const ComposerHint = (props: { sessionID?: string }) => {
    const line = composerLine(snap(), props.sessionID, titleOf);
    if (!line) return null;
    return <text>{line}</text>;
  };

  const disposers: Array<() => void> = [];
  try {
    disposers.push(
      slot({
        append: "prompt.footer.status",
        render: (input) => <Status sessionID={input?.sessionID} />,
      }),
    );
  } catch {
    /* a rejected claim must never break the plugin */
  }
  try {
    disposers.push(slot({ append: "home.footer.status", render: () => <HomeStatus /> }));
  } catch {
    /* a rejected claim must never break the plugin */
  }
  try {
    disposers.push(
      slot({
        append: "session.composer.top",
        render: (input) => <ComposerHint sessionID={input?.sessionID} />,
      }),
    );
  } catch {
    /* a rejected claim must never break the plugin */
  }
  api.lifecycle.onDispose(() => {
    try {
      clearInterval(timer);
    } catch {
      /* ignore */
    }
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* ignore */
      }
    }
  });
  return disposers.length;
}
