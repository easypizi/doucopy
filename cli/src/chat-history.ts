import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const CHAT_HISTORY_SCHEMA = 1;
export const MAX_FEED = 200;
export const MAX_DIALOGS = 40;
/** Status/system lines (Codex stderr dumps) stay one short row. */
export const MAX_STATUS_TEXT = 360;
/** Ask/reply bodies may be multi-line but still bounded. */
export const MAX_BODY_TEXT = 2500;
export const MAX_BODY_LINES = 24;

export type ChatFeedKind = "system" | "ask" | "reply" | "note" | "status";

/** Ask delivery on the relay / peer (portable UI chip; no special fonts). */
export type AskDelivery = "sending" | "queued" | "offline" | "answering" | "done" | "error";

export interface ChatFeedItem {
  id: string;
  kind: ChatFeedKind;
  peer?: string;
  dialogId?: string;
  text: string;
  pending?: boolean;
  /** Live ticket phase for ask rows (updated in place while polling). */
  delivery?: AskDelivery;
  mode?: "ask" | "discuss";
  /** Epoch ms when the ask started (for live elapsed chip). */
  startedAt?: number;
}

/**
 * Clamp feed text so one bad harness error cannot blow past the TUI viewport.
 * Status/system/note collapse whitespace; ask/reply keep newlines with caps.
 */
export function clampFeedText(text: string, kind: ChatFeedKind): string {
  if (kind === "status" || kind === "system" || kind === "note") {
    const one = text.replace(/\s+/gu, " ").trim();
    if (one.length <= MAX_STATUS_TEXT) return one;
    return `${one.slice(0, MAX_STATUS_TEXT - 1)}…`;
  }
  const lines = text.replace(/\r\n/gu, "\n").split("\n");
  let out = lines.slice(0, MAX_BODY_LINES).join("\n");
  if (lines.length > MAX_BODY_LINES) out += "\n…";
  if (out.length > MAX_BODY_TEXT) out = `${out.slice(0, MAX_BODY_TEXT - 1)}…`;
  return out;
}

function clampFeedItems(feed: ChatFeedItem[]): ChatFeedItem[] {
  return feed.map((item) => ({ ...item, text: clampFeedText(item.text, item.kind) }));
}

export interface ChatDialog {
  id: string;
  peer: string;
  conversationId: string | null;
  label: string;
  updatedAt: number;
  lastPreview?: string;
}

export interface ChatHistoryFile {
  schema_version: number;
  dialogs: ChatDialog[];
  feed: ChatFeedItem[];
  activeDialogId: string | null;
  filterDialogId: string | null;
  askPeerName: string | null;
  updatedAt: number;
}

function historyPath(home: string): string {
  return path.join(home, ".doucopy", "chat-history.json");
}

export function emptyChatHistory(): ChatHistoryFile {
  return {
    schema_version: CHAT_HISTORY_SCHEMA,
    dialogs: [],
    feed: [],
    activeDialogId: null,
    filterDialogId: null,
    askPeerName: null,
    updatedAt: Date.now(),
  };
}

function migrate(raw: Partial<ChatHistoryFile>): ChatHistoryFile {
  const base = emptyChatHistory();
  const version = typeof raw.schema_version === "number" ? raw.schema_version : 0;
  if (version > CHAT_HISTORY_SCHEMA) {
    // Future file: keep what we understand.
  }
  return {
    schema_version: CHAT_HISTORY_SCHEMA,
    dialogs: Array.isArray(raw.dialogs) ? raw.dialogs.slice(0, MAX_DIALOGS) : base.dialogs,
    feed: Array.isArray(raw.feed) ? clampFeedItems(raw.feed.slice(-MAX_FEED)) : base.feed,
    activeDialogId: typeof raw.activeDialogId === "string" || raw.activeDialogId === null
      ? (raw.activeDialogId ?? null)
      : null,
    filterDialogId: typeof raw.filterDialogId === "string" || raw.filterDialogId === null
      ? (raw.filterDialogId ?? null)
      : null,
    askPeerName: typeof raw.askPeerName === "string" || raw.askPeerName === null
      ? (raw.askPeerName ?? null)
      : null,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : Date.now(),
  };
}

export function loadChatHistory(home: string): ChatHistoryFile {
  const file = historyPath(home);
  if (!existsSync(file)) return emptyChatHistory();
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<ChatHistoryFile>;
    return migrate(raw);
  } catch {
    return emptyChatHistory();
  }
}

export function saveChatHistory(home: string, history: ChatHistoryFile): void {
  const dir = path.join(home, ".doucopy");
  mkdirSync(dir, { recursive: true });
  const next: ChatHistoryFile = {
    schema_version: CHAT_HISTORY_SCHEMA,
    dialogs: history.dialogs.slice(0, MAX_DIALOGS),
    feed: clampFeedItems(history.feed.slice(-MAX_FEED)),
    activeDialogId: history.activeDialogId,
    filterDialogId: history.filterDialogId,
    askPeerName: history.askPeerName,
    updatedAt: Date.now(),
  };
  writeFileSync(historyPath(home), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
}

export function withDialogPreview(dialogs: ChatDialog[], feed: ChatFeedItem[]): ChatDialog[] {
  return dialogs.map((d) => {
    const last = [...feed].reverse().find((f) => f.dialogId === d.id && (f.kind === "ask" || f.kind === "reply"));
    const preview = last ? last.text.replace(/\s+/g, " ").slice(0, 48) : d.lastPreview;
    return preview ? { ...d, lastPreview: preview } : d;
  });
}
