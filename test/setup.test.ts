import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatSetup, parseSetupArgs, type SetupSnapshot } from "../src/setup.js";

describe("setup wizard", () => {
  it("parses setup modes", () => {
    assert.deepEqual(parseSetupArgs(["setup", "--check", "--json"]), {
      check: true,
      yes: false,
      json: true,
      help: false,
    });
    assert.equal(parseSetupArgs(["setup", "--yes"]).yes, true);
  });

  it("formats a ready snapshot", () => {
    const snapshot: SetupSnapshot = {
      providers: [
        {
          id: "transcribe.cpp",
          name: "transcribe.cpp (local, Metal)",
          available: true,
          executable: "/usr/local/bin/transcribe-cli",
          models: [
            {
              id: "whisper-large-v3-turbo-Q8_0",
              path: "/models/model.gguf",
              bytes: 10,
              preferred: true,
            },
          ],
          hint: "",
        },
      ],
      microphone: { available: true, devices: ["Built-in Microphone"], hint: "" },
      selectedProvider: "transcribe.cpp",
      selectedModel: {
        id: "whisper-large-v3-turbo-Q8_0",
        path: "/models/model.gguf",
        bytes: 10,
        preferred: true,
      },
      ready: true,
      actions: [],
    };
    const output = formatSetup(snapshot);
    assert.match(output, /Status: ready/);
    assert.match(output, /\/models\/model\.gguf/);
  });
});
