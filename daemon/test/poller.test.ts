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
    await poller.drain();

    expect(handle).toHaveBeenCalledWith(QUESTION);
    expect(calls[0].url).toBe("https://relay.test/inbox/work?wait=25");
    expect(calls[0].init?.headers).toMatchObject({ authorization: "Bearer tok" });
    expect(calls[1].url).toBe("https://relay.test/answer");
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ ticket_id: "t-1", answer: "42" });
  });

  it("delivers an error payload when the handler throws", async () => {
    const posted: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes("/inbox/")) {
        return new Response(JSON.stringify(QUESTION), { status: 200 });
      }
      posted.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const handle = vi.fn(async () => {
      throw new Error("handler failed");
    });
    const poller = new Poller(CONFIG, handle, fetchImpl, async () => undefined);

    await expect(poller.pollOnce()).resolves.toBe("handled");
    await poller.drain();
    expect(posted).toHaveLength(1);
    const body = JSON.parse(posted[0]) as { ticket_id: string; error?: string };
    expect(body.ticket_id).toBe("t-1");
    expect(body.error).toMatch(/handler crashed: handler failed/);
  });

  it("retries the answer delivery three times before giving up", async () => {
    let postAttempts = 0;
    const fetchImpl = vi.fn(async (url: string | URL) => {
      if (String(url).includes("/inbox/")) {
        return new Response(JSON.stringify(QUESTION), { status: 200 });
      }
      postAttempts += 1;
      return new Response(null, { status: 500 });
    }) as unknown as typeof fetch;
    const poller = new Poller(CONFIG, vi.fn(async () => ({ answer: "42" })), fetchImpl, async () => undefined);

    await expect(poller.pollOnce()).resolves.toBe("handled");
    await poller.drain();
    expect(postAttempts).toBe(3);
  });

  it("stops retrying after a 404 on the answer POST (permanent failure)", async () => {
    let postAttempts = 0;
    const fetchImpl = vi.fn(async (url: string | URL) => {
      if (String(url).includes("/inbox/")) {
        return new Response(JSON.stringify(QUESTION), { status: 200 });
      }
      postAttempts += 1;
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;
    const poller = new Poller(CONFIG, vi.fn(async () => ({ answer: "42" })), fetchImpl, async () => undefined);

    await expect(poller.pollOnce()).resolves.toBe("handled");
    await poller.drain();
    expect(postAttempts).toBe(1);
  });

  it("succeeds when answer delivery works on the third attempt", async () => {
    let postAttempts = 0;
    const fetchImpl = vi.fn(async (url: string | URL) => {
      if (String(url).includes("/inbox/")) {
        return new Response(JSON.stringify(QUESTION), { status: 200 });
      }
      postAttempts += 1;
      return new Response(null, { status: postAttempts < 3 ? 500 : 200 });
    }) as unknown as typeof fetch;
    const poller = new Poller(CONFIG, vi.fn(async () => ({ answer: "42" })), fetchImpl, async () => undefined);

    await expect(poller.pollOnce()).resolves.toBe("handled");
    await poller.drain();
    expect(postAttempts).toBe(3);
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

  it("backs off exponentially on inbox server errors", async () => {
    const sleeps: number[] = [];
    const fetchImpl = vi.fn(async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
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

  it("clears backoff timer when aborted mid-wait", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const fetchImpl = vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch;
      const poller = new Poller(CONFIG, vi.fn(), fetchImpl);

      const pollPromise = poller.pollOnce(controller.signal);
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await expect(pollPromise).resolves.toBe("retry");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops run without throwing when an in-flight fetch is aborted", async () => {
    const controller = new AbortController();
    const signals: Array<AbortSignal | null | undefined> = [];
    const fetchImpl = vi.fn((_url: string | URL, init?: RequestInit) => {
      signals.push(init?.signal);
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error("missing abort signal"));
          return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }) as unknown as typeof fetch;
    const poller = new Poller(CONFIG, vi.fn(), fetchImpl, async () => undefined);

    const runPromise = poller.run(controller.signal);
    controller.abort(new Error("stopped"));

    await expect(runPromise).resolves.toBeUndefined();
    expect(signals).toEqual([controller.signal]);
  });

  it("handles up to max_concurrent questions in parallel and then blocks", async () => {
    const config = {
      ...CONFIG,
      responder: { ...CONFIG.responder, max_concurrent: 2 },
    };
    let questionNo = 0;
    const fetchImpl = vi.fn(async (url: string | URL) => {
      if (String(url).includes("/inbox/")) {
        questionNo += 1;
        return new Response(
          JSON.stringify({ ...QUESTION, ticket_id: `t-${questionNo}`, conversation_id: `c-${questionNo}` }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const resolvers: Array<() => void> = [];
    const handle = vi.fn(
      () =>
        new Promise<{ answer?: string }>((resolve) => {
          resolvers.push(() => resolve({ answer: "ok" }));
        }),
    );
    const poller = new Poller(config, handle, fetchImpl, async () => undefined);

    await expect(poller.pollOnce()).resolves.toBe("handled");
    await expect(poller.pollOnce()).resolves.toBe("handled");
    expect(handle).toHaveBeenCalledTimes(2);

    let thirdSettled = false;
    const third = poller.pollOnce().then((r) => {
      thirdSettled = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(thirdSettled).toBe(false);
    expect(handle).toHaveBeenCalledTimes(2);

    resolvers[0]();
    await expect(third).resolves.toBe("handled");
    expect(handle).toHaveBeenCalledTimes(3);

    resolvers[1]();
    resolvers[2]();
    await poller.drain();
  });
});
