import { v7 as uuidv7 } from "uuid";
import type { AskMode, Question } from "./types.js";

const QUESTION_TTL_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = QUESTION_TTL_MS;
const INBOX_LIMIT = 100;
const ONLINE_WINDOW_MS = 60_000;
/** Drop peers from list_peers /status after this without an inbox poll (rename ghosts). */
export const PEER_RETENTION_MS = 5 * 60_000;
export const MAX_HOPS = 1;
export const MAX_OPEN_PER_CONVERSATION = 4;
export const PREVIEW_CHARS = 120;

export type TicketPhase = "queued" | "working";

export type ReplyStatus =
  | { status: "answered"; answer: string; answered?: string; refused?: string }
  | { status: "error"; error: string }
  | { status: "pending"; phase?: TicketPhase }
  | { status: "unknown_ticket" };

interface PendingEntry {
  peer: string;
  from: string;
  conversation_id: string;
  hops: number;
  created_at: number;
  deadline: number;
  question: string;
  brief?: string;
  mode: AskMode;
  phase: TicketPhase;
  answer?: string;
  error?: string;
  answered?: string;
  refused?: string;
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
  phase?: TicketPhase;
  created_at: number;
  mode: AskMode;
  question_preview: string;
}

export interface IncomingTicket {
  ticket_id: string;
  from_peer: string;
  conversation_id: string;
  created_at: number;
  phase: TicketPhase;
  mode: AskMode;
  question_preview: string;
}

export interface EnqueueOptions {
  conversationId?: string;
  clientHops?: number;
  mode?: AskMode;
  brief?: string;
}

interface Waiter {
  resolve: (q: Question | null) => void;
  timer: NodeJS.Timeout;
}

function previewOf(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= PREVIEW_CHARS) return one;
  return `${one.slice(0, PREVIEW_CHARS - 1)}…`;
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
    conversationIdOrOpts?: string | EnqueueOptions,
    clientHopsArg = 0,
  ): { ticket_id: string; conversation_id: string } {
    this.cleanup();
    const opts: EnqueueOptions =
      typeof conversationIdOrOpts === "string" || conversationIdOrOpts === undefined
        ? { conversationId: conversationIdOrOpts, clientHops: clientHopsArg }
        : conversationIdOrOpts;
    const conversationId = opts.conversationId;
    const clientHops = opts.clientHops ?? 0;
    const mode: AskMode = opts.mode === "discuss" ? "discuss" : "ask";
    const brief = typeof opts.brief === "string" && opts.brief.trim() ? opts.brief.trim().slice(0, 2000) : undefined;

    const now = Date.now();
    const ticket_id = uuidv7();
    const conversation_id = conversationId ?? uuidv7();
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
      mode,
      brief,
    };
    const entry: PendingEntry = {
      peer: toPeer,
      from: fromPeer,
      conversation_id,
      hops,
      created_at: now,
      deadline: item.deadline,
      question,
      brief,
      mode,
      phase: "queued",
      settled: false,
      settleListeners: new Set(),
    };
    this.pending.set(ticket_id, entry);

    const waiter = this.waiters.get(toPeer)?.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      entry.phase = "working";
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
    if (next) {
      this.markWorking(next.ticket_id);
      return Promise.resolve(next);
    }
    return new Promise((resolve) => {
      const waiter: Waiter = {
        resolve: (q) => {
          if (q) this.markWorking(q.ticket_id);
          resolve(q);
        },
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

  private markWorking(ticketId: string): void {
    const entry = this.pending.get(ticketId);
    if (entry && !entry.settled) entry.phase = "working";
  }

  settle(
    ticketId: string,
    result: { answer?: string; error?: string; answered?: string; refused?: string },
    answeredBy?: string,
  ): boolean {
    this.cleanup();
    const entry = this.pending.get(ticketId);
    if (!entry || entry.settled) return false;
    if (answeredBy !== undefined && answeredBy !== entry.peer) return false;
    entry.answer = result.answer;
    entry.error = result.error;
    entry.answered = result.answered;
    entry.refused = result.refused;
    if (entry.answer === undefined && entry.error === undefined) entry.error = "empty answer";
    entry.settled = true;
    entry.deadline = Date.now() + RETENTION_MS;
    for (const listener of [...entry.settleListeners]) listener();
    return true;
  }

  /** Assignee (responder peer) cancels an open ticket. */
  cancelByOwner(ticketId: string, ownerPeer: string): boolean {
    return this.settle(ticketId, { error: "cancelled by owner" }, ownerPeer);
  }

  /** Assignee answers manually instead of the agent. */
  answerByOwner(ticketId: string, ownerPeer: string, answer: string): boolean {
    const text = answer.trim();
    if (!text) return false;
    return this.settle(ticketId, { answer: text, answered: "yes", refused: "no" }, ownerPeer);
  }

  waitForAnswer(ticketId: string, timeoutMs: number, signal?: AbortSignal): Promise<ReplyStatus> {
    this.cleanup();
    const entry = this.pending.get(ticketId);
    if (!entry) return Promise.resolve({ status: "unknown_ticket" });
    if (entry.settled) return Promise.resolve(this.consume(ticketId, entry));
    if (signal?.aborted) return Promise.resolve({ status: "pending", phase: entry.phase });
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
        resolve({ status: "pending", phase: entry.phase });
      }, timeoutMs);
      const onAbort = () => {
        cleanup();
        resolve({ status: "pending", phase: entry.phase });
      };
      entry.settleListeners.add(listener);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  checkReply(ticketId: string): ReplyStatus {
    this.cleanup();
    const entry = this.pending.get(ticketId);
    if (!entry) return { status: "unknown_ticket" };
    if (!entry.settled) return { status: "pending", phase: entry.phase };
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

  incomingFor(peer: string): IncomingTicket[] {
    this.cleanup();
    const result: IncomingTicket[] = [];
    for (const [ticket_id, entry] of this.pending) {
      if (entry.peer !== peer || entry.settled) continue;
      result.push({
        ticket_id,
        from_peer: entry.from,
        conversation_id: entry.conversation_id,
        created_at: entry.created_at,
        phase: entry.phase,
        mode: entry.mode,
        question_preview: previewOf(entry.question),
      });
    }
    return result.sort((a, b) => a.created_at - b.created_at);
  }

  outgoingFor(peer: string): OutgoingTicket[] {
    this.cleanup();
    const result: OutgoingTicket[] = [];
    for (const [ticket_id, entry] of this.pending) {
      if (entry.from !== peer) continue;
      const status = !entry.settled ? "pending" : entry.error !== undefined ? "error" : "answered";
      result.push({
        ticket_id,
        to_peer: entry.peer,
        status,
        phase: entry.settled ? undefined : entry.phase,
        created_at: entry.created_at,
        mode: entry.mode,
        question_preview: previewOf(entry.question),
      });
    }
    return result.sort((a, b) => a.created_at - b.created_at);
  }

  private consume(ticketId: string, entry: PendingEntry): ReplyStatus {
    this.pending.delete(ticketId);
    if (entry.error !== undefined) return { status: "error", error: entry.error };
    return {
      status: "answered",
      answer: entry.answer ?? "",
      answered: entry.answered,
      refused: entry.refused,
    };
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
