import { describe, expect, it, vi } from "vitest";
import { fetchStatus, joinRelay, normalizeRelayUrl, requestInvite } from "../src/api.js";

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
