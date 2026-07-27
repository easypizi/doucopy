---
name: agent-link-relay
description: "Use when deploying or operating the agent-link relay: initial deploy on Heroku or via Docker, rotating the shared RELAY_SECRET, revoking peers, generating bootstrap invites, checking config, tailing relay logs, choosing a dyno tier. Covers stateless HMAC auth and the relay's in-memory storage."
---

# agent-link: relay operations (v2)

The relay is a small Fastify server (`relay/`) with an MCP streamable endpoint and a mailbox REST API. It stores nothing on disk. Authentication is stateless: a single `RELAY_SECRET` signs every peer token and every invite via HMAC. Restarts drop queued questions, waiters, and unresolved tickets but keep every peer's existing token valid.

## Deploy

```bash
heroku create <app-name>
heroku config:set RELAY_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))") -a <app-name>
git push heroku HEAD:main
```

Or click Deploy to Heroku on the README (uses `app.json`). Or run in Docker with `docker build -t agent-link-relay . && docker run -e RELAY_SECRET=… -p 3000:3000 agent-link-relay`.

Subsequent deploys: `git push heroku HEAD:main`.

## Bootstrap invites

The first machine has no peer token yet, so it cannot call `POST /invite`. Instead, generate an invite locally from the `RELAY_SECRET`:

```bash
heroku config:get RELAY_SECRET -a <app-name>
# copy the value, then on any machine with agent-link installed:
npx agent-link invite --secret <RELAY_SECRET> --ttl 24
```

After the first peer is online it can create invites for the rest without touching the secret:

```bash
agent-link invite --ttl 24
```

## Revoke or rotate

- Full reset: rotate `RELAY_SECRET`. Every peer token becomes invalid.
- Revoke specific peers: `heroku config:set REVOKED_PEERS="ex-mbp,retired"`. Their tokens are rejected on the next relay restart (Heroku restarts automatically on config change).

## Inspect

```bash
heroku config -a <app-name>
heroku logs --tail -a <app-name>
curl -fsS https://<app-name>.herokuapp.com/health
```

Authenticated status probe (need any peer token):

```bash
curl -fsS -H "Authorization: Bearer <token>" https://<app-name>.herokuapp.com/status | jq
```

## Dyno tier

Use `basic` or higher. `eco` dynos sleep after 30 minutes of inactivity, so every peer sees every other peer as offline. On wake-up all in-memory state is gone.

## Storage caveats

All relay state is in memory:

- `inbox` — up to 100 queued questions per peer, 24h TTL each.
- `pending` — coordinates ask_peer ↔ POST /answer, kept 24h after settle for `check_reply`.
- `waiters` — parked long-polls.
- `lastSeen` — for online detection (60s window).

A relay restart wipes all of this. Existing peer tokens keep working because they are signed, not stored.

## Startup errors

If the relay refuses to boot with `RELAY_SECRET is required`, set the variable and restart:

```bash
heroku restart -a <app-name>
```

`RELAY_SECRET` must be at least 16 characters.
