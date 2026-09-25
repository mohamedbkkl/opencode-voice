import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  autoPaste,
  frontmostAppCommand,
  isPasteTarget,
  parsePasteMethod,
  pasteKeystrokeCommand,
  type ShellRunner,
} from "../src/core/autopaste.js";

function runnerFor(frontmost: string, pasteExit = 0): ShellRunner {
  return async (executable, args) => {
    assert.equal(executable, "osascript");
    const script = args[1] ?? "";
    if (script.includes("frontmost")) {
      return { exitCode: 0, stdout: `${frontmost}\n`, timedOut: false };
    }
    return { exitCode: pasteExit, stdout: "", timedOut: false };
  };
}

describe("paste targets", () => {
  it("allows common terminals (case-insensitive)", () => {
    assert.equal(isPasteTarget("iTerm2"), true);
    assert.equal(isPasteTarget("terminal"), true);
    assert.equal(isPasteTarget("Code"), true);
  });

  it("rejects browsers and empty names", () => {
    assert.equal(isPasteTarget("Safari"), false);
    assert.equal(isPasteTarget("Google Chrome"), false);
    assert.equal(isPasteTarget(""), false);
    assert.equal(isPasteTarget("   "), false);
  });

  it("accepts user-extended app names", () => {
    assert.equal(isPasteTarget("MyTerm", ["myterm"]), true);
    assert.equal(isPasteTarget("MyTerm"), false);
  });

  it("builds osascript commands", () => {
    assert.equal(frontmostAppCommand().executable, "osascript");
    assert.equal(pasteKeystrokeCommand().executable, "osascript");
    assert.match(pasteKeystrokeCommand().args.join(" "), /keystroke "v"/);
  });
});

describe("autoPaste", () => {
  it("pastes when a terminal is focused", async () => {
    const out = await autoPaste(runnerFor("iTerm2"), { platform: "darwin" });
    assert.deepEqual(out, { pasted: true, app: "iTerm2" });
  });

  it("refuses when focus is elsewhere", async () => {
    const out = await autoPaste(runnerFor("Safari"), { platform: "darwin" });
    assert.deepEqual(out, { pasted: false, reason: "not-focused" });
  });

  it("reports failure when the keystroke fails", async () => {
    const out = await autoPaste(runnerFor("iTerm2", 1), { platform: "darwin" });
    assert.deepEqual(out, { pasted: false, reason: "failed" });
  });

  it("is unsupported off macOS", async () => {
    const out = await autoPaste(runnerFor("iTerm2"), { platform: "linux" });
    assert.deepEqual(out, { pasted: false, reason: "unsupported-platform" });
  });

  it("never throws on runner errors", async () => {
    const bad: ShellRunner = async () => {
      throw new Error("nope");
    };
    const out = await autoPaste(bad, { platform: "darwin" });
    assert.deepEqual(out, { pasted: false, reason: "failed" });
  });
});

describe("parsePasteMethod", () => {
  it("accepts dispatch, keystroke, auto", () => {
    assert.equal(parsePasteMethod("dispatch"), "dispatch");
    assert.equal(parsePasteMethod("keystroke"), "keystroke");
    assert.equal(parsePasteMethod("auto"), "auto");
  });

  it("falls back to auto", () => {
    assert.equal(parsePasteMethod("bogus"), "auto");
    assert.equal(parsePasteMethod(undefined), "auto");
    assert.equal(parsePasteMethod(42), "auto");
  });
});
