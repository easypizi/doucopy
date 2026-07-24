import { describe, expect, it, vi } from "vitest";
import type { DaemonConfig } from "../src/config.js";
import { Poller } from "../src/poller.js";

const CONFIG: DaemonConfig = {
  relay_url: "https://relay.test",
  self_peer: "work",
  token: "tok",
  memory_sources: { transcripts_glob: "", agents_md_roots: [], extra_files: [] },
  responder: {
    cursor_agent_binary: "cursor-agent",
    workspace_dir: "/tmp/ws",
    response_timeout_seconds: 300,
  },
};

const QUESTION = {
  ticket_id: "t-1",
  from_peer: "personal",
  question: "hi",
  conversation_id: "c-1",
  created_at: 0,
  deadline: 1,
};

describe("Poller", () => {
  it("handles a question and posts the answer", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/inbox/")) {
        return new Response(JSON.stringify(QUESTION), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const handle = vi.fn(async () => ({ answer: "42" }));
    const poller = new Poller(CONFIG, handle, fetchImpl, async () => undefined);
    await expect(poller.pollOnce()).resolves.toBe("handled");

    expect(handle).toHaveBeenCalledWith(QUESTION);
    expect(calls[0].url).toBe("https://relay.test/inbox/work?wait=25");
    expect(calls[0].init?.headers).toMatchObject({ authorization: "Bearer tok" });
    expect(calls[1].url).toBe("https://relay.test/answer");
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ ticket_id: "t-1", answer: "42" });
  });

  it("returns empty on 204 without calling the handler", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const handle = vi.fn();
    const poller = new Poller(CONFIG, handle, fetchImpl, async () => undefined);
    await expect(poller.pollOnce()).resolves.toBe("empty");
    expect(handle).not.toHaveBeenCalled();
  });

  it("backs off exponentially on network errors", async () => {
    const sleeps: number[] = [];
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const poller = new Poller(CONFIG, vi.fn(), fetchImpl, async (ms) => {
      sleeps.push(ms);
    });
    await poller.pollOnce();
    await poller.pollOnce();
    await poller.pollOnce();
    expect(sleeps).toEqual([1000, 2000, 4000]);
  });

  it("uses a long backoff on 401", async () => {
    const sleeps: number[] = [];
    const fetchImpl = vi.fn(async () => new Response(null, { status: 401 })) as unknown as typeof fetch;
    const poller = new Poller(CONFIG, vi.fn(), fetchImpl, async (ms) => {
      sleeps.push(ms);
    });
    for (let i = 0; i < 10; i++) await poller.pollOnce();
    expect(sleeps[sleeps.length - 1]).toBe(300_000);
  });
});
