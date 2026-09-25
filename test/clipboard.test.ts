import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clipboardCommand, writeTranscriptFallback } from "../src/core/clipboard.js";

function finder(names: string[]): string | undefined {
  const available = new Set(["pbcopy", "wl-copy", "xclip", "xsel", "clip"]);
  const hit = names.find((n) => available.has(n));
  return hit ? `/usr/bin/${hit}` : undefined;
}

function missing(): undefined {
  return undefined;
}

describe("clipboard command selection", () => {
  it("macOS uses pbcopy", () => {
    assert.deepEqual(clipboardCommand("darwin", {}, finder), {
      executable: "/usr/bin/pbcopy",
      args: [],
    });
  });

  it("macOS without pbcopy reports unavailable", () => {
    assert.equal(clipboardCommand("darwin", {}, missing), undefined);
  });

  it("Windows uses clip", () => {
    assert.deepEqual(clipboardCommand("win32", {}, finder), {
      executable: "/usr/bin/clip",
      args: [],
    });
  });

  it("Wayland prefers wl-copy", () => {
    assert.deepEqual(
      clipboardCommand("linux", { WAYLAND_DISPLAY: "wayland-0" }, finder),
      { executable: "/usr/bin/wl-copy", args: [] },
    );
  });

  it("X11 falls back to xclip, then xsel", () => {
    assert.deepEqual(clipboardCommand("linux", {}, finder), {
      executable: "/usr/bin/xclip",
      args: ["-selection", "clipboard"],
    });
    const onlyXsel = (names: string[]): string | undefined =>
      names.includes("xsel") ? "/usr/bin/xsel" : undefined;
    assert.deepEqual(clipboardCommand("linux", {}, onlyXsel), {
      executable: "/usr/bin/xsel",
      args: ["--clipboard", "--input"],
    });
  });

  it("linux without tools reports unavailable", () => {
    assert.equal(clipboardCommand("linux", {}, missing), undefined);
  });

  it("unsupported platforms report unavailable", () => {
    assert.equal(clipboardCommand("sunos" as NodeJS.Platform, {}, finder), undefined);
  });
});

describe("transcript fallback file", () => {
  it("saves the transcript under the OS temp dir", async () => {
    const file = await writeTranscriptFallback("hello voice");
    try {
      assert.equal(path.dirname(file), path.join(os.tmpdir(), "opencode-voice"));
      assert.match(path.basename(file), /^transcript-\d+\.txt$/);
      assert.equal(await fs.readFile(file, "utf8"), "hello voice");
    } finally {
      await fs.unlink(file).catch(() => {});
    }
  });
});
