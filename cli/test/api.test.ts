import { describe, expect, it, vi } from "vitest";
import { askPeer, fetchReply, fetchStatus, joinRelay, normalizeRelayUrl, requestInvite } from "../src/api.js";

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), { status }),
  ) as unknown as typeof fetch;
}

describe("normalizeRelayUrl", () => {
  it("strips trailing slashes", () => {
    expect(normalizeRelayUrl("https://r.example.com///")).toBe("https://r.example.com");
  });
});

describe("joinRelay", () => {
  it("posts invite and name and returns the token", async () => {
    const fetchImpl = fakeFetch(200, { token: "al1.x.y", peer: "mbp" });
    const result = await joinRelay("https://r.example.com/", "ali1.1.n.s", "mbp", fetchImpl);
    expect(result).toEqual({ token: "al1.x.y", peer: "mbp" });
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://r.example.com/join");
    expect(JSON.parse(String(init.body))).toEqual({ invite: "ali1.1.n.s", name: "mbp" });
  });

  it("surfaces the relay error message", async () => {
    const fetchImpl = fakeFetch(403, { error: "invalid or expired invite" });
    await expect(joinRelay("https://r.example.com", "bad", "mbp", fetchImpl)).rejects.toThrow(
      /invalid or expired invite/,
    );
  });
});

describe("requestInvite and fetchStatus", () => {
  it("sends the bearer token", async () => {
    const fetchImpl = fakeFetch(200, { invite: "ali1.1.n.s", expires_at: 1 });
    await requestInvite("https://r.example.com", "tok", 24, fetchImpl);
    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  it("fetches status", async () => {
    const status = {
      self: "mbp", self_online: true, peers: [], incoming_queued: 0, outgoing: [],
    };
    const fetchImpl = fakeFetch(200, status);
    await expect(fetchStatus("https://r.example.com", "tok", fetchImpl)).resolves.toEqual(status);
  });
});

describe("askPeer", () => {
  it("POSTs to /ask with bearer token and returns the parsed body", async () => {
    const body = { status: "answered", ticket_id: "t1", conversation_id: "c1", answer: "42" };
    const fetchImpl = fakeFetch(200, body);
    const res = await askPeer(
      "https://r.example.com/",
      "tok",
      { peer: "work", question: "q?", wait_seconds: 10, conversation_id: "c1", hops: 1 },
      fetchImpl,
    );
    expect(res).toEqual(body);
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://r.example.com/ask");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(JSON.parse(String(init.body))).toEqual({
      peer: "work", question: "q?", wait_seconds: 10, conversation_id: "c1", hops: 1,
    });
  });

  it("surfaces relay error strings", async () => {
    const fetchImpl = fakeFetch(400, { error: "cannot ask yourself" });
    await expect(
      askPeer("https://r.example.com", "tok", { peer: "self", question: "?" }, fetchImpl),
    ).rejects.toThrow(/cannot ask yourself/);
  });
});

describe("fetchReply", () => {
  it("GETs /reply/:ticket with the wait query", async () => {
    const fetchImpl = fakeFetch(200, { status: "pending", ticket_id: "t1" });
    await fetchReply("https://r.example.com", "tok", "t1", 5, fetchImpl);
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://r.example.com/reply/t1?wait=5");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  it("url-encodes the ticket id", async () => {
    const fetchImpl = fakeFetch(200, { status: "pending", ticket_id: "a/b" });
    await fetchReply("https://r.example.com", "tok", "a/b", 0, fetchImpl);
    const [url] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe("https://r.example.com/reply/a%2Fb?wait=0");
  });
});
