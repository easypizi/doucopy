---
name: agent-link-setup
description: "Use when joining a new machine to an agent-link deployment, when the ask_peer MCP tool doesn't appear in Cursor, or when a peer needs to be added to a relay. Covers agent-link join, invite generation, launchd install (com.agent-link.responder), MCP merge into ~/.cursor/mcp.json, and post-install verification."
---

# agent-link: machine setup (v2)

## Preconditions

- Node.js 22+.
- At least one coding-agent CLI installed and logged in: `cursor-agent`, `claude`, or `codex`. Pick which one the responder should spawn during `join`.
- Relay URL known. If not, deploy the relay first (see `agent-link-relay`) or run `agent-link deploy --app <name>`.
- An invite code (`ali1.…`). Generate one either from an existing machine (`agent-link invite --ttl 24`), from the relay operator machine (`agent-link invite --app <name>`, requires Heroku CLI), or with a raw secret (`agent-link invite --secret "$RELAY_SECRET"`).

## Install

```bash
npx agent-link join <relay-url> <invite>
```

`agent-link join` asks for a peer name, detects local harnesses, and then:

- asks which harness should answer questions (if more than one is present),
- exchanges the invite for a peer token,
- discovers memory sources (`~/.cursor/*.md` files, directories containing `AGENTS.md` under common dev roots),
- writes `~/.agent-link/config.json` (with `responder.harness` set) and `~/.agent-link/policy.md`,
- merges the relay entry into every detected asker config:
  - `~/.cursor/mcp.json`,
  - `~/.claude.json`,
  - `~/.codex/config.toml` (as `[mcp_servers.agent-link]` with `bearer_token`),
  each with a `.bak` backup,
- installs the launchd responder at `~/Library/LaunchAgents/com.agent-link.responder.plist`,
- polls the relay `/status` endpoint until the daemon reports online.

## Verify

1. `agent-link status` shows `daemon process: running` and lists other peers (plus any paused peers).
2. Restart the asker (Cursor / Claude Code / Codex) so it picks up the new MCP entry.
3. In a fresh chat call `list_peers` — self is excluded, other peers appear as online when their daemons run.
4. `agent-link health --app <name>` (or `curl -f <relay_url>/health`) returns ok.

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
