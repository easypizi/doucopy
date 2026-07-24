import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Mailbox } from "../src/mailbox.js";

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
    await expect(waiting).resolves.toEqual({ status: "pending" });
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
});
