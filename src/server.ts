/**
 * Official dual V1/V2 server package entry.
 *
 * The V1 implementation is loaded lazily so a V2 host does not need to
 * resolve the legacy @opencode-ai/plugin runtime just to load setup().
 */
import { OpenCodeVoiceServerV2 } from "./server-v2.js";

export const PLUGIN_ID = "opencode-voice.server";

export const OpenCodeVoiceServer = async (input: unknown, options?: unknown): Promise<unknown> => {
  const legacy = await import("./server-v1.js");
  return legacy.OpenCodeVoiceServer(
    input as Parameters<typeof legacy.OpenCodeVoiceServer>[0],
    options as Parameters<typeof legacy.OpenCodeVoiceServer>[1],
  );
};

export default {
  id: PLUGIN_ID,
  server: OpenCodeVoiceServer,
  setup: OpenCodeVoiceServerV2,
};
