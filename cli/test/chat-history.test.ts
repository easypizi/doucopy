import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CHAT_HISTORY_SCHEMA,
  clampFeedText,
  loadChatHistory,
  saveChatHistory,
  withDialogPreview,
} from "../src/chat-history.js";

describe("chat-history", () => {
  it("round-trips dialogs and feed", () => {
    const home = mkdtempSync(path.join(tmpdir(), "doucopy-chat-hist-"));
    saveChatHistory(home, {
      schema_version: CHAT_HISTORY_SCHEMA,
      dialogs: [
        {
          id: "d1",
          peer: "alice",
          conversationId: "conv-1",
          label: "alice · conv-1",
          updatedAt: 100,
        },
      ],
      feed: [
        { id: "f1", kind: "ask", peer: "alice", dialogId: "d1", text: "hello there world" },
        { id: "f2", kind: "reply", peer: "alice", dialogId: "d1", text: "hi" },
      ],
      activeDialogId: "d1",
      filterDialogId: "d1",
      askPeerName: "alice",
      updatedAt: 1,
    });
    const loaded = loadChatHistory(home);
    expect(loaded.dialogs).toHaveLength(1);
    expect(loaded.feed).toHaveLength(2);
    expect(loaded.activeDialogId).toBe("d1");
    expect(loaded.askPeerName).toBe("alice");
  });

  it("clampFeedText collapses huge status dumps to one short line", () => {
    const dump = [
      "error: unexpected argument '--sandbox' found",
      "tip: to pass '--sandbox' as a value, use '-- --sandbox'",
      "Opened Codex v0.142.0",
      "workdir: /tmp/x",
      "model: gpt-5",
      "a".repeat(500),
    ].join("\n");
    const clamped = clampFeedText(dump, "status");
    expect(clamped.includes("\n")).toBe(false);
    expect(clamped.length).toBeLessThanOrEqual(360);
    expect(clamped.endsWith("…")).toBe(true);
  });

  it("clampFeedText keeps reply newlines but caps line count", () => {
    const body = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const clamped = clampFeedText(body, "reply");
    expect(clamped.split("\n").length).toBeLessThanOrEqual(25);
    expect(clamped).toContain("…");
  });

  it("load clamps oversized status text from disk", () => {
    const home = mkdtempSync(path.join(tmpdir(), "doucopy-chat-clamp-"));
    saveChatHistory(home, {
      schema_version: CHAT_HISTORY_SCHEMA,
      dialogs: [],
      feed: [
        {
          id: "f1",
          kind: "status",
          peer: "(local)",
          text: `error: boom\n${"x".repeat(800)}`,
        },
      ],
      activeDialogId: null,
      filterDialogId: null,
      askPeerName: null,
      updatedAt: 1,
    });
    // Bypass save clamping by rewriting the file with a huge raw status.
    const file = path.join(home, ".doucopy", "chat-history.json");
    const raw = JSON.parse(readFileSync(file, "utf8")) as {
      feed: Array<{ text: string }>;
    };
    raw.feed[0]!.text = `error: boom\n${"y".repeat(800)}`;
    writeFileSync(file, JSON.stringify(raw));
    const loaded = loadChatHistory(home);
    expect(loaded.feed[0]!.text.length).toBeLessThanOrEqual(360);
    expect(loaded.feed[0]!.text.includes("\n")).toBe(false);
  });

  it("adds lastPreview for dialog picker", () => {
    const dialogs = withDialogPreview(
      [{ id: "d1", peer: "bob", conversationId: null, label: "bob", updatedAt: 1 }],
      [
        { id: "1", kind: "ask", dialogId: "d1", peer: "bob", text: "what about the launch plan tomorrow?" },
      ],
    );
    expect(dialogs[0]!.lastPreview).toMatch(/what about the launch/);
  });
});
