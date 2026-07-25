---
name: agent-link-dev
description: "Use when modifying agent-link itself: changing the relay or daemon code, adding an MCP tool, updating the prompt or redaction logic, writing or debugging tests. Documents the repo layout, invariants that must be preserved across changes, and the test map."
---

# agent-link: contributor guide

## Repo layout

```
relay/                fastify HTTP + MCP streamable
  src/
    index.ts          server bootstrap, /mcp routing, /inbox, /answer, /health
    mcp.ts            MCP tool definitions (list_peers, ask_peer, check_reply)
    mailbox.ts        in-memory inbox, pending, waiters, lastSeen
    auth.ts           PEER_TOKEN_* discovery, bearer parsing, timing-safe compare
    rest.ts           /inbox and /answer handlers
    types.ts          Question shape
  test/               vitest, one file per module

daemon/               responder daemon
  src/
    index.ts          bootstrap, signal handling, policy load
    poller.ts         long-poll /inbox, backoff, /answer POST retry
    handler.ts        per-question orchestration
    runner.ts         spawn cursor-agent (create-chat then --resume)
    prompt.ts         buildFirstTask, buildFollowupTask, policy preamble
    conversations.ts  conversation_id → chatId map, 7-day prune
    redact.ts         built-in patterns + user rules
    config.ts         config.json validation
  test/               vitest
  launchd/            com.agent-link.responder.plist

scripts/              setup-machine.sh, daemon.sh, install-daemon.sh, skills.sh
docs/superpowers/     specs, plans
Makefile              wraps npm scripts and heroku commands
```

## Invariants — do not break these

1. **`check_reply` is single-read.** After the first `answered` or `error` return, the entry is deleted (`mailbox.ts:156-160`). Any change here must preserve that contract; askers already depend on it.
2. **Online window is 60 seconds** since the last inbox long-poll (`mailbox.ts:7,151-154`). `list_peers` and `peer_offline` fast-path both check it. Don't move to a heartbeat scheme without updating both.
3. **Inbox cap is 100 questions per peer, 24h TTL** (`mailbox.ts:4-6,68,171-176`). Overflow returns `"overflow"`, expiry returns `"expired"`. These strings are user-facing via `error` status.
4. **Redaction runs after the LLM finishes, in code** (`daemon/src/handler.ts:33-45`, `redact.ts`). Never move any part of it into the prompt.
5. **MCP tools return one text block** containing JSON (`relay/src/mcp.ts:10-12`). Never break that shape; askers parse it.
6. **`ask_peer` timeouts: default 120s, max 240s, keepalive every 15s** (`relay/src/mcp.ts:6-8`). If you extend the max, update `agent-link-ask` and the responder timeout too.
7. **`conversation_id` is opaque to the relay** — only the daemon maps it to a `cursor-agent` chat id. Keep it string-uuidv7-friendly.

## Test map

`vitest run` via `npm test` or `make test`. 13 files:

| File | What it covers |
|---|---|
| `relay/test/auth.test.ts` | PEER_TOKEN discovery, bearer parsing |
| `relay/test/mailbox.test.ts` | enqueue, TTL, overflow, online window, waitForAnswer |
| `relay/test/mcp.test.ts` | list_peers, ask_peer, check_reply, keepalive |
| `relay/test/rest.test.ts` | /health, /inbox, /answer auth + errors |
| `relay/test/index.test.ts` | /mcp 405 for GET/DELETE |
| `daemon/test/config.test.ts` | loadConfig validation, redact rule compile |
| `daemon/test/conversations.test.ts` | store, 7-day prune, corruption recovery |
| `daemon/test/handler.test.ts` | E2E within daemon, redaction, resume |
| `daemon/test/integration.test.ts` | real relay + daemon + fake cursor-agent |
| `daemon/test/poller.test.ts` | poll loop, backoff, answer delivery |
| `daemon/test/prompt.test.ts` | first/followup task content |
| `daemon/test/redact.test.ts` | literals, patterns, built-ins |
| `daemon/test/runner.test.ts` | createChat, runTask, timeout |

Integration uses `daemon/test/fixtures/fake-cursor-agent.sh` — a shell stub. Keep it fast and deterministic.

## Common commands

```bash
make install typecheck test       # full loop
make test-watch                   # vitest watch
make build                        # tsc emit into relay/dist and daemon/dist
```

## Adding a new MCP tool

1. Define it in `relay/src/mcp.ts` with a Zod input schema and a return-text-block handler.
2. Add integration coverage in `relay/test/mcp.test.ts`.
3. If askers should know about it, extend `agent-link-ask` in `.cursor/skills/agent-link-ask/SKILL.md`.

## Prompt changes

- Any new rule that applies unconditionally goes in `daemon/src/prompt.ts` (both `buildFirstTask` and `buildFollowupTask` if it's a persistent rule).
- Any advisory rule that fits a skill should stay in the skill instead, to keep the prompt short and cache-friendly.
- Update `daemon/test/prompt.test.ts` for anything asserted on.
