---
name: agent-link-relay
description: "Use when deploying or operating the agent-link relay on Heroku: initial deploy, registering or rotating peer tokens, checking config vars, tailing relay logs, choosing a dyno tier. Covers the make targets and the implications of the relay's in-memory storage."
---

# agent-link: relay operations

The relay is a small Fastify HTTP server (`relay/`) with an MCP streamable endpoint and a mailbox REST API. It stores nothing on disk. Restarts drop queued questions, waiters, and unresolved tickets.

## Deploy

Initial:

```bash
heroku create <app-name>
git push heroku HEAD:main       # or: make deploy APP=<app-name>
```

Subsequent:

```bash
make deploy APP=<app-name>
```

`APP` maps to `-a <app-name>`. If your local git already has a `heroku` remote pointing at the right app, you can also just `git push heroku main`.

## Peer tokens

Register a token for a peer:

```bash
make release-token PEER=WORK TOKEN=<token> APP=<app-name>
# equivalent: heroku config:set PEER_TOKEN_WORK=<token> -a <app-name>
```

Naming rules:
- Env var: `PEER_TOKEN_<NAME>` in caps.
- Peer name on the wire: the suffix lowercased (`WORK` → `work`).
- Tokens are stored plaintext as Heroku config vars, hashed at relay startup (SHA-256), compared timing-safe.

Rotation:

1. Generate a new token on the peer's machine (setup script does this, or `openssl rand -hex 32`).
2. Update `~/.agent-link/config.json` on that machine, `make restart`.
3. `make release-token PEER=<NAME> TOKEN=<new> APP=<app>` — this replaces the value.
4. Old requests with the old token immediately start returning 401. In-flight long-polls will fail on their next iteration.

Never commit tokens. `SETUP_NOTES.local.md` is gitignored.

## Inspect

```bash
make config APP=<app-name>        # list all config vars (includes tokens)
make logs-relay APP=<app-name>    # tail Heroku logs
curl -fsS https://<app-name>.herokuapp.com/health
```

## Dyno tier

Use `basic` or higher. `eco` dynos sleep after 30 minutes of no traffic, and a sleeping relay means every peer sees every other peer as offline. On wake-up all in-memory state is gone anyway.

## Storage caveats

All relay state is in memory:
- `inbox` — up to 100 queued questions per peer, 24h TTL each.
- `pending` — coordinates ask_peer ↔ POST /answer, retained 24h after settle for `check_reply`.
- `waiters` — parked long-polls.
- `lastSeen` — for online detection (60s window).

A relay restart (deploy, dyno cycle, config change on Heroku) wipes all of this. Askers whose tickets vanish get `unknown_ticket` from `check_reply`; queued but not-yet-picked-up questions are lost.

Deploy at low-traffic times when practical.

## Startup errors

If the relay refuses to boot with `no PEER_TOKEN_* variables configured`, set at least one `PEER_TOKEN_<NAME>=<value>` and restart:

```bash
heroku restart -a <app-name>
```
