# OpenCode Voice

![CI](https://github.com/mohamedbkkl/opencode-voice/actions/workflows/ci.yml/badge.svg)

Local voice-to-text for [OpenCode](https://opencode.ai). Record from the TUI,
transcribe **locally** with transcribe.cpp (GGUF + Metal), and insert the
transcript into the correct composer — never into the wrong session.

First run: `npx opencode-voice setup`.

[![Support on Ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/mohamedbakklitahiri)

- No cloud APIs, no accounts, no telemetry. Microphone → local file → local
  `transcribe-cli` → your prompt.
- Preferred engine is **transcribe.cpp** (`transcribe-cli`) running GGUF
  models with Apple Silicon Metal acceleration; the classic **whisper.cpp**
  (`whisper-cli`, `ggml-*.bin`) remains as an automatic fallback.
- Session/instance isolation: a transcript recorded in window A can never leak
  into window B. If you switch sessions mid-transcription, the transcript parks
  safely and waits for you to return.
- Provider-agnostic core: recording, jobs and UI depend only on the
  `SpeechProvider` interface. MLX Whisper, faster-whisper, local HTTP servers
  or a custom CLI can be added later without rewriting the app.

> **v0.2.0 (polished):** end-to-end pipeline —
> `start → stop → transcribe → copy + auto-paste`, direct send with model
> routing, cancel, queueing, tab isolation, mic-lifecycle guard, diagnostics
> and agent tools. See [Known limitations](#known-limitations).

---

## Contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
  - [For development (this repo)](#for-development-this-repo)
  - [First-run setup wizard](#first-run-setup-wizard)
  - [In OpenCode (server plugin)](#in-opencode-server-plugin)
  - [In OpenCode (TUI plugin)](#in-opencode-tui-plugin)
- [Usage](#usage)
- [Configuration](#configuration)
- [How provider detection works](#how-provider-detection-works)
- [How to select a model](#how-to-select-a-model)
- [Architecture](#architecture)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Known limitations](#known-limitations)
- [Troubleshooting](#troubleshooting)
- [Development commands](#development-commands)

---

## Prerequisites

| Requirement | Notes |
|---|---|
| OpenCode V1 ≥ 1.18.29, or OpenCode V2 ≥ 2.0.14 | `opencode --version` |
| Node.js ≥ 20 (22 recommended) | plugin host runtime |
| **ffmpeg** (for recording + audio normalization) | macOS: `brew install ffmpeg` · Ubuntu/Debian: `sudo apt-get install ffmpeg` · Windows: `choco install ffmpeg` |
| **transcribe-cli** (preferred transcription engine) | build from https://github.com/handy-computer/transcribe.cpp (see below); Metal is automatic on Apple Silicon arm64 builds |
| **whisper.cpp** executable (optional fallback only) | macOS: `brew install whisper-cpp` (provides `whisper-cli`) |
| A local model: Handy `whisper-large-v3-turbo` GGUF (preferred) or a `ggml-*.bin` (fallback) | auto-discovered when present; the setup wizard can optionally download one with approval — see [models](#how-to-select-a-model) |
| A microphone + terminal mic permission | macOS: System Settings → Privacy & Security → Microphone |

### Building transcribe-cli

The bundled build helper targets macOS / Apple Silicon: it uses the official
repository, builds arm64 + Metal, and installs to `~/.local/bin`:

```sh
npm run build:transcribe-cpp
```

Equivalent manual steps:

```sh
git clone https://github.com/handy-computer/transcribe.cpp
cd transcribe.cpp
cmake -B build -DCMAKE_BUILD_TYPE=Release -DTRANSCRIBE_METAL=ON
cmake --build build --target transcribe-cli --config Release
# optional: install to PATH
cmake --install build   # or: export OPENCODE_VOICE_TRANSCRIBE_BIN=$PWD/build/bin/transcribe-cli
```

Notes:

- Metal is enabled automatically on Apple Silicon **arm64** builds. If your
  `cmake` is an x86_64 binary running under Rosetta, drive the build natively:
  configure normally, then run the compile step with `arch -arm64` make, e.g.
  `cd build && arch -arm64 /usr/bin/make transcribe-cli`.
- Verify acceleration: `transcribe-cli --list-devices` should show a `metal`
  device alongside `cpu`.

Primary platform for Milestone 1 is **macOS / Apple Silicon**. Linux recording
uses ALSA via ffmpeg; Windows uses dshow (basic). Build + tests run on all
three OSes in CI; real-microphone recording is verified on macOS, while Linux
and Windows still need a real-device check. Platform specifics live
behind the `AudioRecorder` interface (`src/recorder/`).

### Reusing models from other voice tools

OpenCode Voice does not download a second copy of a speech model. It can reuse
any existing model file that is compatible with the selected local runtime:

- Handy Whisper **GGUF** models are discovered automatically.
- Whisper.cpp **GGML `.bin`** models can be discovered or selected directly.
- Any other compatible file can be used with `modelPath` or
  `OPENCODE_VOICE_MODEL_PATH`.

For example:

```jsonc
{
  "provider": "transcribe.cpp",
  "modelPath": "/path/to/existing/whisper-model.gguf"
}
```

Superwhisper's Whisper models can be reused when the actual file is in a
GGUF/Whisper.cpp-compatible format. Superwhisper models based on MLX or
WhisperKit/Parakeet use different runtimes and cannot be opened by the
current providers. The Superwhisper app itself is not required or invoked.

The model and the runtime are separate: having a model file is not enough if
the matching `transcribe-cli` or `whisper-cli` executable is missing. Run
`npx opencode-voice setup --check` (or `/voice-diagnose` inside OpenCode) for
the exact missing dependency and an install/build hint. The core providers
never download anything on their own; only the setup wizard downloads a model,
and only after you confirm. Startup remains safe and predictable.

---

## Installation

### For development (this repo)

```sh
git clone https://github.com/mohamedbkkl/opencode-voice.git opencode-voice
cd opencode-voice
npm install
npm run typecheck
npm test        # compiles to dist-test/ + unit/integration tests (node:test, no extra deps)
npm run build
```

### First-run setup wizard

After installing the plugin and building (`npm run build`), run:

```sh
npx opencode-voice setup
```

The wizard checks `ffmpeg`, transcription runtimes, compatible local models,
and microphones. It explains missing dependencies and asks before running a
supported installer or downloading a model. It writes only the selected voice
provider to the global voice config; it never changes project OpenCode config
silently.

Useful modes:

```sh
npx opencode-voice setup --check        # detect only; exit 2 when not ready
npx opencode-voice setup --check --json # machine-readable status
npx opencode-voice setup --yes          # accept supported installs non-interactively
```

Inside OpenCode, `/voice-setup` checks readiness and points to the terminal
wizard when installation is needed.

Check your machine without starting OpenCode:

```sh
npm run diagnose
# OpenCode Voice
#
# ✓ Provider: transcribe.cpp (local, Metal): executable found
# ✓ Model: whisper-large-v3-turbo-Q8_0 (/path/to/model.gguf)
# ✓ Microphone: recorder available (2 inputs: …)
#
# Status: ready
```

### In OpenCode (recommended: global install)

Project-local `.opencode/plugins/` entries load only inside that project.
For voice everywhere, register once globally (server + TUI are separate
entries; registering twice in one process is safe — the second copy stands
down). Shared voice settings live in `~/.config/opencode/opencode-voice.json`
(`device`, `chatModel`, …) so they apply in every folder.

Server entry (`~/.config/opencode/opencode.json`):

```jsonc
{
  "plugins": [
    "file:///path/to/opencode-voice/dist/server.js"
  ]
}
```

TUI entry (`~/.config/opencode/cli.json`):

```jsonc
{
  "plugins": ["file:///path/to/opencode-voice/dist/tui-v2.js"]
}
```

Restart OpenCode. The `Voice: …` commands appear in the palette
(`ctrl+p`), as slash commands (`/voice`, …), and on the keybindings below —
in every project, not just this repo.

### Project-local install (this repo only)

Drop thin re-export shims in `.opencode/plugins/opencode-voice/` (V2
auto-loads that directory for the current project only):

```ts
// .opencode/plugins/opencode-voice/index.ts
export { default } from "../../../dist/server.js";
// .opencode/plugins/opencode-voice/tui.ts
export { default } from "../../../dist/tui-v2.js";
```

Per-entry options (`tui.json`/`tui.jsonc` style) also work:

```jsonc
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    ["file:///path/to/opencode-voice/dist/tui-v2.js", { "device": "auto" }]
  ]
}
```

Restart OpenCode. The `Voice: …` commands appear in the palette
(`ctrl+p`), as slash commands (`/voice`, …), and on the keybindings below.

> The server entry is the officially supported dual V1/V2 shape: one module
> exports both `server()` (V1) and `setup()` (V2). The TUI remains a separate
> target entry: `./tui` resolves to the V2 `@opencode/plugin/tui` adapter;
> `./server` and the package root resolve to the dual server entry.

### Compatibility architecture

The recording, `VoiceJob` queue, provider selection, model discovery,
configuration, and transcript lifecycle are OpenCode-independent. V1 and V2
only differ at the boundary:

- V1 uses `server()` and the V1 TUI adapter (`@opencode-ai/plugin/tui`).
- V2 uses `setup()` and the current `@opencode/plugin/tui` keymap layer
  (`id`, `slash`, `bind`, and command IDs in `bindings`).

The V2 adapter does not emulate the old TUI API for registration. It renders a
real V2 keymap layer so slash completion and leader sequences are owned by the
plugin rather than inserted into the composer.

## Compatibility matrix

The supported version floors are:

| OpenCode branch | Compatibility floor | Repository baseline |
|---|---:|---:|
| V1 | `1.18.29` | `@opencode-ai/plugin` `1.18.32` |
| V2 | `2.0.14` | `@opencode/plugin` `2.0.14` |

V1 `1.18.29` is the oldest declared V1 compatibility floor. V2 `2.0.14` is
the practical floor because the V2 TUI adapter uses the built-in
`prompt.paste` behavior verified against that release. Later V2 `2.x` releases
are intended to work while the plugin API remains compatible; no fixed maximum
within the `2.x` line is promised. OpenCode V3 is not currently supported.

| Feature | V1 ≥1.18.29 | V2 ≥2.0.14 |
|---|---|---|
| Server plugin | YES | YES |
| transcribe.cpp / whisper.cpp | YES | YES |
| VoiceJob queue | YES | YES |
| Session ownership | YES | YES |
| Native slash commands | LIMITED — verify per V1 patch | YES (V2 keymap layer) |
| Native keybindings | LIMITED — verify per V1 patch | YES (V2 keymap layer) |
| Composer insertion | V1 API adapter | Host/API-dependent; verify in target V2 |
| ChatGPT-style TUI | NO | YES |

The package is built against V1 `1.18.32` and V2 `2.0.14`. V1 `1.18.29`, V1
`1.18.32`, and later V2 `2.x` releases should be validated with a real
OpenCode process before treating compatibility as certified. The V1 and V2
plugin APIs are intentionally kept in separate adapters, because OpenCode V2
does not run V1 plugin implementations directly.

---

## Usage

1. Focus the session you want to dictate into.
2. Press `<leader>v` (default leader is `ctrl+x`, then `v`) or run `/voice`.
3. Speak.
4. Press `<leader>i` (or `/voice-stop`) to stop → transcribe → text **appears
   in the focused composer by itself** (integrated paste). Then edit and
   submit yourself. If the host can't paste, you'll get
   `Transcript copied` — paste manually with `⌘V` / `Ctrl+V`.
   Or press `<leader>o` (or `/voice-send`) to paste and **submit through the
   composer** (runs with your footer-selected model), with guaranteed direct
   delivery as fallback.
5. Press `esc` while recording (or `/voice-cancel`) to cancel — nothing is
   copied and the audio is deleted.

While one transcription runs you can keep working, switch sessions, or start
another recording; extra transcriptions queue (default: one at a time, since
large Whisper models use substantial RAM).

If you switched sessions before transcription finished, a send job stays
parked: switch back and it submits automatically, or run **Voice: copy ready
transcript** (`/voice-insert`) to copy it. Copy jobs never target a session,
so they cannot leak anywhere. macOS uses `pbcopy` (built-in); Linux needs
`wl-copy` (Wayland) or `xclip` (X11).

---

## Configuration

All settings are optional — defaults work out of the box. Precedence:

1. Plugin options (the object next to the plugin path in `tui.json`)
2. Environment variables (`OPENCODE_VOICE_*`)
3. `opencode-voice.json` (`.opencode/` in cwd → global OpenCode config dir →
   `~/.opencode-voice.json`, or `OPENCODE_VOICE_CONFIG=<path>`)
4. Built-in defaults

```jsonc
// tui.json plugin options (all optional)
["file:///path/to/opencode-voice/dist/tui.js", {
  "provider": "transcribe.cpp", // "transcribe.cpp" (default, Metal GGUF) |
                                // "whisper.cpp" (explicit fallback, no auto-fallback) |
                                // "auto" (first available of the two)
  "model": "auto",            // model id, ggml/gguf filename, or absolute path
  "modelPath": null,          // explicit model file (overrides "model")
  "executablePath": null,     // explicit provider executable
  "modelSearchDirs": [],      // extra dirs scanned for models
  "language": "auto",         // or "en", "de", …
  "device": "auto",           // mic: "auto" or e.g. ":1" / "MacBook Air Microphone"
  "maxConcurrentTranscriptions": 1,
  "keepAudio": false,         // keep WAVs after transcription (debug)
  "threads": null,            // inference threads (default: engine default)
  "transcriptionTimeoutMs": 600000,
  "debug": false,
  "chatModel": null,        // chat model for fresh sessions, e.g.
                            // {"providerID":"openai","id":"muse-spark"} or
                            // "openai/muse-spark". Sessions you already
                            // chatted in keep their stored model; only
                            // message-less sessions are aligned (R11).
  "autoPaste": true,        // i/e: paste into the focused field.
                            // dispatch (built-in paste command) first, then
                            // macOS synthetic ⌘V (needs Accessibility on the
                            // terminal), then clipboard + toast. false =
                            // clipboard + toast only.
  "pasteMethod": "auto",    // "auto" | "dispatch" | "keystroke" (force a path)
  "autoPasteApps": [],      // extra frontmost-app names allowed to receive
                            // the synthetic ⌘V (iTerm2, Terminal, Code… built in)
  "keybinds": {               // string to rebind, false to disable
    "start": "<leader>v",
    "stopInsert": "<leader>i",  // <leader>e is a built-in alias
    "stopSend": "<leader>o",
    "cancel": false           // esc while recording always works
  }
}]
```

Environment equivalents: `OPENCODE_VOICE_PROVIDER`,
`OPENCODE_VOICE_MODEL`, `OPENCODE_VOICE_MODEL_PATH`,
`OPENCODE_VOICE_TRANSCRIBE_BIN` (transcribe.cpp binary),
`OPENCODE_VOICE_WHISPER_BIN` (or `OPENCODE_VOICE_EXECUTABLE_PATH`, whisper
binary), `OPENCODE_VOICE_MODEL_DIRS` (comma-separated),
`OPENCODE_VOICE_LANGUAGE`, `OPENCODE_VOICE_DEVICE`,
`OPENCODE_VOICE_MAX_CONCURRENT`, `OPENCODE_VOICE_KEEP_AUDIO`,
`OPENCODE_VOICE_DEBUG`, `OPENCODE_VOICE_THREADS`,
`OPENCODE_VOICE_TIMEOUT_MS`, `OPENCODE_VOICE_EXTRA_ARGS`,
`OPENCODE_VOICE_CHAT_MODEL` (`"providerID/modelID"`, same as `chatModel`),
`OPENCODE_VOICE_AUTO_PASTE` (`1`/`0`, same as `autoPaste`),
`OPENCODE_VOICE_PASTE_METHOD` (`auto`/`dispatch`/`keystroke`).

Explicit binary/model paths are scoped to their provider: a whisper path is
never handed to transcribe.cpp and vice versa. With `provider: "auto"`, use
the per-provider env vars above for explicit binaries.

---

## How provider detection works

On first voice use (never at startup — detection is lazy so OpenCode startup
stays fast), providers are probed in order:

1. **transcribe.cpp** (default): explicit `executablePath` /
   `OPENCODE_VOICE_TRANSCRIBE_BIN` → `transcribe-cli`, `transcribe` on `PATH`
   (plus `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin` on macOS).
2. **whisper.cpp** (automatic fallback when transcribe.cpp is unavailable,
   unless explicitly configured): explicit path / `OPENCODE_VOICE_WHISPER_BIN`
   → `whisper-cli`, `whisper-cpp`, `whisper`, `main` on `PATH`.
   `provider: "whisper.cpp"` pins it with no fallback; `provider: "auto"`
   picks the first available.

**Model discovery (transcribe.cpp):** explicit `modelPath` /
`OPENCODE_VOICE_MODEL_PATH` → configured `modelSearchDirs` → built-in
locations: the Hugging Face hub cache
(`~/.cache/huggingface/hub/models--handy-computer--*/snapshots/*/*.gguf`),
the Handy macOS app dir
(`~/Library/Application Support/com.pais.handy/models/`). Only completed
`.gguf` files count — `.partial` downloads are ignored. Turbo Q8_0 is
preferred for `auto`.

**Model discovery (whisper.cpp fallback):** `ggml-*.bin` in
`~/.cache/whisper`, `~/.local/share/whisper`, `~/whisper.cpp/models`,
HF hub snapshots, etc., preferring `ggml-large-v3-turbo.bin`.

**Microphone:** ffmpeg presence + `ffmpeg -f avfoundation -list_devices`
(macOS) / `arecord -l` (Linux).

Nothing is ever downloaded. If anything is missing you get an actionable
error (e.g. install hints), and OpenCode itself always starts fine.

---

## How to select a model

- `model: "auto"` (default) picks the best discovered model: for
  transcribe.cpp the Handy Turbo GGUF wins
  (e.g. `whisper-large-v3-turbo-Q8_0.gguf`); for whisper.cpp,
  `ggml-large-v3-turbo.bin`.
- `modelPath` / `OPENCODE_VOICE_MODEL_PATH` points at one exact file —
  including a model downloaded by another local app (e.g. the Handy GGUF in
  `~/.cache/huggingface/hub`). This is how you reuse an existing model
  without downloading, copying, or renaming it.
- `modelSearchDirs` / `OPENCODE_VOICE_MODEL_DIRS` adds directories to the
  automatic scan. Use this when another tool stores a compatible model in a
  non-standard location.

### Choose a model explicitly

Add an absolute path to `.opencode/opencode-voice.json` in the project, or to
the shared `~/.config/opencode/opencode-voice.json`:

```json
{
  "provider": "transcribe.cpp",
  "modelPath": "/path/to/whisper-large-v3-turbo-Q8_0.gguf"
}
```

For a Whisper.cpp model, use the fallback provider and a `.bin` file:

```json
{
  "provider": "whisper.cpp",
  "modelPath": "/path/to/ggml-large-v3-turbo.bin"
}
```

The same setting can be used for one launch without editing a file:

```sh
OPENCODE_VOICE_MODEL_PATH="/absolute/path/to/model.gguf" opencode
```

Use an absolute path; `~` is not expanded inside JSON configuration. Restart
OpenCode after changing the configuration, then run `/voice-diagnose` to see
the provider and exact selected model path.

### Download a model

The plugin never downloads models automatically. Users can either let Handy or
another voice application install a compatible model, or download one directly
from the official model repository. For example, with the Hugging Face CLI:

```sh
python3 -m pip install -U huggingface_hub
mkdir -p ~/.cache/opencode-voice/models
hf download handy-computer/whisper-large-v3-turbo-gguf \
  --include '*.gguf' \
  --local-dir ~/.cache/opencode-voice/models
```

Then either leave `model` set to `auto` and add that directory to
`modelSearchDirs`, or set `modelPath` to the downloaded file. The model must
match the selected runtime: transcribe.cpp uses GGUF; whisper.cpp uses GGML
`.bin` files.
- Official GGUF source: <https://huggingface.co/handy-computer> (e.g.
  `whisper-large-v3-turbo-gguf`, Q8_0 ≈ 850 MB). The plugin finds Handy
  cache/app files automatically — no configuration needed when they exist.

---

## Architecture

```
src/
  server.ts                  dual V1 `server()` + V2 `setup()` entry
  tui.ts / tui-v2.ts         V1 and current V2 TUI adapters
  core/
    types.ts                VoiceJob, SpeechProvider-shaped types, VoiceError
    config.ts               defaults ← file ← env ← plugin options
    jobs.ts                 VoiceJobManager: state machine + queue + ownership
    diagnostics.ts          lazy probes, never throws, never blocks startup
    logger.ts               debug-gated, never logs transcripts/audio
  providers/
    provider.ts             SpeechProvider interface + registry
    index.ts                transcribe.cpp-first provider selection + fallback
    transcribe-cpp.ts       GGUF discovery, 16 kHz WAV normalization, CLI inference
    whisper-cpp.ts          executable/model discovery, CLI transcription
  recorder/
    recorder.ts             AudioRecorder interface
    ffmpeg.ts               ffmpeg AVFoundation/ALSA/dshow implementation
  utils/process.ts          spawn/which/temp-file/instance-id helpers
test/                       node:test suites (jobs, queue, config, parsing,
                            discovery, session ownership, plugin loading)
scripts/diagnose.ts         standalone `npm run diagnose` CLI
```

Key design points:

- **UI/job code never imports a concrete engine.** Everything goes through
  `SpeechProvider`; `transcribe.cpp` is selected first, with whisper.cpp as a
  fallback; `registerProvider()` adds new engines.
- **Session isolation** has two layers: the manager is per-process (one
  OpenCode window = one manager, keyed by `hostname:pid:startTime`), and every
  job records its origin route. Auto-insert only fires when the active route
  still matches; otherwise the transcript parks in `ready` with a manual
  `/voice-insert` escape hatch.
- **Concurrency:** `maxConcurrentTranscriptions` (default 1) bounds parallel
  transcriptions; recording is independent of the queue.
- **Composer insertion:** V1 uses the supported API
  (`client.tui.appendPrompt` / `submitPrompt`). On V2 there is no staging API
  (plugin events are subscribe-only), so `insert` copies to the system
  clipboard (`pbcopy` / `wl-copy` / `xclip` / `clip`) and the user pastes
  where focus is. `insert-and-send` submits via `session.prompt` to the
  recording session only, aligning fresh sessions to `chatModel` (R11).

---

## Keyboard shortcuts

Defaults (all rebindable via plugin options; `false` disables):

| Action | Default | Palette / slash |
|---|---|---|
| Start recording | `<leader>v` | Voice: start recording / `/voice` |
| Stop → transcribe → copy | `<leader>i` (`<leader>e` alias) | Voice: stop, transcribe & copy / `/voice-stop` |
| Stop → transcribe → submit | `<leader>o` | Voice: stop, transcribe, insert & submit / `/voice-send` |
| Cancel recording | `esc` while recording | Voice: cancel recording / `/voice-cancel` |
| Copy a parked transcript | — | Voice: copy ready transcript / `/voice-insert` |
| Status | — | Voice: status / `/voice-status` |
| Diagnostics | — | Voice: diagnostics / `/voice-diagnose` |
| Setup check | — | Voice: setup wizard / `/voice-setup` |

`<leader>` defaults to `ctrl+x`. The `v`/`i`/`o` leader sequences are free in
the default OpenCode keymap (checked against the keybind reference for
1.18.x); `esc`-to-cancel is mode-gated to the recording state so it cannot
hijack normal `session_interrupt`.

---

## Known limitations

- **Ambient recording UI (V2).** The footer status shows `● REC 7s` while
  recording (plus background/parked states) and a state line appears above
  the session composer; idle renders nothing. V1 hosts keep toasts only.
- **No inline mic button (yet).** Milestone 1 uses palette/slash/keybindings
  + toasts. The target composer-adjacent UI (`🎙` / `● Listening…` with
  ✕/■/➤) needs a JSX slot (`session_prompt_right`); the state machine and
  commands are already shaped for it.
- **TUI `appendPrompt` targets the active prompt of its own instance** — there
  is no per-session parameter in OpenCode 1.18.x. Within one window the
  origin-route guard prevents misdelivery; across `opencode attach`
  (remote server) insertion routing is untested — local-server use is
  recommended (see `docs/limitations-remote.md` in a later milestone).
- **`insert-and-send`** calls the supported `submitPrompt`; if a future
  OpenCode version restricts it, the transcript is still inserted and kept.
- **Recording backends:** macOS (AVFoundation) is the verified path. Linux
  ALSA and Windows dshow command templates exist and CI builds/tests on all
  three OSes, but real-device recording on Linux/Windows still needs
  confirmation.
  The core providers never download models; only the setup wizard downloads,
  and only with explicit approval.
- **One recording at a time** per window (by design); transcriptions queue.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `No transcribe executable found` | run `npx opencode-voice setup`, build transcribe.cpp as above; or set `OPENCODE_VOICE_TRANSCRIBE_BIN` |
| `No compatible GGUF model found` | run `npx opencode-voice setup`, use the Handy GGUF cache/app path or set `OPENCODE_VOICE_MODEL_PATH`; run `npm run diagnose` |
| `No whisper executable found` | Optional fallback: `brew install whisper-cpp`; or set `OPENCODE_VOICE_WHISPER_BIN` |
| `Microphone permission denied` | macOS: System Settings → Privacy & Security → Microphone → allow your terminal; restart the terminal. On Linux/Windows, check the OS input-device privacy setting |
| `Audio input device … not available` | `npm run diagnose` lists devices; set `device` (e.g. `":1"` or the exact name) |
| `Recording captured no audio` | mic muted / wrong device; check `device` |
| `Could not copy the transcript to the clipboard` | install `wl-copy` (Wayland) or `xclip` (X11) on Linux; headless SSH has no display — run locally or use display forwarding; the transcript is also saved to a temp file whose path is shown in the error |
| `Transcript ready for another session` | switch back to the originating session (auto-inserts), or `/voice-insert` there |
| Mic indicator stuck after stopping | update the plugin and restart OpenCode (startup-window orphans are fixed); if it persists, kill stray `ffmpeg` and check `device` |
| Auto-paste does nothing (toast says copied) | keep the composer visible in its session and retry; `pasteMethod: "keystroke"` (macOS, needs Accessibility on the terminal) or paste manually |
| `o` pressed but an old transcript was sent | fixed: stray presses never deliver parked jobs (status toast instead); delivery is bound to the stopped recording, oldest-first, after its transcription ends |
| `No speech detected` | silence/short blip; nothing inserted (expected) |
| Plugin fails to load | `npm run typecheck && npm test`; check OpenCode ≥ 1.18.29; load with `--log-level DEBUG` |

Debug mode (`"debug": true` or `OPENCODE_VOICE_DEBUG=1`) logs the job
lifecycle (`voice job created`, `recording started`, …, `cleanup completed`)
without ever logging transcripts or audio.

---

## Manual end-to-end test

Prerequisites: `ffmpeg`, a `transcribe-cli` runtime (or the whisper.cpp
fallback), a compatible local model, and microphone permission
for your terminal. The fastest path is `npx opencode-voice setup`.

1. `npm run build`
2. `npx opencode-voice setup --check` → `Status: ready`.
2. Add `"plugin": ["file:///path/to/opencode-voice/dist/server.js"]` to a
   project `opencode.json`, and `dist/tui.js` to its `tui.json` `plugin`.
   For V2 configure the server with `plugins` and load `dist/tui-v2.js` as the
   CLI/TUI plugin.
3. `npm run diagnose` → `Status: ready`.
4. Launch OpenCode in that project; open a session.
5. `/voice-diagnose` → toast shows ready.
6. `<leader>v`, speak (“hello voice test”), `<leader>i` → toast
   “Transcribing…”, then “Transcript copied — paste with ⌘V / Ctrl+V.”
   Paste into the composer to verify.
7. `<leader>v`, speak, `esc` → “Recording cancelled — nothing was inserted.”
8. While one transcription runs, start a second recording (queues behind it).
9. Start a recording in session A (`<leader>o` job), switch to session B
   before it finishes → nothing appears in B; switch back to A → transcript
   submits there. `i` jobs copy regardless of session (no targeting).

---

## Development commands

```sh
npm install      # dev dependencies (@opencode-ai/plugin types, typescript)
npm run typecheck # checks src + tests + scripts
npm run build    # emits dist/ (./server and ./tui entries, plus the setup CLI)
npm test         # compiles to dist-test/ + runs node:test suites
npm run diagnose # local readiness probe (provider/model/mic)
npm run setup:check # setup wizard in detect-only mode
npm run clean    # rm -rf dist dist-test
```

Conventions: strict TypeScript (`noUncheckedIndexedAccess`, unused checks),
zero runtime dependencies (only `node:` builtins + OpenCode peer types),
provider/recorder logic behind interfaces so tests never need hardware
(`test/fakes.ts`).

## Support

Free and open-source (MIT). If it helps you, support it here:
https://ko-fi.com/mohamedbakklitahiri

License: MIT.
