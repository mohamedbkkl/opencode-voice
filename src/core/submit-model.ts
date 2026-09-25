/**
 * Chat-model routing for voice submits (TUI-only concern).
 *
 * Background: on OpenCode V2 `session.prompt` accepts no model override
 * (see `SessionPromptInput` in `@opencode/client`), so a submit always runs
 * with the session's *stored* model. A fresh `+ New session` screen stores the
 * server default (e.g. GPT-6) even when the composer footer shows the user's
 * pick (e.g. Muse Spark) — that pick is TUI-local state until first submit.
 * Hence voice must align a fresh session via `session.switchModel` before
 * prompting. Sessions the user already chatted in are never touched.
 *
 * This module is pure (no OpenCode imports) so the rules are unit-testable.
 */

/** Chat model reference: `{ providerID, id }` or `"providerID/modelID"`. */
export interface ChatModel {
  providerID: string;
  id: string;
}

/** Stored session model shape (subset of `SessionInfo["model"]`). */
export interface StoredModel {
  providerID?: string;
  id?: string;
}

/**
 * Parse a `chatModel` plugin option. Accepts
 * `{ providerID: "openai", id: "gpt-5.6-luna-fast" }` or
 * `"openai/gpt-5.6-luna-fast"` (split on the first `/`).
 */
export function parseChatModelOption(raw: unknown): ChatModel | undefined {
  if (typeof raw === "string") return parseChatModelString(raw);
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    const providerID = o["providerID"] ?? o["provider"];
    const id = o["id"] ?? o["model"] ?? o["modelID"];
    if (typeof providerID === "string" && typeof id === "string") {
      const parsed = { providerID: providerID.trim(), id: id.trim() };
      if (parsed.providerID !== "" && parsed.id !== "") return parsed;
    }
  }
  return undefined;
}

/** Parse `OPENCODE_VOICE_CHAT_MODEL` (`"providerID/modelID"`). */
export function parseChatModelString(value: unknown): ChatModel | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash >= trimmed.length - 1) return undefined;
  const providerID = trimmed.slice(0, slash).trim();
  const id = trimmed.slice(slash + 1).trim();
  if (providerID === "" || id === "") return undefined;
  return { providerID, id };
}

export function sameModel(
  a: StoredModel | ChatModel | undefined,
  b: StoredModel | ChatModel | undefined,
): boolean {
  if (!a || !b) return false;
  const aProvider = "providerID" in a ? a.providerID : undefined;
  const bProvider = "providerID" in b ? b.providerID : undefined;
  return aProvider === bProvider && a.id === b.id;
}

/**
 * Serialize async operations (e.g. composer paste+submit) so concurrent
 * callers — auto-settle and an explicit keypress — can never interleave and
 * mix two transcripts into one submit.
 */
export function createSerializer(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<void> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

/**
 * Best-effort check that a submitted transcript landed as a user message.
 * Messages are treated opaquely (serialized) because message shapes differ
 * across host versions; matching on a distinctive slice avoids false hits
 * from short/empty transcripts (caller should pass 40+ chars).
 */
export function messageContainsText(messages: unknown, needle: string): boolean {
  if (!Array.isArray(messages) || needle.trim() === "") return false;
  const slice = needle.trim().slice(0, 80);
  return messages.some((m) => {
    try {
      return JSON.stringify(m).includes(slice);
    } catch {
      return false;
    }
  });
}

/** Short label for toasts/dialogs, e.g. `openai/gpt-5.6-luna-fast`. */
export function modelLabel(model: StoredModel | ChatModel | undefined): string {
  const provider = model && "providerID" in model ? model.providerID : undefined;
  if (provider && model?.id) return `${provider}/${model.id}`;
  if (model?.id) return model.id;
  return "session default";
}

export interface AlignmentInput {
  /** Session's stored model (`data.session.get(id)?.model`). */
  stored: StoredModel | undefined;
  /** Cached message count (`data.session.message.list(id)?.length`). */
  messageCount: number | undefined;
  /** User-configured chat model (plugin option / env). */
  configured: ChatModel | undefined;
}

/**
 * Decide whether to `switchModel` before prompting.
 *
 * - No configured model → never (zero behavior change).
 * - Session already used (messages > 0) → never (trust stored model).
 * - Fresh session (zero messages) with different/missing stored model → switch.
 * - Unknown message state with a differing stored model → never (safe: the
 *   cache may simply be unsynced; switching could override the user's pick).
 * - Unknown message state with no stored model → switch (nothing to break).
 */
export function decideModelAlignment(input: AlignmentInput): { switch: boolean } {
  const { stored, messageCount, configured } = input;
  if (!configured) return { switch: false };
  if (sameModel(stored, configured)) return { switch: false };
  if ((messageCount ?? 0) > 0) return { switch: false };
  if (!stored) return { switch: true };
  if (messageCount === 0) return { switch: true };
  return { switch: false };
}
