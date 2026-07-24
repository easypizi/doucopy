# agent-link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two Cursor accounts talk to each other: an agent on one machine asks a question through a cloud MCP relay, a responder daemon on the other machine runs `cursor-agent` against local memory (chat transcripts, AGENTS.md) and sends the answer back.

**Architecture:** A single Heroku app serves both a remote MCP server (tools `list_peers`, `ask_peer`, `check_reply`) and a REST mailbox for daemons (long-poll inbox, post answer). Each machine runs the same responder daemon under launchd. Multi-turn conversations map `conversation_id` to a `cursor-agent` chat session resumed with `--resume`.

**Tech Stack:** Node.js 22, TypeScript (strict, ESM), Fastify, `@modelcontextprotocol/sdk`, `zod`, `uuid` (v7), `fast-glob`, Vitest. Spec: `docs/superpowers/specs/2026-07-23-agent-link-design.md`.

## Global Constraints

- Node.js `22.x`, `"type": "module"` everywhere, TypeScript `strict: true`.
- Comments and identifiers in code are English-only. No Cyrillic in code or filenames.
- No TODOs or placeholders in shipped code.
- Git: NEVER run `git commit` or `git push` without the user's explicit go-ahead. At every Commit step below, stop and ask the user first (their standing rule overrides plan automation).
- Relay holds all state in memory. TTL for questions and pending answers: 24 hours. Inbox limit: 100 per peer. Peer counts as online if it polled within the last 60 seconds.
- `ask_peer` default timeout 120 s, hard cap 240 s. Daemon long-poll wait: 25 s (below the 30 s Heroku router limit). MCP keepalive notification every 15 s while waiting.
- Responder `cursor-agent` timeout: 300 s. Model comes only from the responder's local config.
- Decision locked here (was an open question in the spec): the responder runs with `--force` so it can read transcripts outside the workspace without interactive approval. Sandbox stays at default.

---

## File Structure

```
package.json                  root, npm workspaces [relay, daemon]
tsconfig.base.json            shared strict TS config
vitest.config.ts              runs relay/test and daemon/test
Procfile                      Heroku: web = relay
relay/
  package.json  tsconfig.json
  src/types.ts                Question and answer payload types
  src/auth.ts                 PEER_TOKEN_* env parsing, token -> peer lookup
  src/mailbox.ts              inbox queues, pending answers, TTL, presence
  src/rest.ts                 GET /inbox/:peer, POST /answer, GET /health
  src/mcp.ts                  MCP server with the three tools
  src/index.ts                Fastify bootstrap, POST /mcp endpoint
  test/auth.test.ts  test/mailbox.test.ts  test/rest.test.ts  test/mcp.test.ts
daemon/
  package.json  tsconfig.json
  src/types.ts                daemon-local Question shape
  src/config.ts               ~/.agent-link/config.json loader
  src/conversations.ts        conversation_id -> chatId store (JSON file)
  src/prompt.ts               task.md builders (first turn / follow-up)
  src/runner.ts               spawn cursor-agent (create-chat, run task)
  src/poller.ts               long-poll loop with backoff
  src/handler.ts              wires store + prompt + runner into a handler
  src/index.ts                entry point
  launchd/com.agent-link.responder.plist
  test/config.test.ts  test/conversations.test.ts  test/prompt.test.ts
  test/runner.test.ts  test/poller.test.ts  test/integration.test.ts
  test/fixtures/fake-cursor-agent.sh
scripts/install-daemon.sh     launchd install for the responder
```

---

### Task 1: Workspace scaffolding

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `vitest.config.ts`, `.gitignore`
- Create: `relay/package.json`, `relay/tsconfig.json`
- Create: `daemon/package.json`, `daemon/tsconfig.json`

**Interfaces:**
- Produces: a repo where `npm test` runs Vitest over `relay/test` and `daemon/test`, and `npm run build` compiles both packages with `tsc`.

- [ ] **Step 1: Create root files**

`package.json`:

```json
{
  "name": "agent-link",
  "private": true,
  "type": "module",
  "engines": { "node": "22.x" },
  "workspaces": ["relay", "daemon"],
  "scripts": {
    "build": "npm run build --workspaces",
    "test": "vitest run"
  }
}
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true
  }
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["relay/test/**/*.test.ts", "daemon/test/**/*.test.ts"],
  },
});
```

`.gitignore`:

```
node_modules/
dist/
*.log
```

- [ ] **Step 2: Create package manifests**

`relay/package.json`:

```json
{
  "name": "relay",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js"
  }
}
```

`relay/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

`daemon/package.json`:

```json
{
  "name": "daemon",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js"
  }
}
```

`daemon/tsconfig.json`: same content as `relay/tsconfig.json`.

- [ ] **Step 3: Install dependencies (latest versions via npm)**

```bash
npm install -D typescript vitest @types/node
npm install fastify @modelcontextprotocol/sdk zod uuid -w relay
npm install fast-glob -w daemon
```

- [ ] **Step 4: Verify toolchain**

Create `relay/test/smoke.test.ts`:

```ts
import { expect, it } from "vitest";

it("toolchain works", () => {
  expect(1 + 1).toBe(2);
});
```

Run: `npm test`
Expected: 1 test passes.

Delete `relay/test/smoke.test.ts` after the run.

- [ ] **Step 5: Commit (ask the user first)**

```bash
git add -A
git commit -m "chore: scaffold agent-link workspaces (relay, daemon)"
```

---

### Task 2: Relay auth module

**Files:**
- Create: `relay/src/auth.ts`
- Test: `relay/test/auth.test.ts`

**Interfaces:**
- Produces: `loadPeersFromEnv(env): PeerRegistry` where `PeerRegistry = { peers(): string[]; peerForToken(token: string): string | null }`, and `bearerToken(header: string | undefined): string | null`. Peer names come from `PEER_TOKEN_<NAME>` env vars, lowercased.

- [ ] **Step 1: Write the failing test**

`relay/test/auth.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { bearerToken, loadPeersFromEnv } from "../src/auth.js";

describe("loadPeersFromEnv", () => {
  it("maps tokens to lowercase peer names", () => {
    const registry = loadPeersFromEnv({
      PEER_TOKEN_PERSONAL: "aaa",
      PEER_TOKEN_WORK: "bbb",
    } as NodeJS.ProcessEnv);
    expect(registry.peers().sort()).toEqual(["personal", "work"]);
    expect(registry.peerForToken("aaa")).toBe("personal");
    expect(registry.peerForToken("bbb")).toBe("work");
    expect(registry.peerForToken("ccc")).toBeNull();
  });

  it("throws when no peers configured", () => {
    expect(() => loadPeersFromEnv({} as NodeJS.ProcessEnv)).toThrow();
  });
});

describe("bearerToken", () => {
  it("extracts the token from an Authorization header", () => {
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken("Basic abc")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run relay/test/auth.test.ts`
Expected: FAIL, module `../src/auth.js` not found.

- [ ] **Step 3: Implement**

`relay/src/auth.ts`:

```ts
import { createHash, timingSafeEqual } from "node:crypto";

export interface PeerRegistry {
  peers(): string[];
  peerForToken(token: string): string | null;
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function loadPeersFromEnv(env: NodeJS.ProcessEnv = process.env): PeerRegistry {
  const hashes = new Map<string, Buffer>();
  for (const [key, value] of Object.entries(env)) {
    const match = key.match(/^PEER_TOKEN_(.+)$/);
    if (match && value) hashes.set(match[1].toLowerCase(), sha256(value));
  }
  if (hashes.size === 0) throw new Error("no PEER_TOKEN_* variables configured");
  return {
    peers: () => [...hashes.keys()],
    peerForToken(token: string): string | null {
      const candidate = sha256(token);
      for (const [peer, hash] of hashes) {
        if (timingSafeEqual(candidate, hash)) return peer;
      }
      return null;
    },
  };
}

export function bearerToken(header: string | undefined): string | null {
  const match = header?.match(/^Bearer (.+)$/);
  return match ? match[1] : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run relay/test/auth.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit (ask the user first)**

```bash
git add relay/src/auth.ts relay/test/auth.test.ts
git commit -m "feat(relay): peer token auth from env"
```

---

### Task 3: Relay mailbox

**Files:**
- Create: `relay/src/types.ts`, `relay/src/mailbox.ts`
- Test: `relay/test/mailbox.test.ts`

**Interfaces:**
- Produces `relay/src/types.ts`:

```ts
export interface Question {
  ticket_id: string;
  from_peer: string;
  question: string;
  conversation_id: string;
  created_at: number;
  deadline: number;
}
```

- Produces `Mailbox` class:
  - `enqueue(toPeer, fromPeer, question, conversationId?) -> { ticket_id, conversation_id }`
  - `takeNext(peer, waitMs) -> Promise<Question | null>` (long poll, records presence)
  - `settle(ticketId, { answer?, error? }) -> boolean`
  - `waitForAnswer(ticketId, timeoutMs) -> Promise<ReplyStatus>`
  - `checkReply(ticketId) -> ReplyStatus`
  - `isOnline(peer) -> boolean`
  - `ReplyStatus = { status: "answered", answer } | { status: "error", error } | { status: "pending" } | { status: "unknown_ticket" }`

- [ ] **Step 1: Write the failing tests**

`relay/test/mailbox.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run relay/test/mailbox.test.ts`
Expected: FAIL, `../src/mailbox.js` not found.

- [ ] **Step 3: Implement**

`relay/src/types.ts`:

```ts
export interface Question {
  ticket_id: string;
  from_peer: string;
  question: string;
  conversation_id: string;
  created_at: number;
  deadline: number;
}
```

`relay/src/mailbox.ts`:

```ts
import { v7 as uuidv7 } from "uuid";
import type { Question } from "./types.js";

const QUESTION_TTL_MS = 24 * 60 * 60 * 1000;
const INBOX_LIMIT = 100;
const ONLINE_WINDOW_MS = 60_000;

export type ReplyStatus =
  | { status: "answered"; answer: string }
  | { status: "error"; error: string }
  | { status: "pending" }
  | { status: "unknown_ticket" };

interface PendingEntry {
  deadline: number;
  answer?: string;
  error?: string;
  settled: boolean;
  onSettle?: () => void;
}

interface Waiter {
  resolve: (q: Question | null) => void;
  timer: NodeJS.Timeout;
}

export class Mailbox {
  private inbox = new Map<string, Question[]>();
  private pending = new Map<string, PendingEntry>();
  private waiters = new Map<string, Waiter[]>();
  private lastSeen = new Map<string, number>();

  enqueue(
    toPeer: string,
    fromPeer: string,
    question: string,
    conversationId?: string,
  ): { ticket_id: string; conversation_id: string } {
    this.cleanup();
    const now = Date.now();
    const ticket_id = uuidv7();
    const conversation_id = conversationId ?? uuidv7();
    const item: Question = {
      ticket_id,
      from_peer: fromPeer,
      question,
      conversation_id,
      created_at: now,
      deadline: now + QUESTION_TTL_MS,
    };
    this.pending.set(ticket_id, { deadline: item.deadline, settled: false });

    const waiter = this.waiters.get(toPeer)?.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(item);
    } else {
      const queue = this.inbox.get(toPeer) ?? [];
      queue.push(item);
      while (queue.length > INBOX_LIMIT) {
        const dropped = queue.shift();
        if (dropped) this.settle(dropped.ticket_id, { error: "overflow" });
      }
      this.inbox.set(toPeer, queue);
    }
    return { ticket_id, conversation_id };
  }

  takeNext(peer: string, waitMs: number): Promise<Question | null> {
    this.lastSeen.set(peer, Date.now());
    this.cleanup();
    const next = this.inbox.get(peer)?.shift();
    if (next) return Promise.resolve(next);
    return new Promise((resolve) => {
      const waiter: Waiter = {
        resolve,
        timer: setTimeout(() => {
          const list = this.waiters.get(peer) ?? [];
          const index = list.indexOf(waiter);
          if (index >= 0) list.splice(index, 1);
          resolve(null);
        }, waitMs),
      };
      const list = this.waiters.get(peer) ?? [];
      list.push(waiter);
      this.waiters.set(peer, list);
    });
  }

  settle(ticketId: string, result: { answer?: string; error?: string }): boolean {
    const entry = this.pending.get(ticketId);
    if (!entry || entry.settled) return false;
    entry.answer = result.answer;
    entry.error = result.error;
    if (entry.answer === undefined && entry.error === undefined) entry.error = "empty answer";
    entry.settled = true;
    entry.onSettle?.();
    return true;
  }

  waitForAnswer(ticketId: string, timeoutMs: number): Promise<ReplyStatus> {
    const entry = this.pending.get(ticketId);
    if (!entry) return Promise.resolve({ status: "unknown_ticket" });
    if (entry.settled) return Promise.resolve(this.consume(ticketId, entry));
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        entry.onSettle = undefined;
        resolve({ status: "pending" });
      }, timeoutMs);
      entry.onSettle = () => {
        clearTimeout(timer);
        resolve(this.consume(ticketId, entry));
      };
    });
  }

  checkReply(ticketId: string): ReplyStatus {
    const entry = this.pending.get(ticketId);
    if (!entry) return { status: "unknown_ticket" };
    if (!entry.settled) return { status: "pending" };
    return this.consume(ticketId, entry);
  }

  isOnline(peer: string): boolean {
    const seen = this.lastSeen.get(peer);
    return seen !== undefined && Date.now() - seen < ONLINE_WINDOW_MS;
  }

  // Answers are single-read: consuming removes the entry to bound memory.
  private consume(ticketId: string, entry: PendingEntry): ReplyStatus {
    this.pending.delete(ticketId);
    if (entry.error !== undefined) return { status: "error", error: entry.error };
    return { status: "answered", answer: entry.answer ?? "" };
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [peer, queue] of this.inbox) {
      const expired = queue.filter((q) => q.deadline <= now);
      this.inbox.set(peer, queue.filter((q) => q.deadline > now));
      for (const q of expired) this.settle(q.ticket_id, { error: "expired" });
    }
    for (const [id, entry] of this.pending) {
      if (entry.deadline > now) continue;
      if (!entry.settled) this.settle(id, { error: "expired" });
      else if (!entry.onSettle) this.pending.delete(id);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run relay/test/mailbox.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit (ask the user first)**

```bash
git add relay/src/types.ts relay/src/mailbox.ts relay/test/mailbox.test.ts
git commit -m "feat(relay): in-memory mailbox with long-poll, TTL and presence"
```

---

### Task 4: Relay REST endpoints

**Files:**
- Create: `relay/src/rest.ts`
- Test: `relay/test/rest.test.ts`

**Interfaces:**
- Consumes: `Mailbox` (Task 3), `PeerRegistry`, `bearerToken` (Task 2).
- Produces: `registerRest(app: FastifyInstance, mailbox: Mailbox, registry: PeerRegistry): void` and `authPeer(req: FastifyRequest, registry: PeerRegistry): string | null`. Routes: `GET /health`, `GET /inbox/:peer?wait=25` (200 with Question JSON or 204), `POST /answer` (`{ticket_id, answer?, error?}`).

- [ ] **Step 1: Write the failing tests**

`relay/test/rest.test.ts`:

```ts
import Fastify from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run relay/test/rest.test.ts`
Expected: FAIL, `../src/rest.js` not found.

- [ ] **Step 3: Implement**

`relay/src/rest.ts`:

```ts
import type { FastifyInstance, FastifyRequest } from "fastify";
import { bearerToken, type PeerRegistry } from "./auth.js";
import type { Mailbox } from "./mailbox.js";

const MAX_WAIT_SECONDS = 25;

export function authPeer(req: FastifyRequest, registry: PeerRegistry): string | null {
  const token = bearerToken(req.headers.authorization);
  return token ? registry.peerForToken(token) : null;
}

export function registerRest(app: FastifyInstance, mailbox: Mailbox, registry: PeerRegistry): void {
  app.get("/health", async () => ({ ok: true }));

  app.get<{ Params: { peer: string }; Querystring: { wait?: string } }>(
    "/inbox/:peer",
    async (req, reply) => {
      const peer = authPeer(req, registry);
      if (!peer) return reply.code(401).send({ error: "unauthorized" });
      if (peer !== req.params.peer) return reply.code(403).send({ error: "wrong peer" });
      const requested = Number(req.query.wait ?? MAX_WAIT_SECONDS);
      const waitSeconds = Math.min(Number.isFinite(requested) ? requested : MAX_WAIT_SECONDS, MAX_WAIT_SECONDS);
      const question = await mailbox.takeNext(peer, waitSeconds * 1000);
      if (!question) return reply.code(204).send();
      return question;
    },
  );

  app.post<{ Body: { ticket_id?: string; answer?: string; error?: string } }>(
    "/answer",
    async (req, reply) => {
      const peer = authPeer(req, registry);
      if (!peer) return reply.code(401).send({ error: "unauthorized" });
      const { ticket_id, answer, error } = req.body ?? {};
      if (!ticket_id) return reply.code(400).send({ error: "ticket_id required" });
      const ok = mailbox.settle(ticket_id, { answer, error });
      if (!ok) return reply.code(404).send({ error: "unknown_ticket" });
      return { ok: true };
    },
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run relay/test/rest.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit (ask the user first)**

```bash
git add relay/src/rest.ts relay/test/rest.test.ts
git commit -m "feat(relay): REST inbox and answer endpoints for daemons"
```

---

### Task 5: Relay MCP tools

**Files:**
- Create: `relay/src/mcp.ts`
- Test: `relay/test/mcp.test.ts`

**Interfaces:**
- Consumes: `Mailbox`, `PeerRegistry`.
- Produces: `buildMcpServer(mailbox: Mailbox, registry: PeerRegistry, fromPeer: string): McpServer` with tools `list_peers`, `ask_peer(peer, question, timeout_seconds?, conversation_id?)`, `check_reply(ticket_id)`. All tools return a single text content item with a JSON payload. `ask_peer` result statuses: `answered`, `error`, `pending`, `peer_offline`. Every `ask_peer` and `check_reply` result includes `ticket_id`, `ask_peer` also includes `conversation_id`.

- [ ] **Step 1: Write the failing tests**

`relay/test/mcp.test.ts`:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { loadPeersFromEnv } from "../src/auth.js";
import { Mailbox } from "../src/mailbox.js";
import { buildMcpServer } from "../src/mcp.js";

function makeRegistry() {
  return loadPeersFromEnv({
    PEER_TOKEN_PERSONAL: "tok-personal",
    PEER_TOKEN_WORK: "tok-work",
  } as NodeJS.ProcessEnv);
}

async function connect(mailbox: Mailbox, fromPeer: string) {
  const server = buildMcpServer(mailbox, makeRegistry(), fromPeer);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function payload(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

describe("MCP tools", () => {
  it("list_peers excludes the caller and reports presence", async () => {
    const mailbox = new Mailbox();
    await mailbox.takeNext("work", 0);
    const client = await connect(mailbox, "personal");
    const result = payload(await client.callTool({ name: "list_peers", arguments: {} }));
    expect(result).toEqual([{ name: "work", online: true }]);
  });

  it("ask_peer returns peer_offline with a ticket when the peer never polled", async () => {
    const mailbox = new Mailbox();
    const client = await connect(mailbox, "personal");
    const result = payload(
      await client.callTool({ name: "ask_peer", arguments: { peer: "work", question: "hi" } }),
    );
    expect(result.status).toBe("peer_offline");
    expect(result.ticket_id).toBeTruthy();
    expect(result.conversation_id).toBeTruthy();
  });

  it("ask_peer rejects unknown peers", async () => {
    const mailbox = new Mailbox();
    const client = await connect(mailbox, "personal");
    const result = payload(
      await client.callTool({ name: "ask_peer", arguments: { peer: "nobody", question: "hi" } }),
    );
    expect(result.status).toBe("error");
  });

  it("ask_peer returns the answer once the daemon settles the ticket", async () => {
    const mailbox = new Mailbox();
    await mailbox.takeNext("work", 0);
    const client = await connect(mailbox, "personal");
    const asking = client.callTool({
      name: "ask_peer",
      arguments: { peer: "work", question: "hi", timeout_seconds: 5 },
    });
    const question = await mailbox.takeNext("work", 2000);
    expect(question?.question).toBe("hi");
    mailbox.settle(question!.ticket_id, { answer: "42" });
    const result = payload(await asking);
    expect(result.status).toBe("answered");
    expect(result.answer).toBe("42");
    expect(result.conversation_id).toBe(question!.conversation_id);
  });

  it("check_reply fetches a late answer", async () => {
    const mailbox = new Mailbox();
    const { ticket_id } = mailbox.enqueue("work", "personal", "hi");
    mailbox.settle(ticket_id, { answer: "late" });
    const client = await connect(mailbox, "personal");
    const result = payload(
      await client.callTool({ name: "check_reply", arguments: { ticket_id } }),
    );
    expect(result).toMatchObject({ status: "answered", answer: "late", ticket_id });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run relay/test/mcp.test.ts`
Expected: FAIL, `../src/mcp.js` not found.

- [ ] **Step 3: Implement**

`relay/src/mcp.ts`:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PeerRegistry } from "./auth.js";
import type { Mailbox } from "./mailbox.js";

const KEEPALIVE_INTERVAL_MS = 15_000;
const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 240;

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

export function buildMcpServer(mailbox: Mailbox, registry: PeerRegistry, fromPeer: string): McpServer {
  const server = new McpServer({ name: "agent-link", version: "0.1.0" });

  server.registerTool(
    "list_peers",
    {
      description: "List peers you can ask and whether their responder daemon is online.",
      inputSchema: {},
    },
    async () =>
      json(
        registry
          .peers()
          .filter((name) => name !== fromPeer)
          .map((name) => ({ name, online: mailbox.isOnline(name) })),
      ),
  );

  server.registerTool(
    "ask_peer",
    {
      description:
        "Ask another account's agent a question. It answers from its own memory (chat history, notes). " +
        "Pass conversation_id from a previous result to continue the same conversation. " +
        "If status is pending or peer_offline, fetch the answer later with check_reply.",
      inputSchema: {
        peer: z.string().describe("Peer name from list_peers"),
        question: z.string(),
        timeout_seconds: z.number().int().positive().optional(),
        conversation_id: z.string().optional(),
      },
    },
    async ({ peer, question, timeout_seconds, conversation_id }, extra) => {
      if (peer === fromPeer || !registry.peers().includes(peer)) {
        return json({ status: "error", error: `unknown peer: ${peer}` });
      }
      const { ticket_id, conversation_id: convId } = mailbox.enqueue(
        peer,
        fromPeer,
        question,
        conversation_id,
      );
      if (!mailbox.isOnline(peer)) {
        return json({ status: "peer_offline", ticket_id, conversation_id: convId });
      }
      const timeoutMs = Math.min(timeout_seconds ?? DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S) * 1000;
      // Heroku's router kills silent connections after 30s, so ping the SSE stream while waiting.
      const keepalive = setInterval(() => {
        void extra
          .sendNotification({
            method: "notifications/message",
            params: { level: "info", data: "waiting for peer answer" },
          })
          .catch(() => undefined);
      }, KEEPALIVE_INTERVAL_MS);
      try {
        const result = await mailbox.waitForAnswer(ticket_id, timeoutMs);
        return json({ ...result, ticket_id, conversation_id: convId });
      } finally {
        clearInterval(keepalive);
      }
    },
  );

  server.registerTool(
    "check_reply",
    {
      description: "Fetch a delayed answer using the ticket_id returned earlier by ask_peer.",
      inputSchema: { ticket_id: z.string() },
    },
    async ({ ticket_id }) => json({ ...mailbox.checkReply(ticket_id), ticket_id }),
  );

  return server;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run relay/test/mcp.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit (ask the user first)**

```bash
git add relay/src/mcp.ts relay/test/mcp.test.ts
git commit -m "feat(relay): MCP tools list_peers, ask_peer, check_reply"
```

---

### Task 6: Relay bootstrap and Procfile

**Files:**
- Create: `relay/src/index.ts`, `Procfile`

**Interfaces:**
- Consumes: everything from Tasks 2-5.
- Produces: `buildApp(env): FastifyInstance` (exported for the integration test) serving REST plus `POST /mcp` (streamable HTTP, stateless, bearer auth). Entry point listens on `process.env.PORT`.

- [ ] **Step 1: Implement**

`relay/src/index.ts`:

```ts
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import Fastify, { type FastifyInstance } from "fastify";
import { loadPeersFromEnv } from "./auth.js";
import { Mailbox } from "./mailbox.js";
import { buildMcpServer } from "./mcp.js";
import { authPeer, registerRest } from "./rest.js";

export function buildApp(env: NodeJS.ProcessEnv = process.env): FastifyInstance {
  const registry = loadPeersFromEnv(env);
  const mailbox = new Mailbox();
  const app = Fastify({ logger: true });
  registerRest(app, mailbox, registry);

  // Stateless streamable HTTP: a fresh server+transport pair per request.
  app.post("/mcp", async (req, reply) => {
    const peer = authPeer(req, registry);
    if (!peer) return reply.code(401).send({ error: "unauthorized" });
    const server = buildMcpServer(mailbox, registry, peer);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    reply.hijack();
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  return app;
}

const isMain = process.argv[1]?.endsWith("index.js") ?? false;
if (isMain) {
  const app = buildApp();
  const port = Number(process.env.PORT ?? 3000);
  app.listen({ port, host: "0.0.0.0" }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}
```

`Procfile` (repo root):

```
web: npm start -w relay
```

- [ ] **Step 2: Build and smoke-test locally**

```bash
npm run build -w relay
PEER_TOKEN_PERSONAL=tok-a PEER_TOKEN_WORK=tok-b PORT=3900 node relay/dist/index.js &
sleep 1
curl -s http://localhost:3900/health
curl -s -o /dev/null -w "%{http_code}" http://localhost:3900/inbox/work
curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer tok-b" "http://localhost:3900/inbox/work?wait=0"
kill %1
```

Expected: `{"ok":true}`, then `401`, then `204`.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: all relay tests pass.

- [ ] **Step 4: Commit (ask the user first)**

```bash
git add relay/src/index.ts Procfile
git commit -m "feat(relay): fastify bootstrap with /mcp endpoint and Procfile"
```

---

### Task 7: Daemon config and conversation store

**Files:**
- Create: `daemon/src/types.ts`, `daemon/src/config.ts`, `daemon/src/conversations.ts`
- Test: `daemon/test/config.test.ts`, `daemon/test/conversations.test.ts`

**Interfaces:**
- Produces `daemon/src/types.ts`:

```ts
export interface Question {
  ticket_id: string;
  from_peer: string;
  question: string;
  conversation_id: string;
  created_at: number;
  deadline: number;
}
```

- Produces `loadConfig(filePath?): DaemonConfig` and `expandHome(p: string): string` where:

```ts
export interface DaemonConfig {
  relay_url: string;
  self_peer: string;
  token: string;
  memory_sources: { transcripts_glob: string; agents_md_roots: string[]; extra_files: string[] };
  responder: {
    cursor_agent_binary: string;
    workspace_dir: string;
    response_timeout_seconds: number;
    model?: string;
  };
}
```

- Produces `ConversationStore` with `get(conversationId): string | null` and `set(conversationId, chatId): void`, persisted as JSON, entries older than 7 days pruned on load.

- [ ] **Step 1: Write the failing tests**

`daemon/test/config.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { expandHome, loadConfig } from "../src/config.js";

const VALID = {
  relay_url: "https://example.com",
  self_peer: "work",
  token: "tok",
  memory_sources: {
    transcripts_glob: "~/.cursor/projects/*/agent-transcripts/*.jsonl",
    agents_md_roots: ["~/dev"],
    extra_files: [],
  },
  responder: {
    cursor_agent_binary: "cursor-agent",
    workspace_dir: "~/.agent-link/workspace",
    response_timeout_seconds: 300,
    model: "sonnet-4-thinking",
  },
};

describe("expandHome", () => {
  it("expands the tilde prefix", () => {
    expect(expandHome("~/x")).toBe(path.join(homedir(), "x"));
    expect(expandHome("/abs/x")).toBe("/abs/x");
  });
});

describe("loadConfig", () => {
  it("loads and expands paths", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agent-link-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify(VALID));
    const config = loadConfig(file);
    expect(config.self_peer).toBe("work");
    expect(config.responder.workspace_dir).toBe(path.join(homedir(), ".agent-link/workspace"));
    expect(config.memory_sources.agents_md_roots[0]).toBe(path.join(homedir(), "dev"));
  });

  it("rejects a config without a token", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agent-link-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ ...VALID, token: "" }));
    expect(() => loadConfig(file)).toThrow(/token/);
  });
});
```

`daemon/test/conversations.test.ts`:

```ts
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConversationStore } from "../src/conversations.js";

function tempFile(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "agent-link-")), "conversations.json");
}

describe("ConversationStore", () => {
  it("persists and reads back a mapping", () => {
    const file = tempFile();
    const store = new ConversationStore(file);
    expect(store.get("conv-1")).toBeNull();
    store.set("conv-1", "chat-42");
    expect(store.get("conv-1")).toBe("chat-42");
    const reloaded = new ConversationStore(file);
    expect(reloaded.get("conv-1")).toBe("chat-42");
  });

  it("prunes entries older than 7 days on load", () => {
    const file = tempFile();
    const stale = Date.now() - 8 * 24 * 60 * 60 * 1000;
    writeFileSync(
      file,
      JSON.stringify({
        old: { chat_id: "chat-old", updated_at: stale },
        fresh: { chat_id: "chat-new", updated_at: Date.now() },
      }),
    );
    const store = new ConversationStore(file);
    expect(store.get("old")).toBeNull();
    expect(store.get("fresh")).toBe("chat-new");
    expect(readFileSync(file, "utf8")).not.toContain("chat-old");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run daemon/test/config.test.ts daemon/test/conversations.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`daemon/src/types.ts`: the `Question` interface exactly as in the Interfaces block above.

`daemon/src/config.ts`:

```ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface DaemonConfig {
  relay_url: string;
  self_peer: string;
  token: string;
  memory_sources: { transcripts_glob: string; agents_md_roots: string[]; extra_files: string[] };
  responder: {
    cursor_agent_binary: string;
    workspace_dir: string;
    response_timeout_seconds: number;
    model?: string;
  };
}

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  return p.startsWith("~/") ? path.join(homedir(), p.slice(2)) : p;
}

export function loadConfig(filePath = "~/.agent-link/config.json"): DaemonConfig {
  const config = JSON.parse(readFileSync(expandHome(filePath), "utf8")) as DaemonConfig;
  for (const key of ["relay_url", "self_peer", "token"] as const) {
    if (!config[key]) throw new Error(`config: missing ${key}`);
  }
  config.memory_sources.transcripts_glob = expandHome(config.memory_sources.transcripts_glob);
  config.memory_sources.agents_md_roots = config.memory_sources.agents_md_roots.map(expandHome);
  config.memory_sources.extra_files = config.memory_sources.extra_files.map(expandHome);
  config.responder.workspace_dir = expandHome(config.responder.workspace_dir);
  return config;
}
```

`daemon/src/conversations.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface Entry {
  chat_id: string;
  updated_at: number;
}

export class ConversationStore {
  private entries: Record<string, Entry>;

  constructor(private filePath: string) {
    this.entries = existsSync(filePath)
      ? (JSON.parse(readFileSync(filePath, "utf8")) as Record<string, Entry>)
      : {};
    const now = Date.now();
    for (const [id, entry] of Object.entries(this.entries)) {
      if (now - entry.updated_at > MAX_AGE_MS) delete this.entries[id];
    }
    this.save();
  }

  get(conversationId: string): string | null {
    return this.entries[conversationId]?.chat_id ?? null;
  }

  set(conversationId: string, chatId: string): void {
    this.entries[conversationId] = { chat_id: chatId, updated_at: Date.now() };
    this.save();
  }

  private save(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.entries, null, 2));
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run daemon/test/config.test.ts daemon/test/conversations.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit (ask the user first)**

```bash
git add daemon/src/types.ts daemon/src/config.ts daemon/src/conversations.ts daemon/test/config.test.ts daemon/test/conversations.test.ts
git commit -m "feat(daemon): config loader and conversation store"
```

---

### Task 8: Daemon prompt builder

**Files:**
- Create: `daemon/src/prompt.ts`
- Test: `daemon/test/prompt.test.ts`

**Interfaces:**
- Produces:

```ts
export interface MemoryMap {
  transcript_files: string[];
  agents_md_files: string[];
  extra_files: string[];
}
export function buildFirstTask(policy: string, question: string, memory: MemoryMap): string;
export function buildFollowupTask(policy: string, question: string): string;
```

- [ ] **Step 1: Write the failing tests**

`daemon/test/prompt.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildFirstTask, buildFollowupTask } from "../src/prompt.js";

const MEMORY = {
  transcript_files: ["/home/u/.cursor/projects/p1/agent-transcripts/a.jsonl"],
  agents_md_files: ["/home/u/dev/proj/AGENTS.md"],
  extra_files: [],
};

describe("buildFirstTask", () => {
  it("includes policy, question and memory sources", () => {
    const task = buildFirstTask("Do not share secrets.", "What did I ship?", MEMORY);
    expect(task).toContain("Do not share secrets.");
    expect(task).toContain("What did I ship?");
    expect(task).toContain("a.jsonl");
    expect(task).toContain("AGENTS.md");
    expect(task).toContain("Do not invent facts");
  });
});

describe("buildFollowupTask", () => {
  it("includes policy and question but no memory map", () => {
    const task = buildFollowupTask("Do not share secrets.", "Which of those shipped?");
    expect(task).toContain("Do not share secrets.");
    expect(task).toContain("Which of those shipped?");
    expect(task).not.toContain("jsonl");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run daemon/test/prompt.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`daemon/src/prompt.ts`:

```ts
export interface MemoryMap {
  transcript_files: string[];
  agents_md_files: string[];
  extra_files: string[];
}

export function buildFirstTask(policy: string, question: string, memory: MemoryMap): string {
  const lines = [
    "# Task: answer a question from my other account's agent",
    "",
    "You are the responder agent. Another agent belonging to the same human is asking you a question.",
    "Answer using only the memory sources listed below.",
    "",
    "## Disclosure policy (must follow)",
    policy.trim() || "No extra restrictions.",
    "",
    "## Memory sources",
    "Chat transcripts (jsonl, one file per past chat):",
    ...memory.transcript_files.map((f) => `- ${f}`),
    "Accumulated memory files:",
    ...memory.agents_md_files.map((f) => `- ${f}`),
  ];
  if (memory.extra_files.length > 0) {
    lines.push("Extra files:", ...memory.extra_files.map((f) => `- ${f}`));
  }
  lines.push(
    "",
    "## Rules",
    "- Search the sources for facts relevant to the question. Do not invent facts.",
    "- If the sources contain nothing relevant, say so honestly.",
    "- Reply with the final answer as plain text, no preamble.",
    "",
    "## Question",
    question,
  );
  return lines.join("\n");
}

export function buildFollowupTask(policy: string, question: string): string {
  return [
    "# Follow-up question in the same conversation",
    "",
    "The same disclosure policy still applies:",
    policy.trim() || "No extra restrictions.",
    "",
    "Reply with the final answer as plain text, no preamble.",
    "",
    "## Question",
    question,
  ].join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run daemon/test/prompt.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit (ask the user first)**

```bash
git add daemon/src/prompt.ts daemon/test/prompt.test.ts
git commit -m "feat(daemon): task.md prompt builders"
```

---

### Task 9: Daemon runner

**Files:**
- Create: `daemon/src/runner.ts`
- Create: `daemon/test/fixtures/fake-cursor-agent.sh` (chmod +x)
- Test: `daemon/test/runner.test.ts`

**Interfaces:**
- Produces:

```ts
export interface RunnerOptions {
  binary: string;
  workspaceDir: string;
  timeoutMs: number;
  model?: string;
}
export function createChat(opts: RunnerOptions): Promise<string>;
export function runTask(
  opts: RunnerOptions,
  chatId: string,
  taskContent: string,
): Promise<{ answer?: string; error?: string }>;
```

- `runTask` writes `taskContent` to `<workspaceDir>/task.md` and spawns:
  `<binary> --resume <chatId> -p "Read the file task.md in this workspace and follow the instructions in it." --output-format text --trust --force --workspace <workspaceDir> [--model <model>]`

- [ ] **Step 1: Create the fake cursor-agent fixture**

`daemon/test/fixtures/fake-cursor-agent.sh`:

```bash
#!/usr/bin/env bash
# Test stub for cursor-agent. Logs args, answers a fixed string.
if [ "$1" = "create-chat" ]; then
  echo "chat-123"
  exit 0
fi
if [ -n "${FAKE_AGENT_LOG:-}" ]; then
  printf '%s\n' "$*" >> "$FAKE_AGENT_LOG"
fi
if [ "${FAKE_AGENT_MODE:-ok}" = "fail" ]; then
  echo "boom" >&2
  exit 1
fi
if [ "${FAKE_AGENT_MODE:-ok}" = "hang" ]; then
  sleep 30
fi
echo "STUB ANSWER"
```

Run: `chmod +x daemon/test/fixtures/fake-cursor-agent.sh`

- [ ] **Step 2: Write the failing tests**

`daemon/test/runner.test.ts`:

```ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createChat, runTask, type RunnerOptions } from "../src/runner.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, "fixtures/fake-cursor-agent.sh");

function makeOpts(): RunnerOptions & { logFile: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "agent-link-run-"));
  return {
    binary: FIXTURE,
    workspaceDir: path.join(dir, "workspace"),
    timeoutMs: 5000,
    model: "test-model",
    logFile: path.join(dir, "args.log"),
  };
}

afterEach(() => {
  delete process.env.FAKE_AGENT_LOG;
  delete process.env.FAKE_AGENT_MODE;
});

describe("createChat", () => {
  it("returns the chat id printed by the binary", async () => {
    await expect(createChat(makeOpts())).resolves.toBe("chat-123");
  });
});

describe("runTask", () => {
  it("writes task.md and passes the expected flags", async () => {
    const opts = makeOpts();
    process.env.FAKE_AGENT_LOG = opts.logFile;
    const result = await runTask(opts, "chat-123", "# task body");
    expect(result).toEqual({ answer: "STUB ANSWER" });
    expect(readFileSync(path.join(opts.workspaceDir, "task.md"), "utf8")).toBe("# task body");
    const args = readFileSync(opts.logFile, "utf8");
    expect(args).toContain("--resume chat-123");
    expect(args).toContain("--trust");
    expect(args).toContain("--force");
    expect(args).toContain("--output-format text");
    expect(args).toContain("--model test-model");
    expect(args).toContain(`--workspace ${opts.workspaceDir}`);
  });

  it("returns an error when the binary exits nonzero", async () => {
    const opts = makeOpts();
    process.env.FAKE_AGENT_MODE = "fail";
    const result = await runTask(opts, "chat-123", "# task body");
    expect(result.error).toMatch(/cursor-agent failed/);
  });

  it("returns an error when the binary exceeds the timeout", async () => {
    const opts = makeOpts();
    opts.timeoutMs = 500;
    process.env.FAKE_AGENT_MODE = "hang";
    const result = await runTask(opts, "chat-123", "# task body");
    expect(result.error).toMatch(/cursor-agent failed/);
  }, 10_000);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run daemon/test/runner.test.ts`
Expected: FAIL, `../src/runner.js` not found.

- [ ] **Step 4: Implement**

`daemon/src/runner.ts`:

```ts
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TASK_INSTRUCTION = "Read the file task.md in this workspace and follow the instructions in it.";

export interface RunnerOptions {
  binary: string;
  workspaceDir: string;
  timeoutMs: number;
  model?: string;
}

export async function createChat(opts: RunnerOptions): Promise<string> {
  const { stdout } = await execFileAsync(opts.binary, ["create-chat"], { timeout: 60_000 });
  const chatId = stdout.trim();
  if (!chatId) throw new Error("create-chat returned an empty chat id");
  return chatId;
}

export async function runTask(
  opts: RunnerOptions,
  chatId: string,
  taskContent: string,
): Promise<{ answer?: string; error?: string }> {
  mkdirSync(opts.workspaceDir, { recursive: true });
  writeFileSync(path.join(opts.workspaceDir, "task.md"), taskContent);
  const args = [
    "--resume", chatId,
    "-p", TASK_INSTRUCTION,
    "--output-format", "text",
    "--trust",
    "--force",
    "--workspace", opts.workspaceDir,
  ];
  if (opts.model) args.push("--model", opts.model);
  try {
    const { stdout } = await execFileAsync(opts.binary, args, {
      timeout: opts.timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    const answer = stdout.trim();
    return answer ? { answer } : { error: "responder produced empty output" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `cursor-agent failed: ${message.slice(0, 500)}` };
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run daemon/test/runner.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit (ask the user first)**

```bash
git add daemon/src/runner.ts daemon/test/runner.test.ts daemon/test/fixtures/fake-cursor-agent.sh
git commit -m "feat(daemon): cursor-agent runner with resume support"
```

---

### Task 10: Daemon poller

**Files:**
- Create: `daemon/src/poller.ts`
- Test: `daemon/test/poller.test.ts`

**Interfaces:**
- Consumes: `DaemonConfig` (Task 7), `Question` (daemon/src/types.ts).
- Produces:

```ts
export type QuestionHandler = (q: Question) => Promise<{ answer?: string; error?: string }>;
export class Poller {
  constructor(
    config: DaemonConfig,
    handle: QuestionHandler,
    fetchImpl?: typeof fetch,
    sleep?: (ms: number) => Promise<void>,
  );
  pollOnce(): Promise<"handled" | "empty" | "retry">;
  run(signal?: AbortSignal): Promise<void>;
}
```

- Backoff: network or 5xx errors double from 1 s up to 60 s. 401 or 403 backs off up to 300 s. Successful poll resets to 1 s.

- [ ] **Step 1: Write the failing tests**

`daemon/test/poller.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run daemon/test/poller.test.ts`
Expected: FAIL, `../src/poller.js` not found.

- [ ] **Step 3: Implement**

`daemon/src/poller.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run daemon/test/poller.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit (ask the user first)**

```bash
git add daemon/src/poller.ts daemon/test/poller.test.ts
git commit -m "feat(daemon): relay poller with exponential backoff"
```

---

### Task 11: Daemon handler, entry point and full-cycle integration test

**Files:**
- Create: `daemon/src/handler.ts`, `daemon/src/index.ts`
- Test: `daemon/test/integration.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 7-10 plus relay `buildApp` (Task 6).
- Produces:

```ts
export function createHandler(
  config: DaemonConfig,
  store: ConversationStore,
  policy: string,
): QuestionHandler;
```

First question of a conversation: `createChat` + `buildFirstTask` with a memory map collected via `fast-glob`. Follow-up (store already has the conversation): `buildFollowupTask`, same chat id.

- [ ] **Step 1: Implement the handler**

`daemon/src/handler.ts`:

```ts
import fg from "fast-glob";
import path from "node:path";
import type { DaemonConfig } from "./config.js";
import type { ConversationStore } from "./conversations.js";
import type { QuestionHandler } from "./poller.js";
import { buildFirstTask, buildFollowupTask, type MemoryMap } from "./prompt.js";
import { createChat, runTask, type RunnerOptions } from "./runner.js";

function collectMemory(config: DaemonConfig): MemoryMap {
  const transcript_files = fg.sync(config.memory_sources.transcripts_glob, { absolute: true });
  const agents_md_files = config.memory_sources.agents_md_roots.flatMap((root) =>
    fg.sync(path.join(root, "**/AGENTS.md"), { absolute: true }),
  );
  return { transcript_files, agents_md_files, extra_files: config.memory_sources.extra_files };
}

export function createHandler(
  config: DaemonConfig,
  store: ConversationStore,
  policy: string,
): QuestionHandler {
  const runnerOpts: RunnerOptions = {
    binary: config.responder.cursor_agent_binary,
    workspaceDir: config.responder.workspace_dir,
    timeoutMs: config.responder.response_timeout_seconds * 1000,
    model: config.responder.model,
  };

  return async (question) => {
    try {
      let chatId = store.get(question.conversation_id);
      const isFirstTurn = chatId === null;
      if (chatId === null) {
        chatId = await createChat(runnerOpts);
      }
      const task = isFirstTurn
        ? buildFirstTask(policy, question.question, collectMemory(config))
        : buildFollowupTask(policy, question.question);
      const result = await runTask(runnerOpts, chatId, task);
      store.set(question.conversation_id, chatId);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `responder failed: ${message.slice(0, 500)}` };
    }
  };
}
```

`daemon/src/index.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { expandHome, loadConfig } from "./config.js";
import { ConversationStore } from "./conversations.js";
import { createHandler } from "./handler.js";
import { Poller } from "./poller.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const policyPath = expandHome("~/.agent-link/policy.md");
  const policy = existsSync(policyPath) ? readFileSync(policyPath, "utf8") : "";
  const store = new ConversationStore(expandHome("~/.agent-link/conversations.json"));
  const poller = new Poller(config, createHandler(config, store, policy));
  console.log(`agent-link responder started as peer "${config.self_peer}"`);
  await poller.run();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Write the integration test**

`daemon/test/integration.test.ts`:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../relay/src/index.js";
import type { DaemonConfig } from "../src/config.js";
import { ConversationStore } from "../src/conversations.js";
import { createHandler } from "../src/handler.js";
import { Poller } from "../src/poller.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, "fixtures/fake-cursor-agent.sh");

describe("full cycle: MCP ask_peer -> daemon -> answer", () => {
  const app = buildApp({
    PEER_TOKEN_PERSONAL: "tok-personal",
    PEER_TOKEN_WORK: "tok-work",
  } as NodeJS.ProcessEnv);
  let baseUrl: string;
  const abort = new AbortController();

  beforeAll(async () => {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (typeof address === "string" || address === null) throw new Error("no port");
    baseUrl = `http://127.0.0.1:${address.port}`;

    const dir = mkdtempSync(path.join(tmpdir(), "agent-link-e2e-"));
    const config: DaemonConfig = {
      relay_url: baseUrl,
      self_peer: "work",
      token: "tok-work",
      memory_sources: {
        transcripts_glob: path.join(dir, "none/*.jsonl"),
        agents_md_roots: [],
        extra_files: [],
      },
      responder: {
        cursor_agent_binary: FIXTURE,
        workspace_dir: path.join(dir, "workspace"),
        response_timeout_seconds: 30,
      },
    };
    const store = new ConversationStore(path.join(dir, "conversations.json"));
    const poller = new Poller(config, createHandler(config, store, "test policy"));
    void poller.run(abort.signal);
    // Let the daemon register presence with its first poll.
    await new Promise((r) => setTimeout(r, 200));
  });

  afterAll(async () => {
    abort.abort();
    await app.close();
  });

  it("answers a question end to end and keeps the conversation id", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: "Bearer tok-personal" } },
    });
    const client = new Client({ name: "e2e", version: "0.0.0" });
    await client.connect(transport);

    const result = await client.callTool({
      name: "ask_peer",
      arguments: { peer: "work", question: "what do you know about me?", timeout_seconds: 30 },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text) as Record<string, unknown>;
    expect(parsed.status).toBe("answered");
    expect(parsed.answer).toBe("STUB ANSWER");
    expect(parsed.conversation_id).toBeTruthy();

    const followup = await client.callTool({
      name: "ask_peer",
      arguments: {
        peer: "work",
        question: "and more?",
        timeout_seconds: 30,
        conversation_id: parsed.conversation_id,
      },
    });
    const followupContent = followup.content as Array<{ type: string; text: string }>;
    const followupParsed = JSON.parse(followupContent[0].text) as Record<string, unknown>;
    expect(followupParsed.status).toBe("answered");
    expect(followupParsed.conversation_id).toBe(parsed.conversation_id);

    await client.close();
  }, 30_000);
});
```

- [ ] **Step 3: Run the integration test**

Run: `npx vitest run daemon/test/integration.test.ts`
Expected: PASS. If the relay import fails at runtime, add `"@modelcontextprotocol/sdk"` and `fastify` availability by running the test from the repo root (workspaces hoist dependencies).

- [ ] **Step 4: Run the full suite and build**

```bash
npm test
npm run build
```

Expected: all tests pass, both packages compile.

- [ ] **Step 5: Commit (ask the user first)**

```bash
git add daemon/src/handler.ts daemon/src/index.ts daemon/test/integration.test.ts
git commit -m "feat(daemon): handler wiring and full-cycle integration test"
```

---

### Task 12: launchd install script

**Files:**
- Create: `daemon/launchd/com.agent-link.responder.plist`
- Create: `scripts/install-daemon.sh` (chmod +x)

**Interfaces:**
- Consumes: built daemon at `daemon/dist/index.js` (Task 11).
- Produces: a launchd agent `com.agent-link.responder` that starts the daemon at load and keeps it alive.

- [ ] **Step 1: Create the plist template**

`daemon/launchd/com.agent-link.responder.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.agent-link.responder</string>
  <key>ProgramArguments</key>
  <array>
    <string>__NODE__</string>
    <string>__REPO__/daemon/dist/index.js</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>__HOME__/.agent-link/responder.log</string>
  <key>StandardErrorPath</key><string>__HOME__/.agent-link/responder.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>__HOME__/.local/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
```

- [ ] **Step 2: Create the install script**

`scripts/install-daemon.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_SRC="$ROOT/daemon/launchd/com.agent-link.responder.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.agent-link.responder.plist"
NODE_BIN="$(command -v node)"

if [ ! -f "$ROOT/daemon/dist/index.js" ]; then
  echo "daemon is not built, run: npm run build -w daemon" >&2
  exit 1
fi
if [ ! -f "$HOME/.agent-link/config.json" ]; then
  echo "missing ~/.agent-link/config.json, create it first (see the spec, section 3.3)" >&2
  exit 1
fi

mkdir -p "$HOME/.agent-link/workspace"
chmod 600 "$HOME/.agent-link/config.json"

sed -e "s|__NODE__|$NODE_BIN|g" \
    -e "s|__REPO__|$ROOT|g" \
    -e "s|__HOME__|$HOME|g" \
    "$PLIST_SRC" > "$PLIST_DST"

launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load "$PLIST_DST"
echo "agent-link responder installed and started, logs: ~/.agent-link/responder.log"
```

Run: `chmod +x scripts/install-daemon.sh`

- [ ] **Step 3: Verify plist syntax**

Run: `plutil -lint daemon/launchd/com.agent-link.responder.plist`
Expected: `OK` (placeholders do not break plist syntax).

- [ ] **Step 4: Commit (ask the user first)**

```bash
git add daemon/launchd/com.agent-link.responder.plist scripts/install-daemon.sh
git commit -m "feat(daemon): launchd install script"
```

---

### Task 13: Heroku deploy and manual e2e (manual, with the user)

**Files:** none created. Manual operations only.

**Interfaces:**
- Consumes: the whole repo.

- [ ] **Step 1: Generate tokens and create the Heroku app (ask the user before creating billable resources)**

```bash
TOKEN_PERSONAL=$(openssl rand -hex 32)
TOKEN_WORK=$(openssl rand -hex 32)
heroku create agent-link-relay
heroku config:set "PEER_TOKEN_PERSONAL=$TOKEN_PERSONAL" "PEER_TOKEN_WORK=$TOKEN_WORK" -a agent-link-relay
heroku ps:type basic -a agent-link-relay
```

- [ ] **Step 2: Deploy (requires an explicit push command from the user)**

```bash
git push heroku main
curl -s https://agent-link-relay.herokuapp.com/health
```

Expected: `{"ok":true}`.

- [ ] **Step 3: Configure this (personal) machine**

Create `~/.agent-link/config.json` with `self_peer: "personal"`, the personal token, and the relay URL (template in the spec, section 3.3). Create `~/.agent-link/policy.md` (starter content in the spec, section 3.3). Then:

```bash
npm run build -w daemon
./scripts/install-daemon.sh
```

Add the relay to Cursor as a remote MCP server in `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "agent-link": {
      "url": "https://agent-link-relay.herokuapp.com/mcp",
      "headers": { "Authorization": "Bearer <TOKEN_PERSONAL>" }
    }
  }
}
```

- [ ] **Step 4: Configure the work machine (user does this by hand)**

Same as Step 3 with `self_peer: "work"`, the work token, and the work account's `cursor-agent`. Clone the repo, `npm install`, `npm run build -w daemon`, `./scripts/install-daemon.sh`.

- [ ] **Step 5: Manual e2e checklist**

1. In a personal Cursor chat call `list_peers`. Expected: `work` is online.
2. Ask: `ask_peer("work", "what do you know about my work achievements over the last six months?")`. Expected: a meaningful answer within 1-3 minutes, possibly via `pending` + `check_reply`.
3. Follow-up with the returned `conversation_id`. Expected: the answer builds on the previous turn.
4. Stop the work daemon (`launchctl unload ~/Library/LaunchAgents/com.agent-link.responder.plist`), ask again. Expected: `peer_offline` with a ticket. Start the daemon, wait, `check_reply` returns the answer.
5. Check `~/.agent-link/responder.log` on the work machine for errors.

---

## Self-Review Notes

- Spec coverage: relay tools and REST (Tasks 4-6), keepalive and 25 s long-poll (Tasks 5, 4), auth with sha256 and constant-time compare (Task 2), TTL, overflow, presence (Task 3), daemon prompt with policy and memory map (Task 8), `--trust`, `--force`, `--workspace`, `--model`, task.md via file (Task 9), conversations with `--resume` and 7-day pruning (Tasks 7, 9, 11), backoff including 401 (Task 10), launchd with KeepAlive (Task 12), basic dyno and deploy (Task 13), integration test with a stub including the multi-turn scenario (Task 11).
- Spec open questions resolved here: responder uses `--force` (Task 9), chat id comes from `cursor-agent create-chat` (Task 9). If `create-chat` output format differs in practice, adjust `createChat` parsing during Task 9 and note it.
- Types are consistent: the `Question` shape is duplicated deliberately in `relay/src/types.ts` and `daemon/src/types.ts` (packages stay independent), field names match the wire format.
