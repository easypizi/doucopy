import type { DaemonConfig } from "./config.js";
import type { Question } from "./types.js";

export type QuestionHandler = (q: Question) => Promise<{ answer?: string; error?: string }>;

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;
const AUTH_BACKOFF_CAP_MS = 300_000;

export class Poller {
  private backoffMs = INITIAL_BACKOFF_MS;

  constructor(
    private config: DaemonConfig,
    private handle: QuestionHandler,
    private fetchImpl: typeof fetch = fetch,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  async pollOnce(): Promise<"handled" | "empty" | "retry"> {
    const headers = { authorization: `Bearer ${this.config.token}` };
    let res: Response;
    try {
      res = await this.fetchImpl(
        `${this.config.relay_url}/inbox/${this.config.self_peer}?wait=25`,
        { headers },
      );
    } catch {
      await this.backoff(MAX_BACKOFF_MS);
      return "retry";
    }
    if (res.status === 401 || res.status === 403) {
      console.error(`relay rejected the token (HTTP ${res.status}), check config`);
      await this.backoff(AUTH_BACKOFF_CAP_MS);
      return "retry";
    }
    if (res.status === 204) {
      this.backoffMs = INITIAL_BACKOFF_MS;
      return "empty";
    }
    if (!res.ok) {
      await this.backoff(MAX_BACKOFF_MS);
      return "retry";
    }
    this.backoffMs = INITIAL_BACKOFF_MS;
    const question = (await res.json()) as Question;
    const result = await this.handle(question);
    await this.fetchImpl(`${this.config.relay_url}/answer`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ ticket_id: question.ticket_id, ...result }),
    });
    return "handled";
  }

  async run(signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      await this.pollOnce();
    }
  }

  private async backoff(capMs: number): Promise<void> {
    await this.sleep(Math.min(this.backoffMs, capMs));
    this.backoffMs = Math.min(this.backoffMs * 2, capMs);
  }
}
