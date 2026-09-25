/**
 * System clipboard delivery for transcripts (TUI-only concern).
 *
 * Why this exists: on current OpenCode hosts no plugin API can stage text in
 * the composer's input field. The only draft path is the server-emitted
 * `tui.prompt.append` event and the plugin event API is subscribe-only, so a
 * plugin can never publish it. Copying to the system clipboard is therefore
 * the paste surface: the text lands exactly where the user's focus already
 * is (`Cmd+V` / `Ctrl+V`), with no window, no submit, and no session
 * targeting involved at all.
 */
import { VoiceError } from "./types.js";
import { runCommand, which } from "../utils/process.js";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface ClipboardCommand {
  executable: string;
  args: string[];
}

/**
 * Resolve the OS clipboard writer. Pure (injectable platform/env/finder) so
 * selection is unit-testable without touching the real clipboard.
 */
export function clipboardCommand(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  find: (names: string[], extraDirs?: string[]) => string | undefined = which,
): ClipboardCommand | undefined {
  if (platform === "darwin") {
    const pbcopy = find(["pbcopy"], ["/usr/bin"]);
    return pbcopy ? { executable: pbcopy, args: [] } : undefined;
  }
  if (platform === "win32") {
    const clip = find(["clip"]);
    return clip ? { executable: clip, args: [] } : undefined;
  }
  if (platform === "linux" || platform === "freebsd" || platform === "openbsd") {
    if (env["WAYLAND_DISPLAY"]) {
      const wlcopy = find(["wl-copy"]);
      if (wlcopy) return { executable: wlcopy, args: [] };
    }
    const xclip = find(["xclip"]);
    if (xclip) return { executable: xclip, args: ["-selection", "clipboard"] };
    const xsel = find(["xsel"]);
    if (xsel) return { executable: xsel, args: ["--clipboard", "--input"] };
    return undefined;
  }
  return undefined;
}

/** Copy text to the system clipboard. Throws VoiceError on failure. */
export async function copyText(
  text: string,
  options?: { timeoutMs?: number },
): Promise<void> {
  const cmd = clipboardCommand();
  if (!cmd) {
    throw unavailableError(await fallbackFile(text));
  }
  const result = await runCommand(cmd.executable, {
    args: cmd.args,
    stdin: text,
    timeoutMs: options?.timeoutMs ?? 8000,
  });
  if (result.timedOut || result.exitCode !== 0) {
    throw new VoiceError(
      "insertion_failed",
      "Could not copy the transcript to the clipboard.",
      await failureHint(text),
    );
  }
}

/**
 * Headless-session note (SSH without display forwarding has no clipboard
 * to attach to, even when the clipboard tool is installed).
 */
function headlessNote(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (platform === "linux" && !env["DISPLAY"] && !env["WAYLAND_DISPLAY"]) {
    return "No display detected (headless SSH?). Run OpenCode in a local graphical session, or use SSH with display forwarding.";
  }
  return undefined;
}

function unavailableError(savedTo: string | undefined): VoiceError {
  const parts: string[] = [];
  if (process.platform === "linux") {
    parts.push("Install wl-copy (Wayland) or xclip (X11) and retry — the transcript is kept.");
    const headless = headlessNote();
    if (headless) parts.push(headless);
  } else {
    parts.push("The transcript is kept — use /voice-insert to retry.");
  }
  if (savedTo) parts.push(`Transcript saved to ${savedTo}.`);
  return new VoiceError("insertion_failed", "System clipboard is unavailable.", parts.join(" "));
}

async function failureHint(text: string): Promise<string> {
  const parts = ["The transcript is kept — use /voice-insert to retry."];
  if (process.platform === "linux") {
    const headless = headlessNote();
    if (headless) parts.push(headless);
  }
  const savedTo = await fallbackFile(text);
  if (savedTo) parts.push(`Transcript saved to ${savedTo}.`);
  return parts.join(" ");
}

/**
 * Persist the transcript to a temp file so it is never trapped in memory
 * when the clipboard is unavailable (headless SSH, missing clipboard
 * tools). Returns the path, or undefined when the write itself fails.
 * Works on macOS, Linux, and Windows via `os.tmpdir()`.
 */
export async function writeTranscriptFallback(text: string): Promise<string> {
  const dir = path.join(os.tmpdir(), "opencode-voice");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `transcript-${Date.now()}.txt`);
  await fs.writeFile(file, text, "utf8");
  return file;
}

async function fallbackFile(text: string): Promise<string | undefined> {
  try {
    return await writeTranscriptFallback(text);
  } catch {
    return undefined;
  }
}
