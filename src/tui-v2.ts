import { Plugin } from "@opencode/plugin/tui";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { OpenCodeVoiceTui } from "./tui.js";

const PLUGIN_ID = "opencode-voice.tui";

interface LegacyLayer {
  mode?: string;
  commands?: Array<{
    name: string;
    title?: string;
    category?: string;
    namespace?: string;
    slashName?: string;
    run: () => void | Promise<void>;
  }>;
  bindings?: Array<{ key: string; cmd: string; desc?: string }>;
}

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(context) {
    context.ui.toast.show({
      title: "OpenCode Voice",
      message: "OpenCode Voice TUI loaded",
      variant: "success",
    });

    const layers: LegacyLayer[] = [];
    let disposeLegacy: (() => void | Promise<void>) | undefined;
    let disposeSlot: (() => void) | undefined;
    let layersInstalled = false;

    const api = {
      options: context.options,
      state: { path: { directory: context.location?.directory ?? process.cwd() } },
      route: {
        get current() {
          const route = context.ui.router.current();
          if (route.type === "session") {
            return { name: "session", params: { sessionID: route.sessionID } };
          }
          if (route.type === "home") return { name: "home", params: undefined };
          return { name: "plugin", params: undefined };
        },
        navigate: (name: string, params?: Record<string, unknown>) => {
          try {
            if (name === "session" && params && typeof (params as { sessionID?: unknown }).sessionID === "string") {
              context.ui.router.navigate({ type: "session", sessionID: (params as { sessionID: string }).sessionID });
            } else if (name === "home") {
              context.ui.router.navigate({ type: "home" });
            }
          } catch {
            /* best effort */
          }
        },
      },
      ui: {
        toast: (options: Parameters<typeof context.ui.toast.show>[0]) => context.ui.toast.show(options),
        get tabs() {
          return context.ui.tabs;
        },
        get router() {
          return context.ui.router;
        },
        slot: (
          claim: Parameters<typeof context.ui.slot>[0],
        ): (() => void) => context.ui.slot(claim),
      },
      mode: {
        push: (mode: string) => context.keymap.mode.push(mode),
      },
      keymap: {
        registerLayer(layer: LegacyLayer) {
          layers.push(layer);
        },
        dispatch: (id: string, input?: string) => {
          try {
            context.keymap.dispatch(id, input);
            return true;
          } catch {
            return false;
          }
        },
      },
      client: context.client,
      data: (context as unknown as { data?: unknown }).data,
      lifecycle: {
        onDispose(cleanup: () => void | Promise<void>) {
          disposeLegacy = cleanup;
        },
      },
    } as unknown as TuiPluginApi;

    await OpenCodeVoiceTui(api, context.options, {} as never);

    // The V2 API installs reactive layers while a slot is rendered. This is
    // intentional: calling keymap.layer from setup() is outside the host's
    // Solid/reactive registration scope on current V2 releases.
    disposeSlot = context.ui.slot({
      append: "app",
      render: () => {
        if (layersInstalled) return null;
        layersInstalled = true;
        for (const layer of layers) {
          context.keymap.layer(() => translateLayer(layer));
        }
        return null;
      },
    });

    return async () => {
      disposeSlot?.();
      await disposeLegacy?.();
    };
  },
});

function translateLayer(layer: LegacyLayer) {
  const bindings = new Map((layer.bindings ?? []).map((binding) => [binding.cmd, binding]));
  const commands = (layer.commands ?? []).map((command) => {
    const binding = bindings.get(command.name);
    return {
      id: command.name,
      title: command.title,
      group: command.category,
      ...(command.namespace === "palette" ? { palette: true as const } : {}),
      slash: command.slashName ? { name: command.slashName } : undefined,
      bind: binding?.key,
      run: command.run,
    };
  });

  return {
    // Legacy layers without an explicit mode are global in the V1 adapter.
    // V2's default is the base input mode, which does not own slash
    // completion consistently across the prompt and home screens.
    mode: layer.mode ?? "global",
    commands,
    // V2 expects command IDs here, not V1 `{ key, cmd }` binding objects.
    bindings: commands.map((command) => command.id),
  };
}
