import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTokenService } from "../src/auth.js";
import { Mailbox } from "../src/mailbox.js";
import { registerRest } from "../src/rest.js";

const SECRET = "test-secret-0123456789abcdef";

function makeApp() {
  const tokens = createTokenService(SECRET);
  const mailbox = new Mailbox();
  const app = Fastify();
  registerRest(app, mailbox, tokens);
  return {
    app,
    mailbox,
    tokens,
    personalToken: tokens.issuePeerToken("personal"),
    workToken: tokens.issuePeerToken("work"),
  };
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
      headers: { authorization: `Bearer ${ctx.personalToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns 204 when the inbox is empty", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/inbox/work?wait=0",
      headers: { authorization: `Bearer ${ctx.workToken}` },
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
        headers: { authorization: `Bearer ${ctx.workToken}` },
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
      headers: { authorization: `Bearer ${ctx.workToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ticket_id, question: "hi" });

    const answered = await ctx.app.inject({
      method: "POST",
      url: "/answer",
      headers: { authorization: `Bearer ${ctx.workToken}` },
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
      headers: { authorization: `Bearer ${ctx.workToken}` },
      payload: { answer: "42" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an answer from the wrong peer without settling the ticket", async () => {
    const { ticket_id } = ctx.mailbox.enqueue("work", "personal", "hi");
    const wrongPeer = await ctx.app.inject({
      method: "POST",
      url: "/answer",
      headers: { authorization: `Bearer ${ctx.personalToken}` },
      payload: { ticket_id, answer: "wrong" },
    });
    expect(wrongPeer.statusCode).toBe(404);
    expect(wrongPeer.json()).toEqual({ error: "unknown_ticket" });

    const rightPeer = await ctx.app.inject({
      method: "POST",
      url: "/answer",
      headers: { authorization: `Bearer ${ctx.workToken}` },
      payload: { ticket_id, answer: "right" },
    });
    expect(rightPeer.statusCode).toBe(200);
    expect(ctx.mailbox.checkReply(ticket_id)).toEqual({ status: "answered", answer: "right" });
  });

  it("returns 404 for an unknown ticket", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/answer",
      headers: { authorization: `Bearer ${ctx.workToken}` },
      payload: { ticket_id: "nope", answer: "42" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /join", () => {
  it("issues a token for a valid invite and name", async () => {
    const ctx = makeApp();
    const { invite } = ctx.tokens.issueInvite(1);
    const res = await ctx.app.inject({
      method: "POST",
      url: "/join",
      payload: { invite, name: "new-machine" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { token: string; peer: string };
    expect(body.peer).toBe("new-machine");
    expect(ctx.tokens.verifyPeerToken(body.token)).toBe("new-machine");
  });

  it("rejects a bad invite, a bad name and an online name", async () => {
    const ctx = makeApp();
    const { invite } = ctx.tokens.issueInvite(1);
    const bad = await ctx.app.inject({
      method: "POST", url: "/join", payload: { invite: "ali1.1.x.y", name: "ok" },
    });
    expect(bad.statusCode).toBe(403);
    const badName = await ctx.app.inject({
      method: "POST", url: "/join", payload: { invite, name: "has space" },
    });
    expect(badName.statusCode).toBe(400);
    await ctx.mailbox.takeNext("taken", 0);
    const taken = await ctx.app.inject({
      method: "POST", url: "/join", payload: { invite, name: "taken" },
    });
    expect(taken.statusCode).toBe(409);
  });

  it("rate limits repeated join attempts from one address", async () => {
    const ctx = makeApp();
    let lastStatus = 0;
    for (let i = 0; i < 11; i += 1) {
      const res = await ctx.app.inject({
        method: "POST", url: "/join", payload: { invite: "junk", name: "x" },
      });
      lastStatus = res.statusCode;
    }
    expect(lastStatus).toBe(429);
  });
});

describe("POST /invite", () => {
  it("returns a verifiable invite to an authenticated peer", async () => {
    const ctx = makeApp();
    const res = await ctx.app.inject({
      method: "POST",
      url: "/invite",
      headers: { authorization: `Bearer ${ctx.personalToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { invite: string; expires_at: number };
    expect(ctx.tokens.verifyInvite(body.invite)).toBe(true);
  });

  it("rejects unauthenticated calls and bad ttl", async () => {
    const ctx = makeApp();
    const noAuth = await ctx.app.inject({ method: "POST", url: "/invite", payload: {} });
    expect(noAuth.statusCode).toBe(401);
    const badTtl = await ctx.app.inject({
      method: "POST",
      url: "/invite",
      headers: { authorization: `Bearer ${ctx.personalToken}` },
      payload: { ttl_hours: -5 },
    });
    expect(badTtl.statusCode).toBe(400);
  });
});

describe("POST /ask + GET /reply", () => {
  it("rejects unauthenticated ask", async () => {
    const ctx = makeApp();
    const res = await ctx.app.inject({
      method: "POST",
      url: "/ask",
      payload: { peer: "work", question: "hi" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects asking yourself", async () => {
    const ctx = makeApp();
    const res = await ctx.app.inject({
      method: "POST",
      url: "/ask",
      headers: { authorization: `Bearer ${ctx.personalToken}` },
      payload: { peer: "personal", question: "hi" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "cannot ask yourself" });
  });

  it("returns peer_offline immediately when the responder never polled", async () => {
    const ctx = makeApp();
    const res = await ctx.app.inject({
      method: "POST",
      url: "/ask",
      headers: { authorization: `Bearer ${ctx.personalToken}` },
      payload: { peer: "work", question: "hey?", wait_seconds: 0 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; ticket_id: string; conversation_id: string };
    expect(body.status).toBe("peer_offline");
    expect(body.ticket_id).toBeTruthy();
    expect(body.conversation_id).toBeTruthy();
  });

  it("returns answered when the responder answers before the wait window ends", async () => {
    const ctx = makeApp();
    await ctx.mailbox.takeNext("work", 0);
    const asking = ctx.app.inject({
      method: "POST",
      url: "/ask",
      headers: { authorization: `Bearer ${ctx.personalToken}` },
      payload: { peer: "work", question: "hey?", wait_seconds: 5 },
    });
    // Race: settle the ticket as soon as it appears in the inbox.
    const question = await ctx.mailbox.takeNext("work", 5000);
    expect(question?.question).toBe("hey?");
    if (question) ctx.mailbox.settle(question.ticket_id, { answer: "42" });
    const res = await asking;
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "answered", answer: "42" });
  });

  it("GET /reply returns pending until the ticket is settled, then answered, then unknown_ticket", async () => {
    const ctx = makeApp();
    await ctx.mailbox.takeNext("work", 0);
    const enqueued = ctx.mailbox.enqueue("work", "personal", "hey?");
    const pending = await ctx.app.inject({
      method: "GET",
      url: `/reply/${enqueued.ticket_id}?wait=0`,
      headers: { authorization: `Bearer ${ctx.personalToken}` },
    });
    expect(pending.json()).toMatchObject({ status: "pending", ticket_id: enqueued.ticket_id });
    ctx.mailbox.settle(enqueued.ticket_id, { answer: "hi back" });
    const done = await ctx.app.inject({
      method: "GET",
      url: `/reply/${enqueued.ticket_id}?wait=0`,
      headers: { authorization: `Bearer ${ctx.personalToken}` },
    });
    expect(done.json()).toMatchObject({ status: "answered", answer: "hi back" });
    const gone = await ctx.app.inject({
      method: "GET",
      url: `/reply/${enqueued.ticket_id}?wait=0`,
      headers: { authorization: `Bearer ${ctx.personalToken}` },
    });
    expect(gone.json()).toMatchObject({ status: "unknown_ticket" });
  });

  it("GET /reply with wait>0 long-polls and unblocks on settle", async () => {
    const ctx = makeApp();
    await ctx.mailbox.takeNext("work", 0);
    const enqueued = ctx.mailbox.enqueue("work", "personal", "hey?");
    const waiting = ctx.app.inject({
      method: "GET",
      url: `/reply/${enqueued.ticket_id}?wait=5`,
      headers: { authorization: `Bearer ${ctx.personalToken}` },
    });
    setTimeout(() => ctx.mailbox.settle(enqueued.ticket_id, { answer: "late" }), 50);
    const res = await waiting;
    expect(res.json()).toMatchObject({ status: "answered", answer: "late" });
  });

  it("rejects an out-of-range hops on /ask", async () => {
    const ctx = makeApp();
    const res = await ctx.app.inject({
      method: "POST",
      url: "/ask",
      headers: { authorization: `Bearer ${ctx.personalToken}` },
      payload: { peer: "work", question: "q", hops: 2 },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /status", () => {
  it("reports presence, queue depth and outgoing tickets", async () => {
    const ctx = makeApp();
    await ctx.mailbox.takeNext("work", 0);
    const { ticket_id } = ctx.mailbox.enqueue("work", "personal", "hi");
    const res = await ctx.app.inject({
      method: "GET",
      url: "/status",
      headers: { authorization: `Bearer ${ctx.personalToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      self: "personal",
      self_online: false,
      peers: [{ name: "work", online: true }],
      incoming_queued: 0,
      outgoing: [{ ticket_id, to_peer: "work", status: "pending" }],
    });
  });

  it("counts incoming as open (queued or taken) until the responder settles", async () => {
    const ctx = makeApp();
    const { ticket_id } = ctx.mailbox.enqueue("work", "personal", "hi");
    const taken = await ctx.mailbox.takeNext("work", 0);
    expect(taken?.ticket_id).toBe(ticket_id);
    const whileWorking = await ctx.app.inject({
      method: "GET",
      url: "/status",
      headers: { authorization: `Bearer ${ctx.workToken}` },
    });
    expect(whileWorking.json()).toMatchObject({
      incoming_queued: 1,
      incoming: [{ ticket_id, from_peer: "personal", phase: "working" }],
    });
    ctx.mailbox.settle(ticket_id, { answer: "ok" }, "work");
    const after = await ctx.app.inject({
      method: "GET",
      url: "/status",
      headers: { authorization: `Bearer ${ctx.workToken}` },
    });
    expect(after.json()).toMatchObject({ incoming_queued: 0, incoming: [] });
  });
});

describe("POST /ticket/:id cancel and answer", () => {
  it("lets the assignee cancel or answer manually", async () => {
    const ctx = makeApp();
    const { ticket_id } = ctx.mailbox.enqueue("work", "personal", "hi");
    const forbidden = await ctx.app.inject({
      method: "POST",
      url: `/ticket/${ticket_id}/cancel`,
      headers: { authorization: `Bearer ${ctx.personalToken}` },
    });
    expect(forbidden.statusCode).toBe(404);

    const answered = await ctx.app.inject({
      method: "POST",
      url: `/ticket/${ticket_id}/answer`,
      headers: { authorization: `Bearer ${ctx.workToken}` },
      payload: { answer: "I got this" },
    });
    expect(answered.statusCode).toBe(200);
    expect(ctx.mailbox.checkReply(ticket_id)).toMatchObject({
      status: "answered",
      answer: "I got this",
    });

    const other = ctx.mailbox.enqueue("work", "personal", "next");
    const cancelled = await ctx.app.inject({
      method: "POST",
      url: `/ticket/${other.ticket_id}/cancel`,
      headers: { authorization: `Bearer ${ctx.workToken}` },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(ctx.mailbox.checkReply(other.ticket_id)).toEqual({
      status: "error",
      error: "cancelled by owner",
    });
  });
});

describe("POST /ask discuss mode", () => {
  it("accepts mode=discuss and brief", async () => {
    const ctx = makeApp();
    await ctx.mailbox.takeNext("work", 0);
    const res = await ctx.app.inject({
      method: "POST",
      url: "/ask",
      headers: { authorization: `Bearer ${ctx.personalToken}` },
      payload: {
        peer: "work",
        question: "collaborate?",
        wait_seconds: 0,
        mode: "discuss",
        brief: "keep it short",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ticket_id: string; status: string };
    expect(body.status).toBe("pending");
    const q = await ctx.mailbox.takeNext("work", 0);
    expect(q).toMatchObject({ mode: "discuss", brief: "keep it short", question: "collaborate?" });
  });

  it("accepts attachments and rejects bad names with 400", async () => {
    const ctx = makeApp();
    await ctx.mailbox.takeNext("work", 0);
    const ok = await ctx.app.inject({
      method: "POST",
      url: "/ask",
      headers: { authorization: `Bearer ${ctx.personalToken}` },
      payload: {
        peer: "work",
        question: "read this",
        wait_seconds: 0,
        attachments: [{ name: "snippet.ts", content: "const x = 1;" }],
      },
    });
    expect(ok.statusCode).toBe(200);
    const q = await ctx.mailbox.takeNext("work", 0);
    expect(q?.attachments).toEqual([{ name: "snippet.ts", content: "const x = 1;" }]);

    const bad = await ctx.app.inject({
      method: "POST",
      url: "/ask",
      headers: { authorization: `Bearer ${ctx.personalToken}` },
      payload: {
        peer: "work",
        question: "nope",
        wait_seconds: 0,
        attachments: [{ name: "../secret", content: "x" }],
      },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ status: "error" });
  });
});
