import { v7 as uuidv7 } from "uuid";
import type { Question } from "./types.js";

const QUESTION_TTL_MS = 24 * 60 * 60 * 1000;
const INBOX_LIMIT = 100;
const ONLINE_WINDOW_MS = 60_000;

export type ReplyStatus =
  | { status: "answered"; answer: string }
  | { status: "error"; error: string }
  | { status: "pending" }
  | { status: "unknown_ticket" };

interface PendingEntry {
  deadline: number;
  answer?: string;
  error?: string;
  settled: boolean;
  onSettle?: () => void;
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

  enqueue(
    toPeer: string,
    fromPeer: string,
    question: string,
    conversationId?: string,
  ): { ticket_id: string; conversation_id: string } {
    this.cleanup();
    const now = Date.now();
    const ticket_id = uuidv7();
    const conversation_id = conversationId ?? uuidv7();
    const item: Question = {
      ticket_id,
      from_peer: fromPeer,
      question,
      conversation_id,
      created_at: now,
      deadline: now + QUESTION_TTL_MS,
    };
    this.pending.set(ticket_id, { deadline: item.deadline, settled: false });

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

  settle(ticketId: string, result: { answer?: string; error?: string }): boolean {
    const entry = this.pending.get(ticketId);
    if (!entry || entry.settled) return false;
    entry.answer = result.answer;
    entry.error = result.error;
    if (entry.answer === undefined && entry.error === undefined) entry.error = "empty answer";
    entry.settled = true;
    entry.onSettle?.();
    return true;
  }

  waitForAnswer(ticketId: string, timeoutMs: number): Promise<ReplyStatus> {
    const entry = this.pending.get(ticketId);
    if (!entry) return Promise.resolve({ status: "unknown_ticket" });
    if (entry.settled) return Promise.resolve(this.consume(ticketId, entry));
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        entry.onSettle = undefined;
        resolve({ status: "pending" });
      }, timeoutMs);
      entry.onSettle = () => {
        clearTimeout(timer);
        resolve(this.consume(ticketId, entry));
      };
    });
  }

  checkReply(ticketId: string): ReplyStatus {
    const entry = this.pending.get(ticketId);
    if (!entry) return { status: "unknown_ticket" };
    if (!entry.settled) return { status: "pending" };
    return this.consume(ticketId, entry);
  }

  isOnline(peer: string): boolean {
    const seen = this.lastSeen.get(peer);
    return seen !== undefined && Date.now() - seen < ONLINE_WINDOW_MS;
  }

  // Answers are single-read: consuming removes the entry to bound memory.
  private consume(ticketId: string, entry: PendingEntry): ReplyStatus {
    this.pending.delete(ticketId);
    if (entry.error !== undefined) return { status: "error", error: entry.error };
    return { status: "answered", answer: entry.answer ?? "" };
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [peer, queue] of this.inbox) {
      const expired = queue.filter((q) => q.deadline <= now);
      this.inbox.set(peer, queue.filter((q) => q.deadline > now));
      for (const q of expired) this.settle(q.ticket_id, { error: "expired" });
    }
    for (const [id, entry] of this.pending) {
      if (entry.deadline > now) continue;
      if (!entry.settled) this.settle(id, { error: "expired" });
    }
  }
}
