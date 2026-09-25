import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { composerLine, homeLine, statusLine } from "../src/tui-ui.js";
import type { ManagerSnapshot } from "../src/core/jobs.js";

function snap(over: Partial<ManagerSnapshot> = {}): ManagerSnapshot {
  return {
    activeJob: undefined,
    queued: 0,
    transcribing: 0,
    recording: false,
    ready: [],
    ...over,
  };
}

describe("voice ambient UI lines", () => {
  it("idle renders nothing", () => {
    assert.equal(statusLine(undefined), undefined);
    assert.equal(statusLine(snap()), undefined);
    assert.equal(composerLine(undefined), undefined);
    assert.equal(composerLine(snap()), undefined);
  });

  function recordingSnap(origin: { route: "session"; sessionID: string } | { route: "home" }) {
    const startedAt = Date.now() - 7000;
    return snap({
      recording: true,
      activeJob: {
        id: "voice-1",
        status: "recording",
        origin,
        providerID: "test",
        requestedAction: "insert",
        createdAt: startedAt,
        updatedAt: startedAt,
        hasTranscript: false,
      },
    });
  }

  it("recording shows a live timer, not content", () => {
    const s = recordingSnap({ route: "session", sessionID: "sess-1" });
    assert.match(statusLine(s) ?? "", /REC 7s/);
    assert.match(composerLine(s) ?? "", /● 7s · speak now/);
  });

  it("own tab gets controls, other tabs get a pointer", () => {
    const s = recordingSnap({ route: "session", sessionID: "sess-1" });
    assert.match(statusLine(s, "sess-1") ?? "", /i\/e copy/);
    assert.match(statusLine(s, "sess-2") ?? "", /switch back to stop/);
    assert.match(composerLine(s, "sess-1") ?? "", /speak now/);
    assert.match(composerLine(s, "sess-2") ?? "", /switch back to stop it/);
  });

  it("pointer names the origin tab title when known", () => {
    const s = recordingSnap({ route: "session", sessionID: "sess-1" });
    const titleOf = (id: string): string | undefined =>
      id === "sess-1" ? "Recording test" : undefined;
    assert.match(statusLine(s, "sess-2", titleOf) ?? "", /Recording test/);
    assert.match(composerLine(s, "sess-2", titleOf) ?? "", /Recording test/);
    // Unknown title falls back to a short id, never blank.
    assert.match(statusLine(s, "sess-2") ?? "", /sess-1/);
  });

  it("home origin never claims a session tab", () => {
    const s = recordingSnap({ route: "home" });
    assert.match(statusLine(s, "sess-9") ?? "", /i\/e copy/);
    assert.match(composerLine(s, "sess-9") ?? "", /speak now/);
  });

  it("background work and parked transcripts have distinct lines", () => {
    assert.match(statusLine(snap({ transcribing: 1 })) ?? "", /transcribing/);
    assert.match(
      statusLine(
        snap({
          ready: [
            {
              id: "voice-1",
              status: "ready",
              origin: { route: "home" },
              providerID: "test",
              requestedAction: "insert",
              createdAt: 0,
              updatedAt: 0,
              hasTranscript: true,
            },
          ],
        }),
      ) ?? "",
      /voice-insert/,
    );
  });
});

describe("home line", () => {
  it("always renders something (proof of life)", () => {
    assert.match(homeLine(undefined), /voice ready/);
    assert.match(homeLine(snap()), /voice ready/);
    const startedAt = Date.now() - 3000;
    assert.match(
      homeLine(
        snap({
          recording: true,
          activeJob: {
            id: "voice-1",
            status: "recording",
            origin: { route: "session", sessionID: "s" },
            providerID: "test",
            requestedAction: "insert",
            createdAt: startedAt,
            updatedAt: startedAt,
            hasTranscript: false,
          },
        }),
      ),
      /REC/,
    );
  });
});
