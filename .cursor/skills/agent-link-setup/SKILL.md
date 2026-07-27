---
name: agent-link-setup
description: "Use when joining a new machine to an agent-link deployment, when the ask_peer MCP tool doesn't appear in Cursor, or when a peer needs to be added to a relay. Covers agent-link join, invite generation, launchd install (com.agent-link.responder), MCP merge into ~/.cursor/mcp.json, and post-install verification."
---

# agent-link: machine setup (v2)

## Preconditions

- Node.js 22+.
- `cursor-agent` CLI installed and logged in (`cursor-agent status`).
- Relay URL known. If not, deploy the relay first (see `agent-link-relay`).
- An invite code (`ali1.…`). Generate one either from an existing machine (`agent-link invite --ttl 24`) or from the relay operator with `agent-link invite --secret "$RELAY_SECRET"` for the first machine.

## Install

```bash
npx agent-link join <relay-url> <invite>
```

`agent-link join` asks for a peer name and then:

- exchanges the invite for a peer token,
- discovers memory sources (`~/.cursor/*.md` files, directories containing `AGENTS.md` under common dev roots),
- writes `~/.agent-link/config.json` and `~/.agent-link/policy.md`,
- merges the relay entry into `~/.cursor/mcp.json` (backup at `mcp.json.bak`),
- installs the launchd responder at `~/Library/LaunchAgents/com.agent-link.responder.plist`,
- polls the relay `/status` endpoint until the daemon reports online.

## Verify

1. `agent-link status` shows `daemon connected: yes` and lists other peers.
2. Restart Cursor so it picks up the new MCP entry.
3. In a fresh Cursor chat call `list_peers` — self is excluded, other peers appear as online when their daemons run.
4. `curl -f <relay_url>/health` returns `{"ok":true}`.

## Uninstall

```bash
agent-link stop
rm ~/Library/LaunchAgents/com.agent-link.responder.plist
```

`~/.agent-link/` stays. Delete it by hand for a clean slate.

## Common pitfalls

- Restart Cursor after `agent-link join`, MCP config is read at startup.
- If `agent-link status` shows the daemon running but not connected, check `agent-link logs -f` — most often the token was invalidated by a `RELAY_SECRET` rotation or by `REVOKED_PEERS`.
- Heroku `eco` dynos sleep and make peers look offline. Use `basic` or higher.
- Peer names must match `[A-Za-z0-9._-]{1,64}`. The relay rejects anything else.
