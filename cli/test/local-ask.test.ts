import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearLocalAskSessions, localAsk, resolveLocalHarness } from "../src/local-ask.js";

afterEach(() => {
  clearLocalAskSessions();
});

describe("resolveLocalHarness", () => {
  it("reports missing binary", () => {
    const r = resolveLocalHarness({
      responder: { harness: "claude", binary: "definitely-missing-binary-xyz" },
    });
    expect(r).toMatchObject({ error: expect.stringContaining("not found") });
  });
});

describe("localAsk", () => {
  it("runs first then followup with injected runners", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "doucopy-local-"));
    const calls: string[] = [];
    const first = await localAsk({
      home,
      question: "ping",
      config: { responder: { harness: "claude", binary: "claude", response_timeout_seconds: 30 } },
      runFirst: async (_opts, task) => {
        calls.push(`first:${task.includes("ping")}`);
        return { conversationId: "", answer: "pong", sessionId: "sess-1" };
      },
      runFollowup: async (_opts, sessionId, task) => {
        calls.push(`follow:${sessionId}:${task.includes("again")}`);
        return { conversationId: "", answer: "pong2", sessionId };
      },
    });
    expect(first.answer).toBe("pong");
    expect(first.conversationId).toBeTruthy();

    const second = await localAsk({
      home,
      question: "again",
      conversationId: first.conversationId,
      config: { responder: { harness: "claude", binary: "claude" } },
      runFirst: async () => ({ conversationId: "", answer: "should-not", sessionId: "x" }),
      runFollowup: async (_opts, sessionId, task) => {
        calls.push(`follow:${sessionId}:${task.includes("again")}`);
        return { conversationId: "", answer: "pong2", sessionId };
      },
    });
    expect(second.answer).toBe("pong2");
    expect(calls).toEqual(["first:true", "follow:sess-1:true"]);
  });

  it("returns config error without calling runners", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "doucopy-local-err-"));
    const r = await localAsk({
      home,
      question: "hi",
      config: { responder: { harness: "claude", binary: "definitely-missing-binary-xyz" } },
    });
    expect(r.error).toMatch(/not found/);
    expect(r.answer).toBeUndefined();
  });

  it("starts a new first turn when harness kind changes mid-conversation", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "doucopy-local-switch-"));
    const calls: string[] = [];
    const first = await localAsk({
      home,
      question: "via-claude",
      config: { responder: { harness: "claude", binary: "claude" } },
      runFirst: async () => {
        calls.push("first-claude");
        return { conversationId: "", answer: "a", sessionId: "claude-sess" };
      },
      runFollowup: async () => {
        calls.push("follow-claude");
        return { conversationId: "", answer: "nope", sessionId: "claude-sess" };
      },
    });

    const second = await localAsk({
      home,
      question: "via-codex",
      conversationId: first.conversationId,
      config: { responder: { harness: "codex", binary: "codex" } },
      runFirst: async () => {
        calls.push("first-codex");
        return { conversationId: "", answer: "b", sessionId: "codex-sess" };
      },
      runFollowup: async () => {
        calls.push("follow-codex");
        return { conversationId: "", answer: "nope", sessionId: "x" };
      },
    });

    expect(second.answer).toBe("b");
    expect(calls).toEqual(["first-claude", "first-codex"]);
  });
});
