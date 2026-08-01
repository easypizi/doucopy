# agent-link v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn agent-link into an open-source, self-hostable system: stateless HMAC auth with invite codes, one-command machine setup via `npx agent-link join`, parallel dialog handling in the daemon, and a CLI (`status`, `invite`, `logs`, `start/stop/restart`, `relay`).

**Architecture:** The relay keeps a single `RELAY_SECRET` and signs peer tokens (`al1.<name-b64url>.<sig>`) and invites (`ali1.<expiry>.<nonce>.<sig>`); no peer registry exists anywhere. Peer lists come from live presence. A new `cli` workspace is published together with `relay` and `daemon` as one npm package `agent-link` with bin `agent-link`. The daemon gains bounded concurrency with per-conversation workspaces.

**Tech Stack:** Node.js 22, TypeScript (strict, ESM, declarations on), Fastify, `@modelcontextprotocol/sdk`, `zod`, `uuid` v7, `fast-glob`, `node:util` `parseArgs`, Vitest. Spec: `docs/superpowers/specs/2026-07-26-agent-link-v2-design.md`.

## Global Constraints

- Node.js `22.x`, `"type": "module"` everywhere, TypeScript `strict: true`, `declaration: true`.
- Comments and identifiers in code are English-only. No Cyrillic in code or filenames. No TODOs or placeholders.
- Git: NEVER run `git commit` or `git push` without the user's explicit go-ahead. At every Commit step below, stop and ask the user first.
- `RELAY_SECRET` must be at least 16 characters. Peer names match `/^[A-Za-z0-9._-]{1,64}$/`.
- Invite TTL: default 72 hours, maximum 720. `/join` rate limit: 10 requests per minute per IP, in memory.
- Revocation: config var `REVOKED_PEERS` (comma-separated names), checked on every auth and on `/join`.
- Daemon: default `max_concurrent` 3, per-conversation workspace dirs, 7-day workspace prune.
- macOS only (launchd). Existing timeouts unchanged: long-poll 25 s, keepalive 15 s, responder 300 s.
- Breaking change accepted: `PEER_TOKEN_*` support is removed, both existing machines re-join after deploy.

---

## File Structure

```
package.json                    becomes publishable "agent-link", bin, files, deps moved here
tsconfig.base.json              add "declaration": true
app.json                        new: Heroku deploy button config
Dockerfile                      new: container relay
relay/src/auth.ts               REWRITE: createTokenService (HMAC tokens + invites), bearerToken kept
relay/src/mailbox.ts            MODIFY: knownPeers, queuedCount, outgoingFor, from/created_at in pending
relay/src/rest.ts               MODIFY: TokenService auth, POST /join, POST /invite, GET /status
relay/src/mcp.ts                MODIFY: drop registry, list_peers from presence
relay/src/index.ts              MODIFY: RELAY_SECRET wiring, safe isMain check
daemon/src/config.ts            MODIFY: responder.max_concurrent
daemon/src/workspace.ts         NEW: safeDirName, pruneWorkspaces
daemon/src/handler.ts           MODIFY: per-conversation workspace dirs
daemon/src/poller.ts            REWRITE: concurrent handling with slots, drain()
daemon/src/index.ts             MODIFY: prune workspaces at start
cli/package.json  cli/tsconfig.json   NEW workspace
cli/src/index.ts                NEW: command dispatch (bin entry, shebang)
cli/src/relay.ts                NEW: run relay from the package
cli/src/api.ts                  NEW: relay HTTP client (join, invite, status)
cli/src/setup.ts                NEW: memory discovery, config/policy/mcp.json writers
cli/src/launchd.ts              NEW: plist render/install, start/stop, isDaemonRunning
cli/src/join.ts  cli/src/invite.ts  cli/src/status.ts   NEW commands
cli/test/api.test.ts  cli/test/setup.test.ts             NEW tests
scripts/setup-machine.sh  scripts/install-daemon.sh  scripts/daemon.sh   DELETE (absorbed by CLI)
```

Existing test files under `relay/test/` and `daemon/test/` are updated in the task that changes their subject.

---

### Task 1: Relay stateless auth (`createTokenService`)

**Files:**
- Rewrite: `relay/src/auth.ts`
- Rewrite: `relay/test/auth.test.ts`

**Interfaces:**
- Produces:

```ts
export const PEER_NAME_PATTERN: RegExp; // /^[A-Za-z0-9._-]{1,64}$/
export interface TokenService {
  issuePeerToken(name: string): string;
  verifyPeerToken(token: string): string | null; // null = invalid or revoked
  issueInvite(ttlHours?: number): { invite: string; expires_at: number };
  verifyInvite(invite: string): boolean;
  isRevoked(name: string): boolean;
}
export function createTokenService(secret: string, revokedCsv?: string): TokenService;
export function bearerToken(header: string | undefined): string | null; // unchanged
```

- `loadPeersFromEnv` and `PeerRegistry` are deleted. Later tasks fix the compile errors in their own files.

- [ ] **Step 1: Write the failing tests**

Replace `relay/test/auth.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import { bearerToken, createTokenService, PEER_NAME_PATTERN } from "../src/auth.js";

const SECRET = "test-secret-0123456789abcdef";

describe("createTokenService", () => {
  it("issues and verifies a peer token", () => {
    const svc = createTokenService(SECRET);
    const token = svc.issuePeerToken("ivan-mbp");
    expect(token.startsWith("al1.")).toBe(true);
    expect(svc.verifyPeerToken(token)).toBe("ivan-mbp");
  });

  it("rejects a token signed with a different secret", () => {
    const other = createTokenService("another-secret-0123456789");
    const token = other.issuePeerToken("ivan-mbp");
    expect(createTokenService(SECRET).verifyPeerToken(token)).toBeNull();
  });

  it("rejects malformed tokens", () => {
    const svc = createTokenService(SECRET);
    expect(svc.verifyPeerToken("")).toBeNull();
    expect(svc.verifyPeerToken("al1.onlytwo")).toBeNull();
    expect(svc.verifyPeerToken("nope.x.y")).toBeNull();
  });

  it("rejects revoked peers", () => {
    const svc = createTokenService(SECRET, "mallory, eve");
    const token = svc.issuePeerToken("mallory");
    expect(svc.verifyPeerToken(token)).toBeNull();
    expect(svc.isRevoked("eve")).toBe(true);
    expect(svc.isRevoked("ivan")).toBe(false);
  });

  it("issues and verifies an invite", () => {
    const svc = createTokenService(SECRET);
    const { invite, expires_at } = svc.issueInvite(1);
    expect(invite.startsWith("ali1.")).toBe(true);
    expect(expires_at).toBeGreaterThan(Date.now());
    expect(svc.verifyInvite(invite)).toBe(true);
  });

  it("rejects an expired invite", () => {
    const svc = createTokenService(SECRET);
    const { invite } = svc.issueInvite(-1);
    expect(svc.verifyInvite(invite)).toBe(false);
  });

  it("rejects a tampered invite", () => {
    const svc = createTokenService(SECRET);
    const { invite } = svc.issueInvite(1);
    const parts = invite.split(".");
    parts[1] = String(Number(parts[1]) + 3_600_000);
    expect(svc.verifyInvite(parts.join("."))).toBe(false);
  });

  it("requires a sufficiently long secret", () => {
    expect(() => createTokenService("short")).toThrow();
  });
});

describe("PEER_NAME_PATTERN", () => {
  it("accepts safe names and rejects unsafe ones", () => {
    expect(PEER_NAME_PATTERN.test("ivan-mbp.2")).toBe(true);
    expect(PEER_NAME_PATTERN.test("with space")).toBe(false);
    expect(PEER_NAME_PATTERN.test("")).toBe(false);
    expect(PEER_NAME_PATTERN.test("a".repeat(65))).toBe(false);
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

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run relay/test/auth.test.ts`
Expected: FAIL, `createTokenService` not exported.

- [ ] **Step 3: Implement**

Replace `relay/src/auth.ts` with:

```ts
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const PEER_PREFIX = "al1";
const INVITE_PREFIX = "ali1";
const DEFAULT_INVITE_TTL_HOURS = 72;
const MIN_SECRET_LENGTH = 16;

export const PEER_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export interface TokenService {
  issuePeerToken(name: string): string;
  verifyPeerToken(token: string): string | null;
  issueInvite(ttlHours?: number): { invite: string; expires_at: number };
  verifyInvite(invite: string): boolean;
  isRevoked(name: string): boolean;
}

function hmac(secret: string, payload: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

function signatureMatches(givenBase64url: string, expected: Buffer): boolean {
  const given = Buffer.from(givenBase64url, "base64url");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function createTokenService(secret: string, revokedCsv = ""): TokenService {
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`RELAY_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  const revoked = new Set(
    revokedCsv.split(",").map((name) => name.trim()).filter(Boolean),
  );
  return {
    issuePeerToken(name: string): string {
      const nameB64 = Buffer.from(name, "utf8").toString("base64url");
      const sig = hmac(secret, `peer:${name}`).toString("base64url");
      return `${PEER_PREFIX}.${nameB64}.${sig}`;
    },
    verifyPeerToken(token: string): string | null {
      const parts = token.split(".");
      if (parts.length !== 3 || parts[0] !== PEER_PREFIX) return null;
      const name = Buffer.from(parts[1], "base64url").toString("utf8");
      if (!PEER_NAME_PATTERN.test(name)) return null;
      if (!signatureMatches(parts[2], hmac(secret, `peer:${name}`))) return null;
      if (revoked.has(name)) return null;
      return name;
    },
    issueInvite(ttlHours = DEFAULT_INVITE_TTL_HOURS) {
      const expires_at = Date.now() + ttlHours * 3_600_000;
      const nonce = randomBytes(8).toString("base64url");
      const sig = hmac(secret, `invite:${expires_at}:${nonce}`).toString("base64url");
      return { invite: `${INVITE_PREFIX}.${expires_at}.${nonce}.${sig}`, expires_at };
    },
    verifyInvite(invite: string): boolean {
      const parts = invite.split(".");
      if (parts.length !== 4 || parts[0] !== INVITE_PREFIX) return false;
      const expires = Number(parts[1]);
      if (!Number.isFinite(expires) || expires <= Date.now()) return false;
      return signatureMatches(parts[3], hmac(secret, `invite:${parts[1]}:${parts[2]}`));
    },
    isRevoked: (name: string) => revoked.has(name),
  };
}

export function bearerToken(header: string | undefined): string | null {
  const match = header?.match(/^Bearer (.+)$/);
  return match ? match[1] : null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run relay/test/auth.test.ts`
Expected: PASS. Other relay files fail to compile now (they import `loadPeersFromEnv`); that is expected until Tasks 3-5. Do NOT run the full suite yet.

- [ ] **Step 5: Commit (ask the user first)**

```bash
git add relay/src/auth.ts relay/test/auth.test.ts
git commit -m "feat(relay): stateless HMAC token service with invites and revocation"
```

---

### Task 2: Mailbox status surface

**Files:**
- Modify: `relay/src/mailbox.ts`
- Modify: `relay/test/mailbox.test.ts` (append new describe block)

**Interfaces:**
- Produces on `Mailbox`:

```ts
export interface OutgoingTicket {
  ticket_id: string;
  to_peer: string;
  status: "pending" | "answered" | "error";
  created_at: number;
}
knownPeers(): string[];              // every peer that ever polled this process
queuedCount(peer: string): number;   // inbox depth for the peer
outgoingFor(peer: string): OutgoingTicket[]; // unconsumed tickets asked by the peer
```

- [ ] **Step 1: Write the failing tests**

Append to `relay/test/mailbox.test.ts` inside the top-level `describe("Mailbox", ...)`:

```ts
  it("tracks known peers from polling", async () => {
    const box = new Mailbox();
    expect(box.knownPeers()).toEqual([]);
    const poll = box.takeNext("work", 100);
    vi.advanceTimersByTime(101);
    await poll;
    expect(box.knownPeers()).toEqual(["work"]);
  });

  it("counts queued questions per peer", () => {
    const box = new Mailbox();
    expect(box.queuedCount("work")).toBe(0);
    box.enqueue("work", "personal", "q1");
    box.enqueue("work", "personal", "q2");
    expect(box.queuedCount("work")).toBe(2);
    expect(box.queuedCount("personal")).toBe(0);
  });

  it("lists outgoing tickets with statuses for the asking peer", () => {
    const box = new Mailbox();
    const a = box.enqueue("work", "personal", "q1");
    const b = box.enqueue("work", "personal", "q2");
    const c = box.enqueue("work", "personal", "q3");
    box.settle(b.ticket_id, { answer: "42" });
    box.settle(c.ticket_id, { error: "boom" });
    const out = box.outgoingFor("personal");
    expect(out.map((t) => [t.ticket_id, t.to_peer, t.status])).toEqual([
      [a.ticket_id, "work", "pending"],
      [b.ticket_id, "work", "answered"],
      [c.ticket_id, "work", "error"],
    ]);
    expect(box.outgoingFor("work")).toEqual([]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run relay/test/mailbox.test.ts`
Expected: FAIL on the three new tests (`knownPeers is not a function`).

- [ ] **Step 3: Implement**

In `relay/src/mailbox.ts`:

1. Extend `PendingEntry` with `from: string;` and `created_at: number;`.
2. In `enqueue`, set them: `this.pending.set(ticket_id, { peer: toPeer, from: fromPeer, created_at: now, deadline: item.deadline, settled: false, settleListeners: new Set() });`
3. Add the export and methods:

```ts
export interface OutgoingTicket {
  ticket_id: string;
  to_peer: string;
  status: "pending" | "answered" | "error";
  created_at: number;
}
```

```ts
  knownPeers(): string[] {
    return [...this.lastSeen.keys()];
  }

  queuedCount(peer: string): number {
    return this.inbox.get(peer)?.length ?? 0;
  }

  outgoingFor(peer: string): OutgoingTicket[] {
    this.cleanup();
    const result: OutgoingTicket[] = [];
    for (const [ticket_id, entry] of this.pending) {
      if (entry.from !== peer) continue;
      const status = !entry.settled ? "pending" : entry.error !== undefined ? "error" : "answered";
      result.push({ ticket_id, to_peer: entry.peer, status, created_at: entry.created_at });
    }
    return result.sort((a, b) => a.created_at - b.created_at);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run relay/test/mailbox.test.ts`
Expected: PASS (all existing tests plus 3 new).

- [ ] **Step 5: Commit (ask the user first)**

```bash
git add relay/src/mailbox.ts relay/test/mailbox.test.ts
git commit -m "feat(relay): mailbox presence list, queue depth and outgoing ticket view"
```

---

### Task 3: REST v2 (`/join`, `/invite`, `/status`)

**Files:**
- Modify: `relay/src/rest.ts`
- Modify: `relay/test/rest.test.ts`

**Interfaces:**
- Consumes: `TokenService`, `PEER_NAME_PATTERN`, `bearerToken` (Task 1), `Mailbox` additions (Task 2).
- Produces: `authPeer(req, tokens: TokenService): string | null` and `registerRest(app, mailbox, tokens: TokenService): void`. Routes added: `POST /join` (no auth, rate limited), `POST /invite` (auth), `GET /status` (auth). `/inbox/:peer`, `/answer`, `/health` keep their behavior.
- `/status` response shape (Task 9's CLI client depends on it):

```json
{
  "self": "personal",
  "self_online": true,
  "peers": [{ "name": "work", "online": false }],
  "incoming_queued": 0,
  "outgoing": [{ "ticket_id": "…", "to_peer": "work", "status": "pending", "created_at": 0 }]
}
```

- [ ] **Step 1: Update the test helper and add failing tests**

In `relay/test/rest.test.ts`, replace the imports of `loadPeersFromEnv` and the `makeApp` helper with:

```ts
import { createTokenService } from "../src/auth.js";

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
```

Update every existing test to use `ctx.workToken` / `ctx.personalToken` instead of the literal `tok-work` / `tok-personal` strings. Then append:

```ts
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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run relay/test/rest.test.ts`
Expected: FAIL (compile error first, then missing routes).

- [ ] **Step 3: Implement**

In `relay/src/rest.ts`, change the imports and signatures, keep `/health`, `/inbox/:peer`, `/answer` bodies as they are:

```ts
import type { FastifyInstance, FastifyRequest } from "fastify";
import { bearerToken, PEER_NAME_PATTERN, type TokenService } from "./auth.js";
import type { Mailbox } from "./mailbox.js";

const MAX_WAIT_SECONDS = 25;
const JOIN_WINDOW_MS = 60_000;
const JOIN_LIMIT_PER_WINDOW = 10;
const MAX_INVITE_TTL_HOURS = 720;

export function authPeer(req: FastifyRequest, tokens: TokenService): string | null {
  const token = bearerToken(req.headers.authorization);
  return token ? tokens.verifyPeerToken(token) : null;
}

export function registerRest(app: FastifyInstance, mailbox: Mailbox, tokens: TokenService): void {
```

Replace all `registry` references in the existing handlers with `tokens`. Add the new routes before the closing brace:

```ts
  const joinHits = new Map<string, { count: number; windowStart: number }>();
  const joinAllowed = (ip: string): boolean => {
    const now = Date.now();
    const hit = joinHits.get(ip);
    if (!hit || now - hit.windowStart >= JOIN_WINDOW_MS) {
      joinHits.set(ip, { count: 1, windowStart: now });
      return true;
    }
    hit.count += 1;
    return hit.count <= JOIN_LIMIT_PER_WINDOW;
  };

  app.post<{ Body: { invite?: string; name?: string } }>("/join", async (req, reply) => {
    if (!joinAllowed(req.ip)) return reply.code(429).send({ error: "too many join attempts" });
    const { invite, name } = req.body ?? {};
    if (!invite || !tokens.verifyInvite(invite)) {
      return reply.code(403).send({ error: "invalid or expired invite" });
    }
    if (!name || !PEER_NAME_PATTERN.test(name)) {
      return reply.code(400).send({ error: "name must match [A-Za-z0-9._-]{1,64}" });
    }
    if (tokens.isRevoked(name)) return reply.code(403).send({ error: "name is revoked" });
    if (mailbox.isOnline(name)) {
      return reply.code(409).send({ error: "a peer with this name is currently online" });
    }
    return { token: tokens.issuePeerToken(name), peer: name };
  });

  app.post<{ Body: { ttl_hours?: number } }>("/invite", async (req, reply) => {
    const peer = authPeer(req, tokens);
    if (!peer) return reply.code(401).send({ error: "unauthorized" });
    const ttl = req.body?.ttl_hours;
    if (ttl !== undefined && (!Number.isFinite(ttl) || ttl <= 0 || ttl > MAX_INVITE_TTL_HOURS)) {
      return reply.code(400).send({ error: `ttl_hours must be between 1 and ${MAX_INVITE_TTL_HOURS}` });
    }
    return tokens.issueInvite(ttl);
  });

  app.get("/status", async (req, reply) => {
    const peer = authPeer(req, tokens);
    if (!peer) return reply.code(401).send({ error: "unauthorized" });
    return {
      self: peer,
      self_online: mailbox.isOnline(peer),
      peers: mailbox
        .knownPeers()
        .filter((name) => name !== peer)
        .map((name) => ({ name, online: mailbox.isOnline(name) })),
      incoming_queued: mailbox.queuedCount(peer),
      outgoing: mailbox.outgoingFor(peer),
    };
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run relay/test/rest.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit (ask the user first)**

```bash
git add relay/src/rest.ts relay/test/rest.test.ts
git commit -m "feat(relay): join, invite and status endpoints on stateless auth"
```

---

### Task 4: MCP tools on live presence

**Files:**
- Modify: `relay/src/mcp.ts`
- Modify: `relay/test/mcp.test.ts`

**Interfaces:**
- Produces: `buildMcpServer(mailbox: Mailbox, fromPeer: string, options?: BuildMcpServerOptions): McpServer`. The `registry` parameter is gone. `list_peers` lists `mailbox.knownPeers()` (minus the caller). `ask_peer` no longer errors on unknown names: asking a name that never polled yields `peer_offline` with a ticket. Asking yourself is still an error.

- [ ] **Step 1: Update tests**

In `relay/test/mcp.test.ts`:

1. Delete the `makeRegistry` helper and the `loadPeersFromEnv` import.
2. Change `connect` to `buildMcpServer(mailbox, fromPeer)`.
3. Replace the unknown-peer test with:

```ts
  it("ask_peer to a never-seen peer queues the question as peer_offline", async () => {
    const mailbox = new Mailbox();
    const client = await connect(mailbox, "personal");
    const result = payload(
      await client.callTool({ name: "ask_peer", arguments: { peer: "nobody", question: "hi" } }),
    );
    expect(result.status).toBe("peer_offline");
    expect(result.ticket_id).toBeTruthy();
  });

  it("ask_peer rejects asking yourself", async () => {
    const mailbox = new Mailbox();
    const client = await connect(mailbox, "personal");
    const result = payload(
      await client.callTool({ name: "ask_peer", arguments: { peer: "personal", question: "hi" } }),
    );
    expect(result.status).toBe("error");
  });
```

4. Keep every other test, they only need the `connect` signature change.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run relay/test/mcp.test.ts`
Expected: FAIL (compile error on `buildMcpServer` arity).

- [ ] **Step 3: Implement**

In `relay/src/mcp.ts`:

1. Remove the `PeerRegistry` import and the `registry` parameter: `export function buildMcpServer(mailbox: Mailbox, fromPeer: string, options?: BuildMcpServerOptions): McpServer`.
2. Bump the server version string to `"2.0.0"`.
3. `list_peers` handler becomes:

```ts
    async () =>
      json(
        mailbox
          .knownPeers()
          .filter((name) => name !== fromPeer)
          .map((name) => ({ name, online: mailbox.isOnline(name) })),
      ),
```

4. In `ask_peer`, replace the guard with:

```ts
      if (peer === fromPeer) {
        return json({ status: "error", error: "cannot ask yourself" });
      }
```

5. Extend the `ask_peer` description with one sentence: `"Peers that are offline or unknown still get the question queued for 24 hours."`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run relay/test/mcp.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit (ask the user first)**

```bash
git add relay/src/mcp.ts relay/test/mcp.test.ts
git commit -m "feat(relay): presence-based list_peers, ask_peer without a registry"
```

---

### Task 5: Relay bootstrap on `RELAY_SECRET`, app.json, integration tests

**Files:**
- Modify: `relay/src/index.ts`
- Modify: `relay/test/index.test.ts`
- Modify: `daemon/test/integration.test.ts`
- Create: `app.json`

**Interfaces:**
- Produces: `buildApp(env)` throws unless `env.RELAY_SECRET` is set, builds `createTokenService(env.RELAY_SECRET, env.REVOKED_PEERS)`, and passes `tokens` to REST and `(mailbox, peer)` to `buildMcpServer`. The `isMain` check compares `process.argv[1]` against `import.meta.url` so importing the module from the CLI (Task 8) never auto-starts a server.

- [ ] **Step 1: Implement**

In `relay/src/index.ts`:

```ts
import { pathToFileURL } from "node:url";
import { createTokenService } from "./auth.js";
```

(remove the `loadPeersFromEnv` import). In `buildApp`:

```ts
export function buildApp(env: NodeJS.ProcessEnv = process.env): FastifyInstance {
  if (!env.RELAY_SECRET) throw new Error("RELAY_SECRET is required");
  const tokens = createTokenService(env.RELAY_SECRET, env.REVOKED_PEERS);
  const mailbox = new Mailbox();
  const app = Fastify({ logger: true });
  registerRest(app, mailbox, tokens);
```

In the `/mcp` handler replace `authPeer(req, registry)` with `authPeer(req, tokens)` and `buildMcpServer(mailbox, registry, peer)` with `buildMcpServer(mailbox, peer)`. Replace the `isMain` line with:

```ts
const isMain =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
```

Create `app.json` in the repo root:

```json
{
  "name": "agent-link relay",
  "description": "Relay for agent-link: remote MCP server plus a mailbox for responder daemons",
  "keywords": ["mcp", "agents", "cursor"],
  "env": {
    "RELAY_SECRET": {
      "description": "HMAC secret that signs peer tokens and invites. Rotating it disconnects every peer.",
      "generator": "secret"
    }
  },
  "formation": {
    "web": { "quantity": 1, "size": "basic" }
  }
}
```

- [ ] **Step 2: Update the integration tests**

In `relay/test/index.test.ts` and `daemon/test/integration.test.ts`: wherever `buildApp` is called with `PEER_TOKEN_PERSONAL` / `PEER_TOKEN_WORK` env, switch to:

```ts
import { createTokenService } from "../../relay/src/auth.js"; // path per test location

const SECRET = "e2e-secret-0123456789abcdef";
const tokens = createTokenService(SECRET);
const app = buildApp({ RELAY_SECRET: SECRET } as NodeJS.ProcessEnv);
```

and replace literal tokens: `"tok-personal"` becomes `tokens.issuePeerToken("personal")`, `"tok-work"` becomes `tokens.issuePeerToken("work")` (both in `Authorization` headers and in the daemon `config.token`).

- [ ] **Step 3: Run the full suite and a smoke test**

```bash
npm test
npm run build -w relay
RELAY_SECRET=smoke-secret-0123456789 PORT=3900 node relay/dist/index.js &
sleep 1
curl -s http://localhost:3900/health
curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3900/join \
  -H 'content-type: application/json' -d '{"invite":"junk","name":"x"}'
kill %1
```

Expected: all tests pass, `{"ok":true}`, then `403`.

- [ ] **Step 4: Verify app.json**

Run: `node -e "JSON.parse(require('node:fs').readFileSync('app.json','utf8')); console.log('OK')"`
Expected: `OK`.

- [ ] **Step 5: Commit (ask the user first)**

```bash
git add relay/src/index.ts relay/test/index.test.ts daemon/test/integration.test.ts app.json
git commit -m "feat(relay): RELAY_SECRET bootstrap and Heroku deploy button config"
```

---

### Task 6: Daemon per-conversation workspaces and prune

**Files:**
- Create: `daemon/src/workspace.ts`
- Modify: `daemon/src/config.ts`, `daemon/src/handler.ts`, `daemon/src/index.ts`
- Create: `daemon/test/workspace.test.ts`
- Modify: `daemon/test/handler.test.ts`

**Interfaces:**
- Produces `daemon/src/workspace.ts`:

```ts
export function safeDirName(id: string): string; // id if /^[A-Za-z0-9._-]{1,64}$/, else sha256 hex
export function pruneWorkspaces(workspaceRoot: string, maxAgeMs?: number): number; // removed dir count
```

- Produces config field `responder.max_concurrent?: number` (validated positive integer when present). Task 7's poller reads it.
- The handler runs each conversation in `<workspace_dir>/<safeDirName(conversation_id)>`.

- [ ] **Step 1: Write the failing tests**

`daemon/test/workspace.test.ts`:

```ts
import { mkdirSync, mkdtempSync, existsSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pruneWorkspaces, safeDirName } from "../src/workspace.js";

describe("safeDirName", () => {
  it("keeps safe ids and hashes unsafe ones", () => {
    expect(safeDirName("0198f-uuid-like")).toBe("0198f-uuid-like");
    const hashed = safeDirName("../../escape");
    expect(hashed).toMatch(/^[0-9a-f]{64}$/);
    expect(safeDirName("a".repeat(65))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("pruneWorkspaces", () => {
  it("removes only directories older than the cutoff", () => {
    const root = mkdtempSync(path.join(tmpdir(), "agent-link-ws-"));
    const oldDir = path.join(root, "old-conv");
    const newDir = path.join(root, "new-conv");
    mkdirSync(oldDir);
    mkdirSync(newDir);
    writeFileSync(path.join(root, "task.md"), "legacy file, must be ignored");
    const stale = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(oldDir, stale, stale);
    const removed = pruneWorkspaces(root, 7 * 24 * 60 * 60 * 1000);
    expect(removed).toBe(1);
    expect(existsSync(oldDir)).toBe(false);
    expect(existsSync(newDir)).toBe(true);
    expect(existsSync(path.join(root, "task.md"))).toBe(true);
  });

  it("tolerates a missing root", () => {
    expect(pruneWorkspaces("/nonexistent/agent-link-root")).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run daemon/test/workspace.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement workspace.ts**

```ts
import { createHash } from "node:crypto";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

const SAFE_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function safeDirName(id: string): string {
  return SAFE_ID_PATTERN.test(id) ? id : createHash("sha256").update(id).digest("hex");
}

export function pruneWorkspaces(workspaceRoot: string, maxAgeMs = DEFAULT_MAX_AGE_MS): number {
  if (!existsSync(workspaceRoot)) return 0;
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const entry of readdirSync(workspaceRoot)) {
    const full = path.join(workspaceRoot, entry);
    try {
      const info = statSync(full);
      if (!info.isDirectory() || info.mtimeMs > cutoff) continue;
      rmSync(full, { recursive: true, force: true });
      removed += 1;
    } catch {
      // a conversation may be running and touching files, skip it
    }
  }
  return removed;
}
```

- [ ] **Step 4: Wire config, handler and daemon entry**

`daemon/src/config.ts`: add `max_concurrent?: number;` to the `responder` block of `DaemonConfig` and, next to the `response_timeout_seconds` validation:

```ts
  if (
    config.responder.max_concurrent !== undefined &&
    (!Number.isInteger(config.responder.max_concurrent) || config.responder.max_concurrent <= 0)
  ) {
    throw new Error("config: responder.max_concurrent must be a positive integer");
  }
```

`daemon/src/handler.ts`: import `safeDirName` from `./workspace.js`, rename the module-level options object to `baseRunnerOpts`, and build per-question options inside the returned handler:

```ts
  return async (question) => {
    const runnerOpts: RunnerOptions = {
      ...baseRunnerOpts,
      workspaceDir: path.join(
        config.responder.workspace_dir,
        safeDirName(question.conversation_id),
      ),
    };
    try {
```

(the rest of the handler body is unchanged, it already uses `runnerOpts`).

`daemon/src/index.ts`: after `const config = loadConfig();` add:

```ts
  const { pruneWorkspaces } = await import("./workspace.js");
  const pruned = pruneWorkspaces(config.responder.workspace_dir);
  if (pruned > 0) console.log(`pruned ${pruned} stale conversation workspace(s)`);
```

(a static import at the top of the file is equally fine; prefer the static import.)

`daemon/test/handler.test.ts`: update every assertion that reads `<workspace>/task.md` to read `<workspace>/<conversation_id>/task.md`, where `<conversation_id>` is the id of the question the test sends. Add one new assertion in an existing test: two questions with different `conversation_id` values leave two separate `task.md` files.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run daemon/test/workspace.test.ts daemon/test/handler.test.ts daemon/test/config.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit (ask the user first)**

```bash
git add daemon/src/workspace.ts daemon/src/config.ts daemon/src/handler.ts daemon/src/index.ts daemon/test/workspace.test.ts daemon/test/handler.test.ts
git commit -m "feat(daemon): per-conversation workspaces with 7-day prune"
```

---

### Task 7: Daemon concurrent question handling

**Files:**
- Modify: `daemon/src/poller.ts`
- Modify: `daemon/test/poller.test.ts`

**Interfaces:**
- Produces on `Poller` (constructor signature unchanged):
  - `pollOnce(signal?)` now dispatches handling asynchronously and returns `"handled"` as soon as the question is accepted. It blocks while `max_concurrent` (from `config.responder.max_concurrent`, default 3) handlers are in flight.
  - `drain(): Promise<void>` waits for all in-flight handlers and deliveries to finish. `run()` calls it after the loop exits.

- [ ] **Step 1: Update existing tests and add the concurrency test**

In `daemon/test/poller.test.ts`:

1. In the test `"handles a question and posts the answer"`, insert `await poller.drain();` between the `pollOnce` assertion and the assertions on `calls[1]` (delivery is now asynchronous).
2. Any other test that asserts on the `/answer` call must also `await poller.drain()` first.
3. Append:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run daemon/test/poller.test.ts`
Expected: FAIL (`drain` missing, third poll does not block).

- [ ] **Step 3: Implement**

In `daemon/src/poller.ts`:

1. Add near the other constants: `const DEFAULT_MAX_CONCURRENT = 3;`
2. Add fields and constructor line:

```ts
  private readonly maxConcurrent: number;
  private readonly inFlight = new Set<Promise<void>>();
```

```ts
    this.maxConcurrent = config.responder.max_concurrent ?? DEFAULT_MAX_CONCURRENT;
```

3. Rework `pollOnce`: keep the inbox fetch, the 401/403, 204 and `!res.ok` branches exactly as they are. Insert a slot gate at the very top:

```ts
    while (this.inFlight.size >= this.maxConcurrent) {
      if (signal?.aborted) return "retry";
      await Promise.race([...this.inFlight]);
    }
    if (signal?.aborted) return "retry";
```

Replace everything after the `if (!res.ok)` branch (the old parse-handle-deliver block) with:

```ts
    let question: Question;
    try {
      question = (await res.json()) as Question;
    } catch {
      console.error("failed to parse inbox response JSON");
      await this.backoff(MAX_BACKOFF_MS, signal);
      return "retry";
    }
    this.backoffMs = INITIAL_BACKOFF_MS;
    let job: Promise<void>;
    job = this.handleAndDeliver(question, signal).finally(() => {
      this.inFlight.delete(job);
    });
    this.inFlight.add(job);
    return "handled";
```

4. Add the two methods:

```ts
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  private async handleAndDeliver(question: Question, signal?: AbortSignal): Promise<void> {
    const headers = {
      authorization: `Bearer ${this.config.token}`,
      "content-type": "application/json",
    };
    let result: { answer?: string; error?: string };
    try {
      result = await this.handle(question);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result = { error: `handler crashed: ${message.slice(0, 500)}` };
    }
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const res = await this.fetchImpl(`${this.config.relay_url}/answer`, {
          method: "POST",
          headers,
          body: JSON.stringify({ ticket_id: question.ticket_id, ...result }),
          signal,
        });
        if (res.ok) return;
        if (res.status >= 400 && res.status < 500) {
          console.error(
            `relay rejected answer for ticket ${question.ticket_id} (HTTP ${res.status}), not retrying`,
          );
          return;
        }
      } catch {
        if (signal?.aborted) return;
      }
      if (attempt < 3) {
        await this.wait(1000, signal);
        if (signal?.aborted) return;
      }
    }
    console.error(`failed to deliver answer for ticket ${question.ticket_id}`);
  }
```

5. `run` becomes:

```ts
  async run(signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      await this.pollOnce(signal);
    }
    await this.drain();
  }
```

`backoff`, `wait` and `sleepWithTimer` stay as they are.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run daemon/test/poller.test.ts daemon/test/integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit (ask the user first)**

```bash
git add daemon/src/poller.ts daemon/test/poller.test.ts
git commit -m "feat(daemon): concurrent question handling with a slot limit"
```

---

### Task 8: Packaging: publishable root, `cli` workspace, `agent-link relay`

**Files:**
- Modify: `package.json`, `tsconfig.base.json`, `relay/package.json`, `daemon/package.json`
- Create: `cli/package.json`, `cli/tsconfig.json`, `cli/src/index.ts`, `cli/src/relay.ts`

**Interfaces:**
- Produces: one publishable npm package `agent-link` (root) with `bin.agent-link -> cli/dist/index.js`. Runtime deps live in the root `package.json`. `relay/dist` and `daemon/dist` ship declaration files so `cli/src` can import them with types via relative paths (`../../relay/dist/index.js`). Later tasks add commands to `cli/src/index.ts`.

- [ ] **Step 1: Move dependencies to the root and make it publishable**

Root `package.json` becomes:

```json
{
  "name": "agent-link",
  "version": "2.0.0",
  "description": "Connect AI agents from different accounts so one can ask the other questions answered from its own memory",
  "license": "MIT",
  "type": "module",
  "engines": { "node": "22.x" },
  "workspaces": ["relay", "daemon", "cli"],
  "bin": { "agent-link": "cli/dist/index.js" },
  "files": ["cli/dist", "relay/dist", "daemon/dist", "daemon/launchd", "app.json"],
  "scripts": {
    "build": "npm run build -w relay && npm run build -w daemon && npm run build -w cli",
    "prepack": "npm run build",
    "test": "vitest run"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "fastify": "^5.10.0",
    "uuid": "^14.0.1",
    "zod": "^4.4.3",
    "fast-glob": "^3.3.3"
  },
  "devDependencies": {
    "@types/node": "^26.1.1",
    "typescript": "^7.0.2",
    "vitest": "^4.1.10"
  }
}
```

(the `daemon:*` scripts are removed on purpose, the CLI replaces them in Task 10). Remove the `dependencies` blocks from `relay/package.json` and `daemon/package.json` (keep name, private, type, scripts). In `tsconfig.base.json` add `"declaration": true` to `compilerOptions`.

`cli/package.json`:

```json
{
  "name": "cli",
  "private": true,
  "type": "module",
  "scripts": { "build": "tsc" }
}
```

`cli/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

- [ ] **Step 2: Create the CLI skeleton**

`cli/src/index.ts` (the shebang line must be first, tsc preserves it):

```ts
#!/usr/bin/env node
import { runRelay } from "./relay.js";

const USAGE = `Usage: agent-link <command>

Commands:
  join <relay-url> <invite>   connect this machine to a relay
  invite [--ttl <hours>] [--secret <relay-secret>]
                              create an invite code for a new machine
  status                      show daemon state, peers and dialogs
  start | stop | restart      control the responder daemon
  logs [-f]                   show responder logs
  relay                       run the relay server (requires RELAY_SECRET)
`;

async function main(): Promise<void> {
  const [command] = process.argv.slice(2);
  switch (command) {
    case "relay":
      await runRelay();
      return;
    default:
      console.log(USAGE);
      process.exitCode = command === undefined || command === "help" ? 0 : 2;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
```

`cli/src/relay.ts`:

```ts
export async function runRelay(): Promise<void> {
  const { buildApp } = await import("../../relay/dist/index.js");
  const app = buildApp();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen({ port, host: "0.0.0.0" });
}
```

- [ ] **Step 3: Build and smoke-test**

```bash
npm install
npm run build
node cli/dist/index.js help
RELAY_SECRET=smoke-secret-0123456789 PORT=3901 node cli/dist/index.js relay &
sleep 1
curl -s http://localhost:3901/health
kill %1
npm pack --dry-run
```

Expected: usage text, `{"ok":true}`, and the pack list contains `cli/dist`, `relay/dist`, `daemon/dist`, `daemon/launchd`. If `relay dist` import fails in `cli` typecheck, confirm `relay/dist/index.d.ts` exists (declaration flag) and rebuild relay first.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS (dependency hoisting must not break existing imports).

- [ ] **Step 5: Commit (ask the user first)**

```bash
git add package.json tsconfig.base.json relay/package.json daemon/package.json cli
git commit -m "feat(cli): publishable agent-link package with relay command"
```

---

### Task 9: CLI relay client and machine setup writers

**Files:**
- Create: `cli/src/api.ts`, `cli/src/setup.ts`
- Test: `cli/test/api.test.ts`, `cli/test/setup.test.ts`

**Interfaces:**
- Produces `cli/src/api.ts`:

```ts
export interface JoinResult { token: string; peer: string }
export interface InviteResult { invite: string; expires_at: number }
export interface RelayStatus {
  self: string;
  self_online: boolean;
  peers: Array<{ name: string; online: boolean }>;
  incoming_queued: number;
  outgoing: Array<{ ticket_id: string; to_peer: string; status: string; created_at: number }>;
}
export function normalizeRelayUrl(url: string): string;
export function joinRelay(relayUrl: string, invite: string, name: string, fetchImpl?: typeof fetch): Promise<JoinResult>;
export function requestInvite(relayUrl: string, token: string, ttlHours?: number, fetchImpl?: typeof fetch): Promise<InviteResult>;
export function fetchStatus(relayUrl: string, token: string, fetchImpl?: typeof fetch): Promise<RelayStatus>;
```

- Produces `cli/src/setup.ts` (every function takes `home` explicitly so tests can use a temp dir):

```ts
export interface MemoryDiscovery { agents_md_roots: string[]; extra_files: string[] }
export function discoverMemorySources(home: string): MemoryDiscovery;
export function defaultConfig(relayUrl: string, peer: string, token: string, discovery: MemoryDiscovery): object;
export function writeConfig(home: string, config: object): string;      // returns file path, mode 0600
export function writeDefaultPolicy(home: string): boolean;              // false if policy.md existed
export function mergeMcpJson(home: string, relayUrl: string, token: string): string; // backs up to .bak
```

- [ ] **Step 1: Write the failing tests**

`cli/test/api.test.ts`:

```ts
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
```

`cli/test/setup.test.ts`:

```ts
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultConfig,
  discoverMemorySources,
  mergeMcpJson,
  writeConfig,
  writeDefaultPolicy,
} from "../src/setup.js";

function makeHome(): string {
  return mkdtempSync(path.join(tmpdir(), "agent-link-home-"));
}

describe("discoverMemorySources", () => {
  it("finds AGENTS.md roots and global cursor markdown", () => {
    const home = makeHome();
    mkdirSync(path.join(home, "dev/proj"), { recursive: true });
    writeFileSync(path.join(home, "dev/proj/AGENTS.md"), "memory");
    mkdirSync(path.join(home, ".cursor"), { recursive: true });
    writeFileSync(path.join(home, ".cursor/SKILLS_INDEX.md"), "index");
    const found = discoverMemorySources(home);
    expect(found.agents_md_roots).toEqual([path.join(home, "dev")]);
    expect(found.extra_files).toEqual([path.join(home, ".cursor/SKILLS_INDEX.md")]);
  });

  it("returns empty lists for a bare home", () => {
    expect(discoverMemorySources(makeHome())).toEqual({ agents_md_roots: [], extra_files: [] });
  });
});

describe("writeConfig", () => {
  it("writes 0600 config json under ~/.agent-link", () => {
    const home = makeHome();
    const file = writeConfig(home, defaultConfig("https://r.example.com", "mbp", "tok", {
      agents_md_roots: [], extra_files: [],
    }));
    expect(file).toBe(path.join(home, ".agent-link/config.json"));
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { self_peer: string; responder: { max_concurrent: number } };
    expect(parsed.self_peer).toBe("mbp");
    expect(parsed.responder.max_concurrent).toBe(3);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("writeDefaultPolicy", () => {
  it("creates policy.md once and never overwrites", () => {
    const home = makeHome();
    expect(writeDefaultPolicy(home)).toBe(true);
    const file = path.join(home, ".agent-link/policy.md");
    writeFileSync(file, "customized");
    expect(writeDefaultPolicy(home)).toBe(false);
    expect(readFileSync(file, "utf8")).toBe("customized");
  });
});

describe("mergeMcpJson", () => {
  it("merges into an existing mcp.json with a backup", () => {
    const home = makeHome();
    mkdirSync(path.join(home, ".cursor"), { recursive: true });
    const file = path.join(home, ".cursor/mcp.json");
    writeFileSync(file, JSON.stringify({ mcpServers: { other: { url: "http://x" } } }));
    mergeMcpJson(home, "https://r.example.com", "tok");
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      mcpServers: Record<string, { url: string; headers: Record<string, string> }>;
    };
    expect(parsed.mcpServers.other.url).toBe("http://x");
    expect(parsed.mcpServers["agent-link"]).toEqual({
      url: "https://r.example.com/mcp",
      headers: { Authorization: "Bearer tok" },
    });
    expect(readFileSync(`${file}.bak`, "utf8")).toContain("other");
  });

  it("creates mcp.json when missing", () => {
    const home = makeHome();
    const file = mergeMcpJson(home, "https://r.example.com", "tok");
    expect(JSON.parse(readFileSync(file, "utf8"))).toHaveProperty("mcpServers.agent-link");
  });
});
```

Add the new test globs to `vitest.config.ts`: include `"cli/test/**/*.test.ts"`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run cli/test`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement api.ts**

```ts
export interface JoinResult {
  token: string;
  peer: string;
}

export interface InviteResult {
  invite: string;
  expires_at: number;
}

export interface RelayStatus {
  self: string;
  self_online: boolean;
  peers: Array<{ name: string; online: boolean }>;
  incoming_queued: number;
  outgoing: Array<{ ticket_id: string; to_peer: string; status: string; created_at: number }>;
}

export function normalizeRelayUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

async function requestJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<T> {
  const res = await fetchImpl(url, init);
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) detail = `${detail}: ${body.error}`;
    } catch {
      // non-JSON error body, keep the status code only
    }
    throw new Error(`relay request failed (${detail})`);
  }
  return (await res.json()) as T;
}

export async function joinRelay(
  relayUrl: string,
  invite: string,
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<JoinResult> {
  return requestJson<JoinResult>(fetchImpl, `${normalizeRelayUrl(relayUrl)}/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ invite, name }),
  });
}

export async function requestInvite(
  relayUrl: string,
  token: string,
  ttlHours?: number,
  fetchImpl: typeof fetch = fetch,
): Promise<InviteResult> {
  return requestJson<InviteResult>(fetchImpl, `${normalizeRelayUrl(relayUrl)}/invite`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(ttlHours !== undefined ? { ttl_hours: ttlHours } : {}),
  });
}

export async function fetchStatus(
  relayUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RelayStatus> {
  return requestJson<RelayStatus>(fetchImpl, `${normalizeRelayUrl(relayUrl)}/status`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
}
```

- [ ] **Step 4: Implement setup.ts**

```ts
import fg from "fast-glob";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface MemoryDiscovery {
  agents_md_roots: string[];
  extra_files: string[];
}

const DEV_ROOT_CANDIDATES = [
  "dev",
  "Documents/dev",
  "Projects",
  "projects",
  "code",
  "src",
  "work",
  "Developer",
];

const DEFAULT_POLICY = `You are answering an agent from another account of the same human circle.
Answer questions about actions, achievements, habits and goals based on the
chat history and memory files listed in the task.

Rules:
- Never disclose secrets, keys, tokens, passwords or credentials of any kind.
- When in doubt, generalise or decline to answer that specific point and
  briefly explain why.
`;

export function discoverMemorySources(home: string): MemoryDiscovery {
  const agents_md_roots: string[] = [];
  for (const rel of DEV_ROOT_CANDIDATES) {
    const root = path.join(home, rel);
    if (!existsSync(root)) continue;
    const found = fg.sync("**/AGENTS.md", { cwd: root, deep: 4, suppressErrors: true });
    if (found.length > 0) agents_md_roots.push(root);
  }
  const cursorDir = path.join(home, ".cursor");
  const extra_files = existsSync(cursorDir)
    ? fg.sync("*.md", { cwd: cursorDir, absolute: true, suppressErrors: true })
    : [];
  return { agents_md_roots, extra_files };
}

export function defaultConfig(
  relayUrl: string,
  peer: string,
  token: string,
  discovery: MemoryDiscovery,
): object {
  return {
    relay_url: relayUrl,
    self_peer: peer,
    token,
    memory_sources: {
      transcripts_glob: "~/.cursor/projects/*/agent-transcripts/**/*.jsonl",
      agents_md_roots: discovery.agents_md_roots,
      extra_files: discovery.extra_files,
    },
    responder: {
      cursor_agent_binary: "cursor-agent",
      workspace_dir: "~/.agent-link/workspace",
      response_timeout_seconds: 300,
      max_concurrent: 3,
      model: "composer-2.5",
    },
    redact: { literals: [], patterns: [] },
  };
}

export function writeConfig(home: string, config: object): string {
  const dir = path.join(home, ".agent-link");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "config.json");
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return file;
}

export function writeDefaultPolicy(home: string): boolean {
  const dir = path.join(home, ".agent-link");
  const file = path.join(dir, "policy.md");
  if (existsSync(file)) return false;
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, DEFAULT_POLICY);
  return true;
}

export function mergeMcpJson(home: string, relayUrl: string, token: string): string {
  const file = path.join(home, ".cursor", "mcp.json");
  mkdirSync(path.dirname(file), { recursive: true });
  let data: { mcpServers?: Record<string, unknown> } = {};
  if (existsSync(file)) {
    const raw = readFileSync(file, "utf8");
    try {
      data = JSON.parse(raw) as typeof data;
    } catch {
      data = {};
    }
    writeFileSync(`${file}.bak`, raw);
  }
  if (!data.mcpServers || typeof data.mcpServers !== "object") data.mcpServers = {};
  data.mcpServers["agent-link"] = {
    url: `${relayUrl.replace(/\/+$/, "")}/mcp`,
    headers: { Authorization: `Bearer ${token}` },
  };
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return file;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run cli/test`
Expected: PASS.

- [ ] **Step 6: Commit (ask the user first)**

```bash
git add cli/src/api.ts cli/src/setup.ts cli/test vitest.config.ts
git commit -m "feat(cli): relay client and machine setup writers"
```

---

### Task 10: CLI commands: join, invite, status, daemon control

**Files:**
- Create: `cli/src/launchd.ts`, `cli/src/join.ts`, `cli/src/invite.ts`, `cli/src/status.ts`
- Modify: `cli/src/index.ts`

**Interfaces:**
- Consumes: Task 9 modules, `daemon/dist/config.js` (`loadConfig`), `relay/dist/auth.js` (`createTokenService`, for the `--secret` bootstrap path), the plist template in `daemon/launchd/`.
- Produces: full `agent-link` command set. `launchd.ts` exports `installDaemon(home)`, `startDaemon(home)`, `stopDaemon(home)`, `isDaemonRunning()`, `packageRoot()`.
- These modules shell out to `launchctl` and write into the real home dir, so they are covered by the manual e2e in Task 12, not by unit tests. Keep all logic that is unit-testable inside `api.ts`/`setup.ts`.

- [ ] **Step 1: Implement launchd.ts**

```ts
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LABEL = "com.agent-link.responder";

export function packageRoot(): string {
  // cli/dist/launchd.js -> package root is two levels up
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

export function plistDestination(home: string): string {
  return path.join(home, "Library/LaunchAgents", `${LABEL}.plist`);
}

export function renderPlist(nodeBin: string, repoRoot: string, home: string): string {
  const template = readFileSync(
    path.join(repoRoot, "daemon/launchd", `${LABEL}.plist`),
    "utf8",
  );
  return template
    .replaceAll("__NODE__", nodeBin)
    .replaceAll("__REPO__", repoRoot)
    .replaceAll("__HOME__", home);
}

export function installDaemon(home: string): void {
  const root = packageRoot();
  const daemonEntry = path.join(root, "daemon/dist/index.js");
  if (!existsSync(daemonEntry)) {
    throw new Error(`daemon build not found at ${daemonEntry}, run: npm run build`);
  }
  mkdirSync(path.join(home, ".agent-link/workspace"), { recursive: true });
  chmodSync(path.join(home, ".agent-link/config.json"), 0o600);
  const dst = plistDestination(home);
  mkdirSync(path.dirname(dst), { recursive: true });
  writeFileSync(dst, renderPlist(process.execPath, root, home));
  spawnSync("launchctl", ["unload", dst], { stdio: "ignore" });
  execFileSync("launchctl", ["load", dst]);
}

export function startDaemon(home: string): void {
  execFileSync("launchctl", ["load", plistDestination(home)]);
}

export function stopDaemon(home: string): void {
  spawnSync("launchctl", ["unload", plistDestination(home)], { stdio: "ignore" });
}

export function isDaemonRunning(): boolean {
  const out = spawnSync("launchctl", ["list"], { encoding: "utf8" });
  return out.stdout?.split("\n").some((line) => line.includes(LABEL)) ?? false;
}
```

- [ ] **Step 2: Implement join.ts**

```ts
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { fetchStatus, joinRelay, normalizeRelayUrl } from "./api.js";
import { installDaemon } from "./launchd.js";
import {
  defaultConfig,
  discoverMemorySources,
  mergeMcpJson,
  writeConfig,
  writeDefaultPolicy,
} from "./setup.js";

const NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export async function runJoin(relayUrlArg: string, invite: string): Promise<void> {
  const relayUrl = normalizeRelayUrl(relayUrlArg);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let name = "";
  try {
    while (!NAME_PATTERN.test(name)) {
      name = (await rl.question("Peer name for this machine (letters, digits, . _ -): ")).trim();
    }
  } finally {
    rl.close();
  }

  const { token, peer } = await joinRelay(relayUrl, invite, name);
  console.log(`joined the relay as "${peer}"`);

  const home = homedir();
  const discovery = discoverMemorySources(home);
  if (discovery.agents_md_roots.length > 0) {
    console.log(`memory roots: ${discovery.agents_md_roots.join(", ")}`);
  }
  const configPath = writeConfig(home, defaultConfig(relayUrl, peer, token, discovery));
  console.log(`wrote ${configPath}`);
  if (writeDefaultPolicy(home)) console.log("wrote default ~/.agent-link/policy.md");
  const mcpPath = mergeMcpJson(home, relayUrl, token);
  console.log(`updated ${mcpPath}`);

  installDaemon(home);
  console.log("installed and started the responder daemon");

  for (let i = 0; i < 15; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    try {
      const status = await fetchStatus(relayUrl, token);
      if (status.self_online) {
        console.log("daemon is online, setup complete");
        console.log("restart Cursor so it picks up the agent-link MCP server");
        return;
      }
    } catch {
      // relay may briefly reject while the daemon warms up, keep waiting
    }
  }
  console.error("daemon did not come online within 30s, check: agent-link logs");
  process.exitCode = 1;
}
```

- [ ] **Step 3: Implement invite.ts and status.ts**

`cli/src/invite.ts` (the `--secret` path solves the bootstrap chicken-and-egg: the very first machine has no token yet, but the relay operator knows `RELAY_SECRET` and can mint an invite locally):

```ts
import { parseArgs } from "node:util";
import { requestInvite } from "./api.js";

export async function runInvite(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { ttl: { type: "string" }, secret: { type: "string" } },
  });
  const ttl = values.ttl !== undefined ? Number(values.ttl) : undefined;
  if (values.ttl !== undefined && (!Number.isFinite(ttl) || (ttl as number) <= 0)) {
    throw new Error("--ttl must be a positive number of hours");
  }

  if (values.secret) {
    const { createTokenService } = await import("../../relay/dist/auth.js");
    const { invite, expires_at } = createTokenService(values.secret).issueInvite(ttl);
    printInvite(invite, expires_at);
    return;
  }

  const { loadConfig } = await import("../../daemon/dist/config.js");
  const config = loadConfig();
  const result = await requestInvite(config.relay_url, config.token, ttl);
  printInvite(result.invite, result.expires_at, config.relay_url);
}

function printInvite(invite: string, expiresAt: number, relayUrl?: string): void {
  console.log(`invite (valid until ${new Date(expiresAt).toISOString()}):`);
  console.log(`  ${invite}`);
  if (relayUrl) {
    console.log("on the new machine run:");
    console.log(`  npx agent-link join ${relayUrl} ${invite}`);
  }
}
```

`cli/src/status.ts`:

```ts
import { fetchStatus } from "./api.js";
import { isDaemonRunning } from "./launchd.js";

export async function runStatus(): Promise<void> {
  const { loadConfig } = await import("../../daemon/dist/config.js");
  const config = loadConfig();
  console.log(`peer:   ${config.self_peer}`);
  console.log(`relay:  ${config.relay_url}`);
  console.log(`daemon: ${isDaemonRunning() ? "running" : "stopped"}`);
  try {
    const status = await fetchStatus(config.relay_url, config.token);
    console.log(`relay sees this peer: ${status.self_online ? "online" : "offline"}`);
    console.log(`incoming queued: ${status.incoming_queued}`);
    if (status.peers.length === 0) {
      console.log("peers: none seen since the last relay restart");
    }
    for (const peer of status.peers) {
      console.log(`peer: ${peer.name} (${peer.online ? "online" : "offline"})`);
    }
    for (const ticket of status.outgoing) {
      console.log(`outgoing ${ticket.ticket_id} -> ${ticket.to_peer}: ${ticket.status}`);
    }
  } catch (err) {
    console.error(`relay unreachable: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
```

- [ ] **Step 4: Wire the dispatch**

Replace `cli/src/index.ts` main switch (keep the shebang and USAGE from Task 8):

```ts
#!/usr/bin/env node
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { runInvite } from "./invite.js";
import { runJoin } from "./join.js";
import { startDaemon, stopDaemon } from "./launchd.js";
import { runRelay } from "./relay.js";
import { runStatus } from "./status.js";

const USAGE = `Usage: agent-link <command>

Commands:
  join <relay-url> <invite>   connect this machine to a relay
  invite [--ttl <hours>] [--secret <relay-secret>]
                              create an invite code for a new machine
  status                      show daemon state, peers and dialogs
  start | stop | restart      control the responder daemon
  logs [-f]                   show responder logs
  relay                       run the relay server (requires RELAY_SECRET)
`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const home = homedir();
  switch (command) {
    case "join": {
      const [relayUrl, invite] = rest;
      if (!relayUrl || !invite) {
        console.error("usage: agent-link join <relay-url> <invite>");
        process.exit(2);
      }
      await runJoin(relayUrl, invite);
      return;
    }
    case "invite":
      await runInvite(rest);
      return;
    case "status":
      await runStatus();
      return;
    case "start":
      startDaemon(home);
      console.log("daemon started");
      return;
    case "stop":
      stopDaemon(home);
      console.log("daemon stopped");
      return;
    case "restart":
      stopDaemon(home);
      startDaemon(home);
      console.log("daemon restarted");
      return;
    case "logs": {
      const logPath = path.join(home, ".agent-link/responder.log");
      const args = rest.includes("-f") ? ["-n", "50", "-f", logPath] : ["-n", "50", logPath];
      spawn("tail", args, { stdio: "inherit" });
      return;
    }
    case "relay":
      await runRelay();
      return;
    default:
      console.log(USAGE);
      process.exitCode = command === undefined || command === "help" ? 0 : 2;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
```

- [ ] **Step 5: Build and smoke-test locally (no launchctl side effects)**

```bash
npm run build
node cli/dist/index.js help
node cli/dist/index.js invite --secret smoke-secret-0123456789 --ttl 1
npm test
```

Expected: usage text, a printed `ali1.…` invite with an expiry roughly one hour ahead, all tests pass.

- [ ] **Step 6: Commit (ask the user first)**

```bash
git add cli/src
git commit -m "feat(cli): join, invite, status and daemon control commands"
```

---

### Task 11: Deploy artifacts, docs and script cleanup

**Files:**
- Create: `Dockerfile`
- Modify: `README.md`
- Delete: `scripts/setup-machine.sh`, `scripts/install-daemon.sh`, `scripts/daemon.sh`
- Modify: `.cursor/skills/agent-link-setup/SKILL.md`, `.cursor/skills/agent-link-relay/SKILL.md`, `.cursor/skills/agent-link-troubleshoot/SKILL.md`, `.cursor/skills/agent-link-ask/SKILL.md`, `.cursor/skills/agent-link-answer/SKILL.md`, `.cursor/skills/agent-link-privacy/SKILL.md`, `.cursor/skills/agent-link-dev/SKILL.md`

**Interfaces:**
- Consumes: everything shipped in Tasks 1-10.

- [ ] **Step 1: Create the Dockerfile**

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json vitest.config.ts ./
COPY relay ./relay
COPY daemon ./daemon
COPY cli ./cli
RUN npm ci && npm run build && npm prune --omit=dev
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "relay/dist/index.js"]
```

Verify: `docker build -t agent-link-relay .` (skip if Docker is not installed locally, note it in the task report).

- [ ] **Step 2: Delete the absorbed scripts**

```bash
git rm scripts/setup-machine.sh scripts/install-daemon.sh scripts/daemon.sh
```

`scripts/skills.sh` stays.

- [ ] **Step 3: Update README.md**

Replace the setup instructions with a v2 quick start (keep the project description and license sections):

````markdown
## Deploy a relay (once per circle)

[![Deploy on Heroku](https://www.herokucdn.com/deploy/button.svg)](https://heroku.com/deploy)

The button generates `RELAY_SECRET` automatically. Alternatives:

```bash
# any machine with Node 22
RELAY_SECRET=$(openssl rand -hex 32) npx agent-link relay

# or Docker
docker build -t agent-link-relay . && docker run -e RELAY_SECRET=... -p 3000:3000 agent-link-relay
```

## Connect a machine

The relay operator creates the first invite with the secret:

```bash
npx agent-link invite --secret <RELAY_SECRET>
```

Every joined machine can invite the next one:

```bash
agent-link invite
```

The new machine joins with one command (it writes the config, installs the
launchd daemon and registers the MCP server in Cursor):

```bash
npx agent-link join https://your-relay.example.com <invite>
```

## Day-to-day

```bash
agent-link status     # daemon state, peers, active dialogs
agent-link logs -f    # follow responder logs
agent-link restart    # after editing ~/.agent-link/config.json or policy.md
```
````

- [ ] **Step 4: Update the skills**

Apply this mapping in every `SKILL.md` under `.cursor/skills/agent-link-*`, keeping each skill's structure:

- `scripts/setup-machine.sh` (any invocation) becomes `npx agent-link join <relay-url> <invite>`.
- `npm run daemon:status|logs|restart|stop|start` becomes `agent-link status|logs|restart|stop|start`.
- Any mention of `PEER_TOKEN_*` config vars becomes `RELAY_SECRET` (one secret on the relay) plus invite codes.
- Any mention of registering peers via `heroku config:set PEER_TOKEN_...` is replaced by the invite flow: `agent-link invite` on a member machine, or `npx agent-link invite --secret <RELAY_SECRET>` for the first machine.
- `agent-link-relay/SKILL.md`: deploying is now the Heroku button (`app.json`) or `npx agent-link relay`; config vars are `RELAY_SECRET` and optional `REVOKED_PEERS`.
- `agent-link-troubleshoot/SKILL.md`: add two checks: `agent-link status` as the first diagnostic, and "peer missing from list_peers right after a relay restart is normal until its daemon polls again".

Read each file before editing; do not delete skill-specific content that still applies.

- [ ] **Step 5: Run the full suite one more time**

Run: `npm test && npm run build`
Expected: PASS.

- [ ] **Step 6: Commit (ask the user first)**

```bash
git add -A
git commit -m "docs: v2 deploy artifacts, README quick start, CLI-based skills"
```

---

### Task 12: Deploy and manual e2e (manual, with the user)

**Files:** none. Manual operations, every push needs the user's explicit command.

- [ ] **Step 1: Reconfigure the Heroku app (ask the user first)**

```bash
heroku config:set RELAY_SECRET=$(openssl rand -hex 32) -a mcp-ivan-connector
heroku config:unset PEER_TOKEN_PERSONAL PEER_TOKEN_WORK -a mcp-ivan-connector
```

- [ ] **Step 2: Deploy (requires an explicit push command from the user)**

```bash
git push heroku main
curl -s https://mcp-ivan-connector-c134d42b797f.herokuapp.com/health
```

Expected: `{"ok":true}`.

- [ ] **Step 3: Re-join this machine**

```bash
heroku config:get RELAY_SECRET -a mcp-ivan-connector   # for the bootstrap invite
node cli/dist/index.js invite --secret <RELAY_SECRET>
node cli/dist/index.js join https://mcp-ivan-connector-c134d42b797f.herokuapp.com <invite>
node cli/dist/index.js status
```

Expected: `daemon is online, setup complete`, then status shows the peer online.

- [ ] **Step 4: Re-join the work machine (user does this by hand)**

On this machine: `agent-link invite` and send the printed command to the work machine. There: clone or pull the repo, `npm install && npm run build`, run the printed `join` command.

- [ ] **Step 5: Manual e2e checklist**

1. `agent-link status` on both machines: both peers online.
2. From a Cursor chat: `list_peers`, then `ask_peer` to the other machine. Expected: an answer.
3. Parallelism: start two `ask_peer` calls with different `conversation_id` values at once (two chats). Expected: both answered, `~/.agent-link/workspace/` contains one directory per conversation.
4. `agent-link invite --ttl 1` and a `join` attempt with a garbage invite. Expected: join fails with `invalid or expired invite`.
5. Stop the work daemon (`agent-link stop`), ask again: `peer_offline` plus ticket, `agent-link start`, `check_reply` returns the answer.
6. Optional, ask the user: `npm publish` to make `npx agent-link` work without a clone.

---

## Self-Review Notes

- Spec coverage: stateless tokens and invites (Task 1), revocation via `REVOKED_PEERS` (Tasks 1, 5), `/join` with rate limit, `/invite`, `/status` with `self_online` (Task 3), presence-based `list_peers` (Task 4), `RELAY_SECRET` bootstrap plus `app.json` (Task 5), per-conversation workspaces with prune (Task 6), `max_concurrent` parallelism (Tasks 6-7), one npm package with bin (Task 8), one-command join incl. mcp.json merge and launchd (Tasks 9-10), CLI observability commands (Task 10), Dockerfile, README, script removal, skills update (Task 11), migration of the existing deployment (Task 12).
- Additions vs spec, both deliberate: `/status` gains `self_online` (the `join` command uses it to verify setup), and `invite --secret` mints the bootstrap invite locally because the first machine cannot call the authenticated `/invite` yet.
- Type consistency: `TokenService` (Tasks 1, 3, 5), `OutgoingTicket` (Tasks 2, 3, 9), `RelayStatus` (Tasks 3, 9, 10), `max_concurrent` (Tasks 6, 7, 9) checked across tasks.
- Known sequencing: the repo does not compile between Task 1 and Task 5 (auth consumers updated task by task); each task's test command targets only files that already compile. The full `npm test` first runs in Task 5.
