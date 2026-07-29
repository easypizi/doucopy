---
name: agent-link-troubleshoot
description: "Use when agent-link is misbehaving: a peer shows offline, ask_peer returns pending forever, check_reply returns unknown_ticket, MCP returns 401/403, or answers come back empty. Ranked diagnosis with concrete commands and log locations."
---

# agent-link: troubleshooting

## First, gather cheap signals

```bash
agent-link status                       # daemon state, peers, dialogs
agent-link logs -f                      # follow both stdout and stderr
curl -fsS "$RELAY_URL/health"           # {"ok":true} means the relay is up
```

`RELAY_URL` is in `~/.agent-link/config.json → relay_url`.

## Symptoms → causes

### Peer looks offline (list_peers shows online: false)

A peer is online iff the relay saw its daemon long-poll `/inbox` in the last **60 seconds**.

1. Daemon not running on that machine → `agent-link status`, `agent-link start`.
2. Daemon running but crashing on start → `~/.agent-link/responder.err.log` for stack traces. Common: invalid `config.json` (thrown by `daemon/src/config.ts` with a `config: ...` message).
3. Auth error against the relay → the poller enters a 300s backoff. Look for `401` in the err log. Fix: `RELAY_SECRET` on the relay was rotated, or the peer name is in `REVOKED_PEERS`. Re-join with a fresh invite.
4. Relay down or sleeping → `curl /health`. If it 502s or times out, check Heroku. If the app is on `eco`, upgrade to `basic`.
5. Corporate proxy / DNS blocking outbound HTTPS → the daemon retries with exponential backoff (1s → 60s cap). Check the err log for network errors.

### ask_peer returns `pending` and never resolves

`pending` means the ask timed out at the relay side, but the question is still in the daemon's hands.

1. Save the `ticket_id`. Poll `check_reply(ticket_id)` later — the ticket lives **24 hours**. Single-read, so save the answer.
2. If `check_reply` also stays `pending`, the responder is running `cursor-agent` and hasn't finished. `cursor-agent` gets `response_timeout_seconds` (see `config.json`); if it hits that, the daemon posts an `error` with `"cursor-agent failed: ..."`.
3. If the daemon crashed mid-run, the ticket is orphaned — you'll get `unknown_ticket` after the relay's 24h TTL, or immediately if the relay was restarted.

### check_reply returns `unknown_ticket`

Any of:
- Already consumed (single-read).
- 24h retention expired.
- Relay restarted (in-memory storage, all tickets dropped).
- Wrong ticket id.

There is no recovery; ask again.

### 401 / 403 from the MCP tool

- `401 unauthorized` — asker's bearer token in `~/.cursor/mcp.json` no longer verifies against `RELAY_SECRET` (rotation) or the peer is in `REVOKED_PEERS`. Fix by re-joining and updating `mcp.json`.
- `403 wrong peer` — asker's token belongs to peer X but the request is for peer Y's inbox (only happens on the daemon side, not on `ask_peer`).

Restart Cursor after edits to `mcp.json`.

### Empty answer (`{ status: "answered", answer: "" }`)

Two paths:
- Responder actually produced no text. Look for `responder produced empty output` in `responder.err.log`.
- Redaction wiped the whole answer. `responder.log` will contain `redacted N match(es) from an outgoing answer`. Loosen the pattern in `redact.patterns` or drop an over-broad `literals` entry.

### Peer online, but every ask returns `error`

Read the `error` string. Common values:
- `"cursor-agent failed: ..."` — subprocess exit, see daemon logs.
- `"responder produced empty output"` — CLI succeeded with no output.
- `"overflow"` — inbox has 100 questions queued for this peer; the daemon isn't keeping up. Restart it.
- `"expired"` — question sat 24h in the inbox before being picked up.

## Restart cycle

Most transient issues clear with:

```bash
agent-link restart
```

If the daemon won't stay up, run it in the foreground to see the failure interactively:

```bash
agent-link stop
node "$(npm root -g)/agent-link/daemon/dist/index.js"
```

## When to escalate to code changes

If a real bug: use `agent-link-dev`. Regression tests live under `daemon/test/` and `relay/test/`.
