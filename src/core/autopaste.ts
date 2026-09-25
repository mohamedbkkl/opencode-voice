/**
 * Automatic paste into the focused composer (TUI-only concern).
 *
 * Why this exists: no plugin API can write the composer's input field (the
 * only draft path is the server-emitted `tui.prompt.append` event and the
 * plugin event API is subscribe-only). So after the transcript is on the
 * system clipboard, macOS synthesizes the `⌘V` the user would have pressed:
 * `System Events → keystroke "v" using command down`. The OS delivers it to
 * whatever holds focus — normally the OpenCode composer.
 *
 * Privacy guards:
 * - Requires the Accessibility permission on the terminal app (e.g. iTerm);
 *   without it the keystroke is silently dropped and we fall back to toast.
 * - The frontmost app is checked first and must look like a terminal/editor;
 *   otherwise nothing is typed anywhere and the clipboard + toast remain.
 */
import { runCommand } from "../utils/process.js";

export interface ShellResult {
  exitCode: number | null;
  stdout: string;
  timedOut: boolean;
}

export type ShellRunner = (
  executable: string,
  args: string[],
  timeoutMs: number,
) => Promise<ShellResult>;

/** Frontmost apps we are willing to type into (plus user-extended names). */
export const PASTE_SAFE_APPS: readonly string[] = [
  "iTerm2",
  "iTerm",
  "Terminal",
  "WezTerm",
  "Alacritty",
  "kitty",
  "Hyper",
  "Warp",
  "Ghostty",
  "Code",
  "Cursor",
  "Windsurf",
  "Zed",
  "Sublime Text",
  "OpenCode",
  "Tabby",
];

export function frontmostAppCommand(): { executable: string; args: string[] } {
  return {
    executable: "osascript",
    args: [
      "-e",
      'tell application "System Events" to get name of first application process whose frontmost is true',
    ],
  };
}

export function pasteKeystrokeCommand(): { executable: string; args: string[] } {
  return {
    executable: "osascript",
    args: ["-e", 'tell application "System Events" to keystroke "v" using command down'],
  };
}

/** How the transcript reaches the composer field. */
export type PasteMethod = "auto" | "dispatch" | "keystroke";

/** Parse the `pasteMethod` plugin option. Unknown values fall back to auto. */
export function parsePasteMethod(raw: unknown): PasteMethod {
  if (typeof raw === "string") {
    const v = raw.trim().toLowerCase();
    if (v === "dispatch" || v === "keystroke" || v === "auto") return v;
  }
  return "auto";
}

/** True when auto-paste may type into `appName`. Case-insensitive. */
export function isPasteTarget(
  appName: string,
  extraApps: readonly string[] = [],
): boolean {
  const name = appName.trim().toLowerCase();
  if (name === "") return false;
  for (const candidate of [...PASTE_SAFE_APPS, ...extraApps]) {
    if (candidate.trim().toLowerCase() === name) return true;
  }
  return false;
}

export type AutoPasteOutcome =
  | { pasted: true; app: string }
  | { pasted: false; reason: "unsupported-platform" | "not-focused" | "failed" };

/**
 * Fire `⌘V` into the focused app after the transcript was copied.
 * Never throws: failures degrade to `{ pasted: false }` and the caller
 * falls back to the "press ⌘V" toast (clipboard still holds the text).
 */
export async function autoPaste(
  runner: ShellRunner = defaultRunner,
  options?: { platform?: NodeJS.Platform; extraApps?: readonly string[] },
): Promise<AutoPasteOutcome> {
  const platform = options?.platform ?? process.platform;
  if (platform !== "darwin") return { pasted: false, reason: "unsupported-platform" };
  try {
    const front = frontmostAppCommand();
    const who = await runner(front.executable, front.args, 5000);
    if (who.timedOut || who.exitCode !== 0) return { pasted: false, reason: "failed" };
    const app = who.stdout.trim();
    if (!isPasteTarget(app, options?.extraApps)) {
      return { pasted: false, reason: "not-focused" };
    }
    const paste = pasteKeystrokeCommand();
    const done = await runner(paste.executable, paste.args, 5000);
    if (done.timedOut || done.exitCode !== 0) return { pasted: false, reason: "failed" };
    return { pasted: true, app };
  } catch {
    return { pasted: false, reason: "failed" };
  }
}

async function defaultRunner(
  executable: string,
  args: string[],
  timeoutMs: number,
): Promise<ShellResult> {
  const result = await runCommand(executable, { args, timeoutMs });
  return { exitCode: result.exitCode, stdout: result.stdout, timedOut: result.timedOut };
}
