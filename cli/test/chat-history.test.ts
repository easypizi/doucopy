import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CHAT_HISTORY_SCHEMA,
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
