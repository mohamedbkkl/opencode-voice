# OpenCode Voice — Session & Delivery Rules (100% checklist)

These rules are load-bearing. Every change to recording, routing, or insertion
must satisfy all of them. Regression tests in `test/jobs.test.ts`
(`tab isolation rules R1-R4`) enforce the core subset.

## Isolation (never leak across sessions)

- **R1 — Session→different-session is forbidden.** A job recorded in session A
  must never auto-insert, manual-insert, or auto-submit into session B.
  `canInsertInto()` returns false; `markInserted()` throws `session_mismatch`;
  transcript stays parked with status `ready`.
- **R2 — Floating `home` jobs are the only exception.** A job recorded on the
  home / `+ New session` screen (no session ID) may be delivered into a later
  session of the **same instance AND same directory**. Cross-directory and
  cross-instance floating delivery is rejected.
- **R3 — Exact match wins.** When both an exact-origin and a floating home
  transcript are ready, `findInsertable()` returns the exact one first.
- **R4 — Completion requires ownership.** `markInserted()` succeeds only via
  `canInsertInto()`. Session-origin jobs complete only into their own session;
  home-origin jobs complete into a same-directory session (origin migrates).
- **R5 — TUI-local routing only.** Origin resolution uses `router.current` →
  `ui.tabs` active tab. **Never** scan global session lists
  (`data.session.list`, `client.session.list`) to pick a target — those include
  web/agent conversations and voice would leak into the wrong chat (observed
  bug). Global lists may only inherit model/agent for a fresh session, never
  select the delivery target.
- **R6 — Delivery targets the recording session.** V2 `session.prompt` uses
  `job.origin.sessionID` for session-origin jobs, never the currently focused
  tab. Home jobs resolve via `ensureSessionID()` (origin → active tab →
  create). Never rewrite a session origin to another session.

## Single delivery (never duplicate)

- **R7 — Single-flight.** `inserting: Set<jobID>` guards `insertJob()`;
  settle is serialized through a promise chain (`requestSettle`) and all
  composer paste+submit round-trips through one more (`createSerializer`),
  so concurrent callers can never interleave two transcripts into one
  submit. Two concurrent settles (ready-transition emit + audio-cleanup
  emit) produce exactly one `session.prompt` call.
- **R7b — Current content only.** A stray `o` press with no live recording
  never delivers an older parked transcript (status toast instead; explicit
  delivery stays on `/voice-insert`). Settle submits send jobs oldest-first
  and skips any send job while a newer job is still recording/transcribing
  (`hasNewerActiveJob`) — an action waits for its own transcription and
  delivers current content into the recording session.
- **R8 — One layer registration.** `tui-v2.ts` installs keymap layers once
  (`layersInstalled` guard). Re-renders must not duplicate commands/bindings.
  Global + project-local entries can coincide in one process: each entry
  claims a process-wide slot (`claimProcessSlot`, `Symbol.for`) and the
  second copy stands down, so tools/keys register exactly once
  (`test/singleton.test.ts`).

## Insert vs send

- **R9 — paste at cursor, never clear, then optionally send.** Both options
  first paste the recorded text at the user's cursor in the focused composer
  field and must never remove or clear existing content:
  - `i`/`e` = paste only. The user reviews and sends manually.
  - `o` = paste, then send **all** field content (existing + pasted) via the
    composer submit, so the run uses the footer-selected model.
  - Only the guaranteed fallback (`session.prompt` direct) sends the
    transcript alone — used solely when the composer path is unavailable.

- Mechanism notes: V1 uses true draft (`appendPrompt`, optional
  `submitPrompt`). On V2 there is no staging API at all: `session.prompt`
  always submits, and the only draft path (`tui.prompt.append` event) is
  subscribe-only for plugins — so a plugin can never write the composer's
  input field directly. Therefore `insert` (`<leader>i`, alias `<leader>e`) copies the transcript to the **system
  clipboard** and then pastes it into the focused composer via the built-in
  `prompt.paste` command dispatch (verified in the v2.0.14 tree: null-safe
  handler, reads the system clipboard, inserts at the cursor — in-process,
  no focus or permission needed, works while the user is in another app).
  Fallbacks in order: macOS synthetic `⌘V` (`autoPaste`, frontmost-app
  guard, needs Accessibility on the terminal), then
  `Transcript copied — paste with ⌘V / Ctrl+V`. `pasteMethod`
  (`auto`/`dispatch`/`keystroke`, env `OPENCODE_VOICE_PASTE_METHOD`) forces
  one path. The text lands exactly where the user's focus already is: no
  window, no submit, and no session targeting involved, so this path cannot
  leak into another session (or chat) by construction. It works from the
  home screen too. Guards: the frontmost-app check (keystroke path only;
  extend via `autoPasteApps`) — otherwise it degrades to the copied toast.
  `insert-and-send` (`<leader>o`) refreshes the clipboard with the current
  transcript first (the host paste reads the system clipboard — skipping
  this pasted the *previous* recording), then pastes and submits **through
  the composer** (footer-selected model/agent, text visible first), verified
  by matching user message; on any doubt it falls back to direct
  `session.prompt` to the recording session (never lost). Auto-settle copies `i` jobs and submits `o`
  jobs (single-flight); anything for another session stays parked.
- True paste-to-composer stays impossible until upstream ships a plugin
  insert API (session-scoped prompt events closed as not planned).

## Chat-model routing (R11)

- V2 `session.prompt` takes no model override, so a submit runs with the
  session's **stored** model. A fresh `+ New session` screen stores the server
  default even when the footer shows your pick (footer state is TUI-local
  until first submit) — that mismatch sent transcripts as GPT-6.
- `chatModel` plugin option / `OPENCODE_VOICE_CHAT_MODEL` env
  (`{providerID,id}` or `"providerID/id"`) aligns **only message-less
  sessions** via `switchModel` before prompting (`decideModelAlignment`,
  tested in `test/submit-model.test.ts`). Used sessions keep their stored
  model; unknown cache states are left untouched. The review dialog and all
  success toasts name the model that will run / ran.

## Mic lifecycle (R12)

- Exactly one recorder child per recording. `recordingJob()` covers the
  startup window too, so double-start coalesces instead of spawning twice.
- Stop/cancel during recorder startup rendezvous with the pending start and
  then stop/kill the live child — never report "nothing to stop" while the
  OS microphone is open (stuck mic indicator = privacy bug, tested in
  `test/mic-lifecycle.test.ts`). Unload drains a pending start first.

## Ambient UI (windowless)

- **R13 — Show state, never interrupt.** Footer status rows show
  `● REC 7s` while recording, `◌ transcribing…` while busy,
  `◇ transcript ready` while parked; the composer top line mirrors recording
  state. Session areas render nothing when idle; the home footer always shows
  a `🎙 voice ready` hint as proof of life, and `/voice-status` reports the
  installed slot count (`UI slots: N/3`) so a missing UI is diagnosable.
  Lines are per-tab: the recording tab shows full controls, other tabs show
  a pointer naming the origin tab (`recording in “X” — switch back to stop`).
  Implemented in `src/tui-ui.tsx` (Solid slots,
  500ms snapshot poll, best-effort — skipped on hosts without `ui.slot`).
  Helpers `statusLine`/`composerLine` are pure and tested in
  `test/tui-ui.test.ts`; slot claims must never throw and dispose cleanly.

## Speed budgets (time is the game changer)

- **R10 — Budgets:** recording start < 500ms typical (polling, no fixed
  700ms sleep); transcription adds zero subprocess beyond inference
  (WAV-header fast path skips `ffprobe`, ~10ms); init parallel
  (provider+recorder) with background model prewarm; diagnostics parallel
  (not 3× sequential); default `--threads` = cpus/2 capped at 8.
- Toasts: info/success 3s, errors 5s. Never block TUI startup on hardware or
  model probes.

## Keybinds

| Action | Default | Alias | Slash |
|---|---|---|---|
| Start recording | `<leader>v` | — | `/voice` |
| Stop → copy to clipboard | `<leader>i` | `<leader>e` | `/voice-stop`, `/voice-insert` |
| Stop → direct send | `<leader>o` | — | `/voice-send` |
| Cancel | `esc` (while recording) | — | `/voice-cancel` |

`<leader>` defaults to `ctrl+x`. `i` copies and auto-pastes where focus is
(no submit); `⌘V`/`Ctrl+V` remains the manual fallback. Single-letter speech
(`i`/`e`) is routinely misheard by Whisper — read before you send.

## Verification (run before every release)

```sh
npm run typecheck   # must pass
npm run build       # refresh dist/
npm test            # 107/107 (R1-R4, R7b, R8, R11-R13, clipboard, autopaste, submit, ui)
npm run diagnose    # Status: ready
```

Manual: record in tab B → switch to tab A (nothing appears) → back to B
(auto-inserts there); record on home → open session → `/voice-insert`
delivers; `i` opens dialog once, `o` submits once; voice never appears in a
web/agent chat.
