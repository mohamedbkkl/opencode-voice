import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createSerializer,
  decideModelAlignment,
  messageContainsText,
  modelLabel,
  parseChatModelOption,
  parseChatModelString,
  sameModel,
} from "../src/core/submit-model.js";

describe("chatModel parsing", () => {
  it("parses provider/id strings", () => {
    assert.deepEqual(parseChatModelString("openai/gpt-5.6-luna-fast"), {
      providerID: "openai",
      id: "gpt-5.6-luna-fast",
    });
  });

  it("rejects strings without a provider", () => {
    assert.equal(parseChatModelString("gpt-5.6"), undefined);
    assert.equal(parseChatModelString(""), undefined);
    assert.equal(parseChatModelString("/x"), undefined);
    assert.equal(parseChatModelString("x/"), undefined);
  });

  it("parses option objects", () => {
    assert.deepEqual(
      parseChatModelOption({ providerID: "openai", id: "gpt-5.6-luna-fast" }),
      { providerID: "openai", id: "gpt-5.6-luna-fast" },
    );
    assert.equal(parseChatModelOption({ providerID: "openai" }), undefined);
    assert.equal(parseChatModelOption("nope"), undefined);
  });

  it("sameModel compares provider + id", () => {
    const a = { providerID: "openai", id: "x" };
    assert.equal(sameModel(a, { ...a }), true);
    assert.equal(sameModel(a, { providerID: "openai", id: "y" }), false);
    assert.equal(sameModel(a, undefined), false);
  });

  it("modelLabel falls back to session default", () => {
    assert.equal(modelLabel({ providerID: "openai", id: "x" }), "openai/x");
    assert.equal(modelLabel(undefined), "session default");
  });
});

describe("model alignment rules (R11)", () => {
  const configured = { providerID: "openai", id: "muse-spark" };
  const other = { providerID: "other", id: "gpt-6" };

  it("never switches without a configured model", () => {
    assert.equal(
      decideModelAlignment({ stored: undefined, messageCount: 0, configured: undefined }).switch,
      false,
    );
  });

  it("never switches a used session", () => {
    assert.equal(
      decideModelAlignment({ stored: other, messageCount: 3, configured }).switch,
      false,
    );
  });

  it("switches a fresh session with a different stored model", () => {
    assert.equal(
      decideModelAlignment({ stored: other, messageCount: 0, configured }).switch,
      true,
    );
  });

  it("switches when nothing is stored", () => {
    assert.equal(
      decideModelAlignment({ stored: undefined, messageCount: 0, configured }).switch,
      true,
    );
    assert.equal(
      decideModelAlignment({ stored: undefined, messageCount: undefined, configured }).switch,
      true,
    );
  });

  it("never switches on unknown state with a differing stored model", () => {
    assert.equal(
      decideModelAlignment({ stored: other, messageCount: undefined, configured }).switch,
      false,
    );
  });

  it("is a no-op when already aligned", () => {
    assert.equal(
      decideModelAlignment({ stored: { ...configured }, messageCount: 0, configured }).switch,
      false,
    );
  });
});

describe("messageContainsText", () => {
  it("matches a distinctive slice inside opaque messages", () => {
    const needle = "the quick brown fox jumps over the lazy dog near the riverbank";
    assert.equal(messageContainsText([{ role: "user", text: needle }], needle), true);
    assert.equal(messageContainsText([{ role: "user", text: "hello" }], needle), false);
  });

  it("rejects empty inputs", () => {
    assert.equal(messageContainsText([], "some decent length needle here"), false);
    assert.equal(messageContainsText([{ a: 1 }], "  "), false);
    assert.equal(messageContainsText(undefined, "some decent length needle here"), false);
  });
});

describe("createSerializer", () => {
  it("runs concurrent callers one at a time, in order", async () => {
    const run = createSerializer();
    const order: string[] = [];
    const slow = run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      order.push("slow");
      return "slow";
    });
    const fast = run(async () => {
      order.push("fast");
      return "fast";
    });
    assert.deepEqual(await Promise.all([slow, fast]), ["slow", "fast"]);
    assert.deepEqual(order, ["slow", "fast"]);
  });

  it("survives rejections without jamming the chain", async () => {
    const run = createSerializer();
    await assert.rejects(run(async () => {
      throw new Error("boom");
    }));
    assert.equal(await run(async () => "next"), "next");
  });
});
