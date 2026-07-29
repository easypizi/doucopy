import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConversationStore } from "../src/conversations.js";

function tempFile(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "doucopy-")), "conversations.json");
}

describe("ConversationStore", () => {
  it("persists and reads back a mapping", () => {
    const file = tempFile();
    const store = new ConversationStore(file);
    expect(store.get("conv-1")).toBeNull();
    store.set("conv-1", "chat-42");
    expect(store.get("conv-1")).toBe("chat-42");
    const reloaded = new ConversationStore(file);
    expect(reloaded.get("conv-1")).toBe("chat-42");
  });

  it("recovers from corrupted JSON and round-trips after set", () => {
    const file = tempFile();
    writeFileSync(file, "not json{{{");
    const store = new ConversationStore(file);
    expect(store.get("conv-1")).toBeNull();
    store.set("conv-1", "chat-42");
    const reloaded = new ConversationStore(file);
    expect(reloaded.get("conv-1")).toBe("chat-42");
  });

  it("prunes entries older than 7 days on load", () => {
    const file = tempFile();
    const stale = Date.now() - 8 * 24 * 60 * 60 * 1000;
    writeFileSync(
      file,
      JSON.stringify({
        old: { chat_id: "chat-old", updated_at: stale },
        fresh: { chat_id: "chat-new", updated_at: Date.now() },
      }),
    );
    const store = new ConversationStore(file);
    expect(store.get("old")).toBeNull();
    expect(store.get("fresh")).toBe("chat-new");
    expect(readFileSync(file, "utf8")).not.toContain("chat-old");
  });
});
