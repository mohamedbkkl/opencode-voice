import { describe, it } from "node:test";
import assert from "node:assert/strict";
import serverModule from "../src/server.js";
import tuiModule from "../src/tui.js";
import { __resetProcessSlots } from "../src/core/singleton.js";

describe("plugin module shapes (V1/V2 dual server)", () => {
  it("server entry exports both supported server APIs", () => {
    assert.equal(serverModule.id, "opencode-voice.server");
    assert.equal(typeof serverModule.server, "function");
    assert.equal(typeof serverModule.setup, "function");
  });

  it("tui entry exports { id, tui } only", () => {
    assert.equal(tuiModule.id, "opencode-voice");
    assert.equal(typeof tuiModule.tui, "function");
    assert.ok(!("server" in tuiModule), "tui module must not export server");
  });
});

function stubServerCtx(): {
  ctx: Record<string, unknown>;
  logs: unknown[];
} {
  const logs: unknown[] = [];
  const ctx = {
    client: {
      app: {
        log: async (input: unknown): Promise<void> => {
          logs.push(input);
        },
      },
    },
    project: { id: "p1" },
    directory: "/tmp",
    worktree: "/tmp",
    serverUrl: new URL("http://127.0.0.1:4096"),
    experimental_workspace: { register: (): void => undefined },
    $: (async (): Promise<unknown> => undefined) as unknown,
  };
  return { ctx, logs };
}

describe("server plugin", () => {
  it("registers voice tools and answers diagnostics", async () => {
    const { ctx } = stubServerCtx();
    const hooks = await (
      serverModule.server as (
        input: unknown,
        options?: unknown,
      ) => Promise<{ tool?: Record<string, { execute: (args: unknown, ctx: unknown) => Promise<unknown> }> }>
    )(ctx, { provider: "transcribe.cpp", executablePath: process.execPath });
    assert.ok(hooks.tool?.voice_status, "voice_status tool registered");
    assert.ok(hooks.tool?.voice_diagnose, "voice_diagnose tool registered");

    const statusRaw = (await hooks.tool.voice_status.execute({}, {})) as string;
    const status = JSON.parse(statusRaw) as { ready: boolean; provider: string };
    assert.equal(status.provider, "transcribe.cpp");
    assert.equal(typeof status.ready, "boolean");

    const text = (await hooks.tool.voice_diagnose.execute({}, {})) as string;
    assert.ok(text.includes("OpenCode Voice"));
  });
});

interface CapturedLayer {
  commands: { name: string; run: () => void }[];
  bindings: { key: string; cmd: string }[];
}

function stubTuiApi(): {
  api: Record<string, unknown>;
  layers: CapturedLayer[];
  toasts: { variant?: string; title?: string; message: string }[];
  disposed: { fn: (() => unknown) | undefined };
} {
  const layers: CapturedLayer[] = [];
  const toasts: { variant?: string; title?: string; message: string }[] = [];
  const disposed: { fn: (() => unknown) | undefined } = { fn: undefined };
  const api = {
    app: { version: "1.18.32" },
    attention: {},
    keys: {},
    keymap: {
      registerLayer: (layer: CapturedLayer): (() => void) => {
        layers.push(layer);
        return () => undefined;
      },
    },
    mode: {
      current: (): string => "base",
      push: (): (() => void) => () => undefined,
    },
    route: {
      register: (): (() => void) => () => undefined,
      navigate: (): void => undefined,
      current: { name: "session", params: { sessionID: "sess-test" } },
    },
    ui: {
      toast: (input: { variant?: string; title?: string; message: string }): void => {
        toasts.push(input);
      },
      dialog: {},
    },
    tuiConfig: {},
    kv: { get: (_k: string, fallback?: unknown): unknown => fallback, set: (): void => undefined, ready: true },
    state: { path: { directory: "/tmp" } },
    theme: {},
    client: {
      tui: {
        appendPrompt: async (): Promise<unknown> => true,
        submitPrompt: async (): Promise<unknown> => true,
      },
    },
    event: { on: (): (() => void) => () => undefined },
    renderer: {},
    slots: { register: (): string => "x" },
    plugins: { list: (): unknown[] => [] },
    lifecycle: {
      signal: new AbortController().signal,
      onDispose: (fn: () => unknown): (() => void) => {
        disposed.fn = fn;
        return () => undefined;
      },
    },
  };
  return { api, layers, toasts, disposed };
}

describe("tui plugin", () => {
  it("registers voice commands, keybindings and answers status", async () => {
    __resetProcessSlots();
    const { api, layers, toasts, disposed } = stubTuiApi();
    await (tuiModule.tui as (api: unknown, options?: unknown) => Promise<void>)(api, {});

    const allCommands = layers.flatMap((l) => l.commands);
    const names = allCommands.map((c) => c.name);
    for (const expected of [
      "voice.start",
      "voice.stop-insert",
      "voice.stop-send",
      "voice.cancel",
      "voice.insert-ready",
      "voice.status",
      "voice.diagnose",
    ]) {
      assert.ok(names.includes(expected), `command ${expected} registered`);
    }
    const keys = layers.flatMap((l) => l.bindings).map((b) => b.key);
    assert.ok(keys.includes("<leader>v"), "default start keybind");
    assert.ok(keys.includes("<leader>i"), "default stop-insert keybind");
    assert.ok(keys.includes("<leader>o"), "default stop-send keybind");

    const status = allCommands.find((c) => c.name === "voice.status");
    status?.run();
    const deadline = Date.now() + 5000;
    while (toasts.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(toasts.length > 0, "status command produced a toast");
    assert.ok(toasts[0]?.message.toLowerCase().includes("idle") || toasts[0]?.message.includes("ready to insert"));

    const diagnose = allCommands.find((c) => c.name === "voice.diagnose");
    diagnose?.run();
    const deadline2 = Date.now() + 15000;
    while (toasts.length < 2 && Date.now() < deadline2) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(toasts.length >= 2, "diagnose command produced a toast");

    await disposed.fn?.();
  });

  it("custom keybinds override defaults", async () => {
    __resetProcessSlots();
    const { api, layers } = stubTuiApi();
    await (tuiModule.tui as (api: unknown, options?: unknown) => Promise<void>)(api, {
      keybinds: { start: "ctrl+alt+v", stopInsert: false },
    });
    const keys = layers.flatMap((l) => l.bindings).map((b) => b.key);
    assert.ok(keys.includes("ctrl+alt+v"));
    assert.ok(!keys.includes("<leader>i"));
  });
});
