import type { DaemonConfig } from "./config.js";
import type { Question } from "./types.js";

export type QuestionHandler = (q: Question) => Promise<{ answer?: string; error?: string }>;

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;
const AUTH_BACKOFF_CAP_MS = 300_000;

export class Poller {
  private backoffMs = INITIAL_BACKOFF_MS;
  private readonly injectedSleep?: (ms: number) => Promise<void>;

  constructor(
    private config: DaemonConfig,
    private handle: QuestionHandler,
    private fetchImpl: typeof fetch = fetch,
    sleep?: (ms: number) => Promise<void>,
  ) {
    this.injectedSleep = sleep;
  }

  async pollOnce(signal?: AbortSignal): Promise<"handled" | "empty" | "retry"> {
    const headers = { authorization: `Bearer ${this.config.token}` };
    let res: Response;
    try {
      res = await this.fetchImpl(
        `${this.config.relay_url}/inbox/${this.config.self_peer}?wait=25`,
        { headers, signal },
      );
    } catch {
      if (signal?.aborted) return "retry";
      await this.backoff(MAX_BACKOFF_MS, signal);
      return "retry";
    }
    if (res.status === 401 || res.status === 403) {
      console.error(`relay rejected the token (HTTP ${res.status}), check config`);
      await this.backoff(AUTH_BACKOFF_CAP_MS, signal);
      return "retry";
    }
    if (res.status === 204) {
      this.backoffMs = INITIAL_BACKOFF_MS;
      return "empty";
    }
    if (!res.ok) {
      await this.backoff(MAX_BACKOFF_MS, signal);
      return "retry";
    }
    let question: Question | undefined;
    try {
      question = (await res.json()) as Question;
      const result = await this.handle(question);
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const answerRes = await this.fetchImpl(`${this.config.relay_url}/answer`, {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({ ticket_id: question.ticket_id, ...result }),
            signal,
          });
          if (answerRes.ok) {
            this.backoffMs = INITIAL_BACKOFF_MS;
            return "handled";
          }
        } catch {
          if (signal?.aborted) return "retry";
        }

        if (attempt < 3) {
          await this.wait(1000, signal);
          if (signal?.aborted) return "retry";
        }
      }

      console.error(`failed to deliver answer for ticket ${question.ticket_id}`);
      await this.backoff(MAX_BACKOFF_MS, signal);
      return "retry";
    } catch {
      if (signal?.aborted) return "retry";
      if (!question) {
        console.error("failed to parse inbox response JSON");
      } else {
        console.error(`failed to handle question or deliver answer for ticket ${question.ticket_id}`);
      }
      await this.backoff(MAX_BACKOFF_MS, signal);
      return "retry";
    }
  }

  async run(signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      await this.pollOnce(signal);
    }
  }

  private async backoff(capMs: number, signal?: AbortSignal): Promise<void> {
    await this.wait(Math.min(this.backoffMs, capMs), signal);
    if (signal?.aborted) return;
    this.backoffMs = Math.min(this.backoffMs * 2, capMs);
  }

  private async wait(ms: number, signal?: AbortSignal): Promise<void> {
    if (this.injectedSleep) {
      if (!signal) {
        await this.injectedSleep(ms);
        return;
      }
      if (signal.aborted) return;

      let onAbort: (() => void) | undefined;
      const aborted = new Promise<void>((resolve) => {
        onAbort = () => resolve();
        signal.addEventListener("abort", onAbort, { once: true });
      });

      try {
        await Promise.race([this.injectedSleep(ms), aborted]);
      } finally {
        if (onAbort) signal.removeEventListener("abort", onAbort);
      }
      return;
    }

    await this.sleepWithTimer(ms, signal);
  }

  private sleepWithTimer(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }
    if (signal.aborted) return Promise.resolve();

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        cleanup();
        resolve();
      };
      const cleanup = () => signal.removeEventListener("abort", onAbort);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
