---
name: doucopy-setup
description: "Use when joining a new machine to a doucopy deployment, when the ask_peer MCP tool doesn't appear in Cursor, or when a peer needs to be added to a relay. Covers doucopy join, doucopy settings, invite generation, launchd install (com.doucopy.responder), MCP merge into ~/.cursor/mcp.json, and post-install verification."
---

# doucopy: machine setup (v2)

## Preconditions

- Node.js 22+.
- At least one coding-agent CLI installed and logged in: `cursor-agent`, `claude`, or `codex`. Pick which one the responder should spawn during `join`.
- Relay URL known. If not, deploy the relay first (see `doucopy-relay`) or run `doucopy deploy --app <name>`.
- An invite code (`ali1.…`). Generate one either from an existing machine (`doucopy invite --ttl 24`), from the relay operator machine (`doucopy invite --app <name>`, requires Heroku CLI), or with a raw secret (`doucopy invite --secret "$RELAY_SECRET"`).

## Install

```bash
npx doucopy join <relay-url> <invite>
```

`doucopy join` asks for a peer name, detects local harnesses, and then:

- asks which harness should answer questions (if more than one is present),
- exchanges the invite for a peer token,
- discovers memory sources (`~/.cursor/*.md` files, directories containing `AGENTS.md` under common dev roots),
- offers a restrictions step (write folders, read blocklist, shell). Skip keeps the safe default: workspace-only writes, shell off,
- writes `~/.doucopy/config.json` (with `responder.harness` and `restrictions`) and `~/.doucopy/policy.md`,
- merges the relay entry into every detected asker config:
  - `~/.cursor/mcp.json`,
  - `~/.claude.json`,
  - `~/.codex/config.toml` (as `[mcp_servers.doucopy]` with `bearer_token`),
  each with a `.bak` backup,
- installs the launchd responder at `~/Library/LaunchAgents/com.doucopy.responder.plist`,
- polls the relay `/status` endpoint until the daemon reports online.

A machine that still has `~/.agent-link` from before the rename gets it moved to `~/.doucopy` automatically on the next `doucopy` command (see `migrateLegacyHome` in `doucopy-dev`).

## Reconfigure later

```bash
npx doucopy settings
```

Sectioned menu: Restrictions, Filtering (`policy.md` + redact literals), Model, Persona, Harness. Writes config atomically and can restart the daemon at the end. `npx doucopy join` without arguments can also re-walk askers / responder / skills / policy / restrictions while reusing the existing peer token.

## Verify

1. `doucopy status` shows `daemon process: running` and lists other peers (plus any paused peers).
2. Restart the asker (Cursor / Claude Code / Codex) so it picks up the new MCP entry.
3. In a fresh chat call `list_peers` — self is excluded, other peers appear as online when their daemons run.
4. `doucopy health --app <name>` (or `curl -f <relay_url>/health`) returns ok.

## Uninstall

```bash
doucopy stop
rm ~/Library/LaunchAgents/com.doucopy.responder.plist
```

`~/.doucopy/` stays. Delete it by hand for a clean slate.

## Common pitfalls

- Restart Cursor after `doucopy join`, MCP config is read at startup.
- After changing restrictions or model via `doucopy settings`, accept the restart prompt (or run `doucopy restart`).
- If `doucopy status` shows the daemon running but not connected, check `doucopy logs -f` — most often the token was invalidated by a `RELAY_SECRET` rotation or by `REVOKED_PEERS`.
- Heroku `eco` dynos sleep and make peers look offline. Use `basic` or higher.
- Peer names must match `[A-Za-z0-9._-]{1,64}`. The relay rejects anything else.
