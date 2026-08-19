import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Mailbox, PEER_RETENTION_MS } from "../src/mailbox.js";

describe("Mailbox", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("delivers an enqueued question to takeNext immediately", async () => {
    const box = new Mailbox();
    const { ticket_id, conversation_id } = box.enqueue("work", "personal", "hi");
    const q = await box.takeNext("work", 1000);
    expect(q?.ticket_id).toBe(ticket_id);
    expect(q?.question).toBe("hi");
    expect(q?.from_peer).toBe("personal");
    expect(q?.conversation_id).toBe(conversation_id);
  });

  it("reuses a provided conversation_id", () => {
    const box = new Mailbox();
    const { conversation_id } = box.enqueue("work", "personal", "hi", "conv-1");
    expect(conversation_id).toBe("conv-1");
  });

  it("wakes a parked long-poll when a question arrives", async () => {
    const box = new Mailbox();
    const waiting = box.takeNext("work", 30_000);
    box.enqueue("work", "personal", "hi");
    await expect(waiting).resolves.toMatchObject({ question: "hi" });
  });

  it("resolves long-poll with null on timeout", async () => {
    const box = new Mailbox();
    const waiting = box.takeNext("work", 1000);
    vi.advanceTimersByTime(1001);
    await expect(waiting).resolves.toBeNull();
  });

  it("resolves waitForAnswer when the daemon settles the ticket", async () => {
    const box = new Mailbox();
    const { ticket_id } = box.enqueue("work", "personal", "hi");
    const waiting = box.waitForAnswer(ticket_id, 10_000);
    expect(box.settle(ticket_id, { answer: "42" })).toBe(true);
    await expect(waiting).resolves.toEqual({ status: "answered", answer: "42" });
  });

  it("resolves concurrent waitForAnswer calls with the same answer", async () => {
    const box = new Mailbox();
    const { ticket_id } = box.enqueue("work", "personal", "hi");
    const first = box.waitForAnswer(ticket_id, 10_000);
    const second = box.waitForAnswer(ticket_id, 10_000);
    expect(box.settle(ticket_id, { answer: "42" })).toBe(true);
    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: "answered", answer: "42" },
      { status: "answered", answer: "42" },
    ]);
    expect(box.checkReply(ticket_id)).toEqual({ status: "unknown_ticket" });
  });

  it("returns pending on waitForAnswer timeout, then answered via checkReply", async () => {
    const box = new Mailbox();
    const { ticket_id } = box.enqueue("work", "personal", "hi");
    const waiting = box.waitForAnswer(ticket_id, 1000);
    vi.advanceTimersByTime(1001);
    await expect(waiting).resolves.toEqual({ status: "pending", phase: "queued" });
    box.settle(ticket_id, { answer: "late" });
    expect(box.checkReply(ticket_id)).toEqual({ status: "answered", answer: "late" });
    expect(box.checkReply(ticket_id)).toEqual({ status: "unknown_ticket" });
  });

  it("propagates daemon errors", async () => {
    const box = new Mailbox();
    const { ticket_id } = box.enqueue("work", "personal", "hi");
    box.settle(ticket_id, { error: "cursor-agent failed" });
    expect(box.checkReply(ticket_id)).toEqual({ status: "error", error: "cursor-agent failed" });
  });

  it("drops the oldest question with overflow error past 100 per peer", async () => {
    const box = new Mailbox();
    const first = box.enqueue("work", "personal", "q0");
    for (let i = 1; i <= 100; i++) box.enqueue("work", "personal", `q${i}`);
    expect(box.checkReply(first.ticket_id)).toEqual({ status: "error", error: "overflow" });
  });

  it("expires questions after 24 hours", async () => {
    const box = new Mailbox();
    const { ticket_id } = box.enqueue("work", "personal", "hi");
    vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1);
    box.enqueue("work", "personal", "trigger cleanup");
    const q = await box.takeNext("work", 100);
    expect(q?.question).toBe("trigger cleanup");
    expect(box.checkReply(ticket_id)).toEqual({ status: "error", error: "expired" });
  });

  it("expires a question when checkReply is the next operation", () => {
    const box = new Mailbox();
    const { ticket_id } = box.enqueue("work", "personal", "hi");
    vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1);
    expect(box.checkReply(ticket_id)).toEqual({ status: "error", error: "expired" });
  });

  it("deletes an unconsumed settled entry after its retention window", () => {
    const box = new Mailbox();
    const { ticket_id } = box.enqueue("work", "personal", "hi");
    expect(box.settle(ticket_id, { answer: "42" })).toBe(true);
    vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1);
    box.enqueue("work", "personal", "trigger cleanup");
    expect(box.checkReply(ticket_id)).toEqual({ status: "unknown_ticket" });
  });

  it("waitForAnswer with an already-aborted signal resolves pending without consuming, later settle+checkReply still returns the answer", async () => {
    const box = new Mailbox();
    const { ticket_id } = box.enqueue("work", "personal", "hi");
    const controller = new AbortController();
    controller.abort();
    await expect(box.waitForAnswer(ticket_id, 10_000, controller.signal)).resolves.toEqual({
      status: "pending",
      phase: "queued",
    });
    expect(box.settle(ticket_id, { answer: "42" })).toBe(true);
    expect(box.checkReply(ticket_id)).toEqual({ status: "answered", answer: "42" });
  });

  it("waitForAnswer resolves pending when the signal aborts mid-wait, without consuming the entry", async () => {
    const box = new Mailbox();
    const { ticket_id } = box.enqueue("work", "personal", "hi");
    const controller = new AbortController();
    const waiting = box.waitForAnswer(ticket_id, 10_000, controller.signal);
    controller.abort();
    await expect(waiting).resolves.toEqual({ status: "pending", phase: "queued" });
    expect(box.settle(ticket_id, { answer: "later" })).toBe(true);
    expect(box.checkReply(ticket_id)).toEqual({ status: "answered", answer: "later" });
  });

  it("when one of two waiters aborts, the surviving waiter still gets the answer on settle and single-read semantics hold", async () => {
    const box = new Mailbox();
    const { ticket_id } = box.enqueue("work", "personal", "hi");
    const controller = new AbortController();
    const aborting = box.waitForAnswer(ticket_id, 10_000, controller.signal);
    const surviving = box.waitForAnswer(ticket_id, 10_000);
    controller.abort();
    await expect(aborting).resolves.toEqual({ status: "pending", phase: "queued" });
    expect(box.settle(ticket_id, { answer: "42" })).toBe(true);
    await expect(surviving).resolves.toEqual({ status: "answered", answer: "42" });
    expect(box.checkReply(ticket_id)).toEqual({ status: "unknown_ticket" });
  });

  it("tracks presence from takeNext with a 60 second window", async () => {
    const box = new Mailbox();
    expect(box.isOnline("work")).toBe(false);
    const poll = box.takeNext("work", 100);
    vi.advanceTimersByTime(101);
    await poll;
    expect(box.isOnline("work")).toBe(true);
    vi.advanceTimersByTime(61_000);
    expect(box.isOnline("work")).toBe(false);
  });

  it("tracks known peers from polling", async () => {
    const box = new Mailbox();
    expect(box.knownPeers()).toEqual([]);
    const poll = box.takeNext("work", 100);
    vi.advanceTimersByTime(101);
    await poll;
    expect(box.knownPeers()).toEqual(["work"]);
  });

  it("drops known peers after PEER_RETENTION_MS without a poll", async () => {
    const box = new Mailbox();
    const poll = box.takeNext("ghost", 30_000);
    expect(box.knownPeers()).toEqual(["ghost"]);
    vi.advanceTimersByTime(PEER_RETENTION_MS);
    expect(box.knownPeers()).toEqual([]);
    vi.advanceTimersByTime(30_000);
    await poll;
  });

  it("counts queued questions per peer", () => {
    const box = new Mailbox();
    expect(box.queuedCount("work")).toBe(0);
    box.enqueue("work", "personal", "q1");
    box.enqueue("work", "personal", "q2");
    expect(box.queuedCount("work")).toBe(2);
    expect(box.queuedCount("personal")).toBe(0);
  });

  it("openIncomingCount includes tickets taken from the inbox but not yet settled", async () => {
    const box = new Mailbox();
    box.enqueue("work", "personal", "q1");
    box.enqueue("work", "personal", "q2");
    expect(box.openIncomingCount("work")).toBe(2);
    const taken = await box.takeNext("work", 0);
    expect(taken?.question).toBe("q1");
    expect(box.queuedCount("work")).toBe(1);
    expect(box.openIncomingCount("work")).toBe(2);
    box.settle(taken!.ticket_id, { answer: "done" });
    expect(box.openIncomingCount("work")).toBe(1);
  });

  it("rejects hops beyond MAX_HOPS", () => {
    const box = new Mailbox();
    expect(() => box.enqueue("work", "personal", "q", "conv-1", 2)).toThrow(/counter-question depth/);
  });

  it("rejects a conversation with too many open tickets", () => {
    const box = new Mailbox();
    for (let i = 0; i < 4; i += 1) box.enqueue("work", "personal", `q${i}`, "conv-x");
    expect(() => box.enqueue("work", "personal", "q5", "conv-x")).toThrow(/too many open tickets/);
  });

  it("does not count settled tickets toward the conversation limit", () => {
    const box = new Mailbox();
    const first = box.enqueue("work", "personal", "q", "conv-y");
    box.settle(first.ticket_id, { answer: "42" });
    for (let i = 0; i < 4; i += 1) {
      expect(() => box.enqueue("work", "personal", `q${i}`, "conv-y")).not.toThrow();
    }
  });

  it("derives hops from open inbound tickets even when the client passes hops=0", async () => {
    const box = new Mailbox();
    // A asks B (hops 0). Simulate B taking the question but not yet answering.
    const first = box.enqueue("work", "personal", "hey?", "conv-c");
    expect(first).toBeDefined();
    // B (the peer that owes an answer) sends a counter-question back to A in
    // the same conversation, but "forgets" to bump hops. Server must derive
    // hops = 1 anyway.
    const counter = box.enqueue("personal", "work", "wait, which?", "conv-c", 0);
    const q = await box.takeNext("personal", 1000);
    expect(q?.ticket_id).toBe(counter.ticket_id);
    expect(q?.hops).toBe(1);
  });

  it("blocks a third-level counter-question even if the client claims hops=0", () => {
    const box = new Mailbox();
    box.enqueue("work", "personal", "q1", "conv-d");                   // A -> B, hops 0
    box.enqueue("personal", "work", "counter1", "conv-d", 0);          // B -> A, derived 1
    // A now tries to counter B's counter in the same conversation. Server
    // sees an open inbound entry for A (hops 1), so derived would be 2 > MAX.
    expect(() => box.enqueue("work", "personal", "counter2", "conv-d", 0))
      .toThrow(/counter-question depth/);
  });

  it("lists outgoing tickets with statuses for the asking peer", () => {
    const box = new Mailbox();
    const a = box.enqueue("work", "personal", "q1");
    const b = box.enqueue("work", "personal", "q2");
    const c = box.enqueue("work", "personal", "q3");
    box.settle(b.ticket_id, { answer: "42" });
    box.settle(c.ticket_id, { error: "boom" });
    const out = box.outgoingFor("personal");
    expect(out.map((t) => [t.ticket_id, t.to_peer, t.status])).toEqual([
      [a.ticket_id, "work", "pending"],
      [b.ticket_id, "work", "answered"],
      [c.ticket_id, "work", "error"],
    ]);
    expect(out[0]?.phase).toBe("queued");
    expect(box.outgoingFor("work")).toEqual([]);
  });

  it("marks phase working when takeNext delivers a ticket", async () => {
    const box = new Mailbox();
    const { ticket_id } = box.enqueue("work", "personal", "long question about coffee");
    expect(box.outgoingFor("personal")[0]?.phase).toBe("queued");
    expect(box.incomingFor("work")[0]).toMatchObject({
      ticket_id,
      from_peer: "personal",
      phase: "queued",
      mode: "ask",
    });
    await box.takeNext("work", 0);
    expect(box.outgoingFor("personal")[0]?.phase).toBe("working");
    expect(box.incomingFor("work")[0]?.phase).toBe("working");
    expect(box.checkReply(ticket_id)).toEqual({ status: "pending", phase: "working" });
  });

  it("stores discuss mode and brief on enqueue", async () => {
    const box = new Mailbox();
    const { ticket_id } = box.enqueue("work", "personal", "help?", {
      mode: "discuss",
      brief: "check transcripts first",
    });
    const q = await box.takeNext("work", 0);
    expect(q).toMatchObject({
      ticket_id,
      mode: "discuss",
      brief: "check transcripts first",
    });
    expect(box.incomingFor("work")[0]?.mode).toBe("discuss");
  });

  it("stores validated attachments on enqueue", async () => {
    const box = new Mailbox();
    const { ticket_id } = box.enqueue("work", "personal", "see file", {
      attachments: [{ name: "notes.md", content: "hello" }],
    });
    const q = await box.takeNext("work", 0);
    expect(q).toMatchObject({
      ticket_id,
      attachments: [{ name: "notes.md", content: "hello" }],
    });
  });

  it("rejects invalid attachment names and empty content", () => {
    const box = new Mailbox();
    expect(() =>
      box.enqueue("work", "personal", "x", {
        attachments: [{ name: "../etc/passwd", content: "x" }],
      }),
    ).toThrow(/attachment name/);
    expect(() =>
      box.enqueue("work", "personal", "x", {
        attachments: [{ name: "ok.md", content: "" }],
      }),
    ).toThrow(/must not be empty/);
  });

  it("caps attachment bytes queued for one peer and frees the budget on takeNext", async () => {
    const box = new Mailbox();
    const chunk = "a".repeat(256 * 1024);
    const bigSet = () => [
      { name: "a.txt", content: chunk },
      { name: "b.txt", content: chunk },
    ];
    // 512 KiB per ask, so the 4 MiB per-peer budget fits exactly eight queued asks.
    for (let i = 0; i < 8; i += 1) {
      box.enqueue("work", "personal", `q${i}`, { attachments: bigSet() });
    }
    expect(() =>
      box.enqueue("work", "personal", "one too many", { attachments: bigSet() }),
    ).toThrow(/too many queued attachment bytes/);
    // Questions without attachments are never blocked by the budget.
    expect(() => box.enqueue("work", "personal", "plain")).not.toThrow();
    await box.takeNext("work", 0);
    expect(() => box.enqueue("work", "personal", "now fits", { attachments: bigSet() })).not.toThrow();
  });

  it("skips the queue budget when a responder is already waiting", async () => {
    const box = new Mailbox();
    const chunk = "a".repeat(256 * 1024);
    const pending = box.takeNext("work", 1000);
    box.enqueue("work", "personal", "straight through", {
      attachments: [{ name: "a.txt", content: chunk }],
    });
    const q = await pending;
    expect(q?.attachments).toHaveLength(1);
  });

  it("cancelByOwner and answerByOwner settle only for the assignee", () => {
    const box = new Mailbox();
    const { ticket_id } = box.enqueue("work", "personal", "hi");
    expect(box.cancelByOwner(ticket_id, "personal")).toBe(false);
    expect(box.answerByOwner(ticket_id, "personal", "nope")).toBe(false);
    expect(box.answerByOwner(ticket_id, "work", "  ")).toBe(false);
    expect(box.answerByOwner(ticket_id, "work", "owner says yes")).toBe(true);
    expect(box.checkReply(ticket_id)).toEqual({
      status: "answered",
      answer: "owner says yes",
      answered: "yes",
      refused: "no",
    });
    const again = box.enqueue("work", "personal", "bye");
    expect(box.cancelByOwner(again.ticket_id, "work")).toBe(true);
    expect(box.checkReply(again.ticket_id)).toEqual({
      status: "error",
      error: "cancelled by owner",
    });
  });
});
