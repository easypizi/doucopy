import { v7 as uuidv7 } from "uuid";
import type { Question } from "./types.js";

const QUESTION_TTL_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = QUESTION_TTL_MS;
const INBOX_LIMIT = 100;
const ONLINE_WINDOW_MS = 60_000;
/** Drop peers from list_peers /status after this without an inbox poll (rename ghosts). */
export const PEER_RETENTION_MS = 5 * 60_000;
export const MAX_HOPS = 1;
export const MAX_OPEN_PER_CONVERSATION = 4;

export type ReplyStatus =
  | { status: "answered"; answer: string }
  | { status: "error"; error: string }
  | { status: "pending" }
  | { status: "unknown_ticket" };

interface PendingEntry {
  peer: string;
  from: string;
  conversation_id: string;
  hops: number;
  created_at: number;
  deadline: number;
  answer?: string;
  error?: string;
  settled: boolean;
  settleListeners: Set<() => void>;
}

export class HopLimitError extends Error {
  constructor(hops: number) {
    super(`hops=${hops} exceeds the counter-question depth limit (max ${MAX_HOPS})`);
  }
}

export class ConversationFullError extends Error {
  constructor(conversationId: string) {
    super(`conversation ${conversationId} has too many open tickets (max ${MAX_OPEN_PER_CONVERSATION})`);
  }
}

export interface OutgoingTicket {
  ticket_id: string;
  to_peer: string;
  status: "pending" | "answered" | "error";
  created_at: number;
}

interface Waiter {
  resolve: (q: Question | null) => void;
  timer: NodeJS.Timeout;
}

export class Mailbox {
  private inbox = new Map<string, Question[]>();
  private pending = new Map<string, PendingEntry>();
  private waiters = new Map<string, Waiter[]>();
  private lastSeen = new Map<string, number>();
  private cleaning = false;

  enqueue(
    toPeer: string,
    fromPeer: string,
    question: string,
    conversationId?: string,
    clientHops = 0,
  ): { ticket_id: string; conversation_id: string } {
    this.cleanup();
    const now = Date.now();
    const ticket_id = uuidv7();
    const conversation_id = conversationId ?? uuidv7();
    // Derive hops from server state so a malicious client cannot bypass the
    // depth limit by simply omitting the parameter. If fromPeer currently owes
    // an unsettled answer in this conversation (entry.peer === fromPeer), the
    // new question is a counter-question and its hops must be at least
    // max(open inbound hops) + 1. Take max(client, derived) so honest clients
    // that already increment the counter still behave correctly.
    let derivedHops = 0;
    if (conversationId !== undefined) {
      let open = 0;
      let maxInboundHops = -1;
      for (const entry of this.pending.values()) {
        if (entry.conversation_id !== conversationId) continue;
        if (entry.settled) continue;
        open += 1;
        if (entry.peer === fromPeer && entry.hops > maxInboundHops) {
          maxInboundHops = entry.hops;
        }
      }
      if (open >= MAX_OPEN_PER_CONVERSATION) throw new ConversationFullError(conversationId);
      if (maxInboundHops >= 0) derivedHops = maxInboundHops + 1;
    }
    const hops = Math.max(clientHops, derivedHops);
    if (hops > MAX_HOPS) throw new HopLimitError(hops);
    const item: Question = {
      ticket_id,
      from_peer: fromPeer,
      question,
      conversation_id,
      hops,
      created_at: now,
      deadline: now + QUESTION_TTL_MS,
    };
    this.pending.set(ticket_id, {
      peer: toPeer,
      from: fromPeer,
      conversation_id,
      hops,
      created_at: now,
      deadline: item.deadline,
      settled: false,
      settleListeners: new Set(),
    });

    const waiter = this.waiters.get(toPeer)?.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(item);
    } else {
      const queue = this.inbox.get(toPeer) ?? [];
      queue.push(item);
      while (queue.length > INBOX_LIMIT) {
        const dropped = queue.shift();
        if (dropped) this.settle(dropped.ticket_id, { error: "overflow" });
      }
      this.inbox.set(toPeer, queue);
    }
    return { ticket_id, conversation_id };
  }

  takeNext(peer: string, waitMs: number): Promise<Question | null> {
    this.lastSeen.set(peer, Date.now());
    this.cleanup();
    const next = this.inbox.get(peer)?.shift();
    if (next) return Promise.resolve(next);
    return new Promise((resolve) => {
      const waiter: Waiter = {
        resolve,
        timer: setTimeout(() => {
          const list = this.waiters.get(peer) ?? [];
          const index = list.indexOf(waiter);
          if (index >= 0) list.splice(index, 1);
          resolve(null);
        }, waitMs),
      };
      const list = this.waiters.get(peer) ?? [];
      list.push(waiter);
      this.waiters.set(peer, list);
    });
  }

  settle(ticketId: string, result: { answer?: string; error?: string }, answeredBy?: string): boolean {
    this.cleanup();
    const entry = this.pending.get(ticketId);
    if (!entry || entry.settled) return false;
    if (answeredBy !== undefined && answeredBy !== entry.peer) return false;
    entry.answer = result.answer;
    entry.error = result.error;
    if (entry.answer === undefined && entry.error === undefined) entry.error = "empty answer";
    entry.settled = true;
    entry.deadline = Date.now() + RETENTION_MS;
    for (const listener of [...entry.settleListeners]) listener();
    return true;
  }

  waitForAnswer(ticketId: string, timeoutMs: number, signal?: AbortSignal): Promise<ReplyStatus> {
    this.cleanup();
    const entry = this.pending.get(ticketId);
    if (!entry) return Promise.resolve({ status: "unknown_ticket" });
    if (entry.settled) return Promise.resolve(this.consume(ticketId, entry));
    if (signal?.aborted) return Promise.resolve({ status: "pending" });
    return new Promise((resolve) => {
      const cleanup = () => {
        clearTimeout(timer);
        entry.settleListeners.delete(listener);
        signal?.removeEventListener("abort", onAbort);
      };
      const listener = () => {
        cleanup();
        resolve(this.consume(ticketId, entry));
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve({ status: "pending" });
      }, timeoutMs);
      // The asker's connection died; leave the entry settled (if it later is) so
      // check_reply can still retrieve the answer instead of losing it silently.
      const onAbort = () => {
        cleanup();
        resolve({ status: "pending" });
      };
      entry.settleListeners.add(listener);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  checkReply(ticketId: string): ReplyStatus {
    this.cleanup();
    const entry = this.pending.get(ticketId);
    if (!entry) return { status: "unknown_ticket" };
    if (!entry.settled) return { status: "pending" };
    return this.consume(ticketId, entry);
  }

  isOnline(peer: string): boolean {
    const seen = this.lastSeen.get(peer);
    return seen !== undefined && Date.now() - seen < ONLINE_WINDOW_MS;
  }

  knownPeers(): string[] {
    this.pruneLastSeen();
    return [...this.lastSeen.keys()];
  }

  queuedCount(peer: string): number {
    return this.inbox.get(peer)?.length ?? 0;
  }

  /** Unsettled tickets addressed to this peer (still in inbox or already taken by the daemon). */
  openIncomingCount(peer: string): number {
    let n = 0;
    for (const entry of this.pending.values()) {
      if (entry.peer === peer && !entry.settled) n += 1;
    }
    return n;
  }

  outgoingFor(peer: string): OutgoingTicket[] {
    this.cleanup();
    const result: OutgoingTicket[] = [];
    for (const [ticket_id, entry] of this.pending) {
      if (entry.from !== peer) continue;
      const status = !entry.settled ? "pending" : entry.error !== undefined ? "error" : "answered";
      result.push({ ticket_id, to_peer: entry.peer, status, created_at: entry.created_at });
    }
    return result.sort((a, b) => a.created_at - b.created_at);
  }

  // Answers are single-read: consuming removes the entry to bound memory.
  private consume(ticketId: string, entry: PendingEntry): ReplyStatus {
    this.pending.delete(ticketId);
    if (entry.error !== undefined) return { status: "error", error: entry.error };
    return { status: "answered", answer: entry.answer ?? "" };
  }

  private pruneLastSeen(now = Date.now()): void {
    for (const [peer, seen] of this.lastSeen) {
      if (now - seen >= PEER_RETENTION_MS) this.lastSeen.delete(peer);
    }
  }

  private cleanup(): void {
    if (this.cleaning) return;
    this.cleaning = true;
    const now = Date.now();
    try {
      this.pruneLastSeen(now);
      for (const [peer, queue] of this.inbox) {
        const expired = queue.filter((q) => q.deadline <= now);
        this.inbox.set(peer, queue.filter((q) => q.deadline > now));
        for (const q of expired) this.settle(q.ticket_id, { error: "expired" });
      }
      for (const [id, entry] of this.pending) {
        if (entry.deadline > now) continue;
        if (entry.settled) this.pending.delete(id);
        else this.settle(id, { error: "expired" });
      }
    } finally {
      this.cleaning = false;
    }
  }
}
