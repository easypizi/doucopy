import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadPeersFromEnv } from "../src/auth.js";
import { Mailbox } from "../src/mailbox.js";
import { registerRest } from "../src/rest.js";

function makeApp() {
  const registry = loadPeersFromEnv({
    PEER_TOKEN_PERSONAL: "tok-personal",
    PEER_TOKEN_WORK: "tok-work",
  } as NodeJS.ProcessEnv);
  const mailbox = new Mailbox();
  const app = Fastify();
  registerRest(app, mailbox, registry);
  return { app, mailbox };
}

describe("REST endpoints", () => {
  let ctx: ReturnType<typeof makeApp>;
  beforeEach(() => {
    ctx = makeApp();
  });

  it("GET /health responds ok without auth", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("rejects inbox access without a valid token", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/inbox/work?wait=0" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects polling someone else's inbox", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/inbox/work?wait=0",
      headers: { authorization: "Bearer tok-personal" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns 204 when the inbox is empty", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/inbox/work?wait=0",
      headers: { authorization: "Bearer tok-work" },
    });
    expect(res.statusCode).toBe(204);
  });

  it.each([
    { wait: "-5", expectedMs: 0 },
    { wait: "100", expectedMs: 25000 },
    { wait: "abc", expectedMs: 25000 },
  ])("clamps inbox wait=$wait to $expectedMs ms for takeNext", async ({ wait, expectedMs }) => {
    const usingFakeTimers = expectedMs > 0;
    if (usingFakeTimers) vi.useFakeTimers();
    try {
      const takeNextSpy = vi.spyOn(ctx.mailbox, "takeNext");
      const resPromise = ctx.app.inject({
        method: "GET",
        url: `/inbox/work?wait=${wait}`,
        headers: { authorization: "Bearer tok-work" },
      });
      if (usingFakeTimers) await vi.advanceTimersByTimeAsync(expectedMs);
      const res = await resPromise;
      expect(res.statusCode).toBe(204);
      expect(takeNextSpy).toHaveBeenCalledOnce();
      expect(takeNextSpy).toHaveBeenCalledWith("work", expectedMs);
      takeNextSpy.mockRestore();
    } finally {
      if (usingFakeTimers) vi.useRealTimers();
    }
  });

  it("returns a queued question and accepts the answer", async () => {
    const { ticket_id } = ctx.mailbox.enqueue("work", "personal", "hi");
    const res = await ctx.app.inject({
      method: "GET",
      url: "/inbox/work?wait=0",
      headers: { authorization: "Bearer tok-work" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ticket_id, question: "hi" });

    const answered = await ctx.app.inject({
      method: "POST",
      url: "/answer",
      headers: { authorization: "Bearer tok-work" },
      payload: { ticket_id, answer: "42" },
    });
    expect(answered.statusCode).toBe(200);
    expect(ctx.mailbox.checkReply(ticket_id)).toEqual({ status: "answered", answer: "42" });
  });

  it("rejects answer without a valid token", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/answer",
      payload: { ticket_id: "x", answer: "42" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("requires ticket_id when answering", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/answer",
      headers: { authorization: "Bearer tok-work" },
      payload: { answer: "42" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an answer from the wrong peer without settling the ticket", async () => {
    const { ticket_id } = ctx.mailbox.enqueue("work", "personal", "hi");
    const wrongPeer = await ctx.app.inject({
      method: "POST",
      url: "/answer",
      headers: { authorization: "Bearer tok-personal" },
      payload: { ticket_id, answer: "wrong" },
    });
    expect(wrongPeer.statusCode).toBe(404);
    expect(wrongPeer.json()).toEqual({ error: "unknown_ticket" });

    const rightPeer = await ctx.app.inject({
      method: "POST",
      url: "/answer",
      headers: { authorization: "Bearer tok-work" },
      payload: { ticket_id, answer: "right" },
    });
    expect(rightPeer.statusCode).toBe(200);
    expect(ctx.mailbox.checkReply(ticket_id)).toEqual({ status: "answered", answer: "right" });
  });

  it("returns 404 for an unknown ticket", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/answer",
      headers: { authorization: "Bearer tok-work" },
      payload: { ticket_id: "nope", answer: "42" },
    });
    expect(res.statusCode).toBe(404);
  });
});
