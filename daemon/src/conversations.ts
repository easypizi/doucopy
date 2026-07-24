import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface Entry {
  chat_id: string;
  updated_at: number;
}

export class ConversationStore {
  private entries: Record<string, Entry>;

  constructor(private filePath: string) {
    const fileExisted = existsSync(filePath);
    if (fileExisted) {
      try {
        this.entries = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, Entry>;
      } catch {
        console.error("conversations store corrupted, starting fresh");
        this.entries = {};
      }
    } else {
      this.entries = {};
    }
    const now = Date.now();
    let pruned = false;
    for (const [id, entry] of Object.entries(this.entries)) {
      if (now - entry.updated_at > MAX_AGE_MS) {
        delete this.entries[id];
        pruned = true;
      }
    }
    if (pruned || !fileExisted) {
      this.save();
    }
  }

  get(conversationId: string): string | null {
    return this.entries[conversationId]?.chat_id ?? null;
  }

  set(conversationId: string, chatId: string): void {
    this.entries[conversationId] = { chat_id: chatId, updated_at: Date.now() };
    this.save();
  }

  private save(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(this.entries, null, 2));
    renameSync(tmpPath, this.filePath);
  }
}
