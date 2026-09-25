import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { claimProcessSlot } from "../src/core/singleton.js";

describe("process singleton guard", () => {
  it("first caller wins, later callers stand down", () => {
    const name = `opencode-voice.test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    assert.equal(claimProcessSlot(name), true);
    assert.equal(claimProcessSlot(name), false);
    assert.equal(claimProcessSlot(name), false);
  });
});
