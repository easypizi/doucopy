---
name: agent-link-setup
description: "Use when joining a new machine to an agent-link deployment, when the ask_peer MCP tool doesn't appear in Cursor, or when a peer's token needs registering on the relay. Covers scripts/setup-machine.sh, LaunchAgent install (com.agent-link.responder), MCP merge into ~/.cursor/mcp.json, and post-install verification."
---

# agent-link: machine setup

## Preconditions

- Node.js 22+.
- `cursor-agent` CLI installed and logged in (`cursor-agent status`).
- Relay URL and Heroku app name known. If not, set up the relay first (see `agent-link-relay`).

## Install

```bash
cd <repo>
./scripts/setup-machine.sh
# or: make setup
```

The script is interactive. It:
- asks for the peer name (e.g. `work`, `personal`) and relay URL,
- generates a token,
- discovers memory sources (globs `~/.cursor/*.md` and directories containing `AGENTS.md`),
- runs the privacy wizard, writing `~/.agent-link/config.json` and `~/.agent-link/policy.md`,
- merges the relay entry into `~/.cursor/mcp.json`,
- installs the LaunchAgent at `~/Library/LaunchAgents/com.agent-link.responder.plist`,
- saves a personalised summary (including the token and the exact `heroku config:set` command) to `SETUP_NOTES.local.md`. That file is gitignored — keep it private.

## Register the token on the relay

From the summary in `SETUP_NOTES.local.md`, or:

```bash
make release-token PEER=<NAME_IN_CAPS> TOKEN=<token> APP=<heroku-app>
```

This maps to `heroku config:set PEER_TOKEN_<NAME>=<token>`. The peer name on the relay is the suffix lowercased.

## Optional: expose the global asker/responder skills

```bash
make skills-install
```

Symlinks `agent-link-ask` and `agent-link-answer` from the repo into `~/.cursor/skills/` so they fire from any workspace, including the headless responder run.

## Verify

1. `make status` — LaunchAgent loaded, non-zero PID, no recent error log entries.
2. Restart Cursor so it picks up the new MCP entry.
3. In a new Cursor chat: call `list_peers`. Your own peer should be absent (self-excluded); other peers should appear online if their daemons are also running.
4. Optionally: `curl -f <relay_url>/health` should return `{"ok":true}`.

## Uninstall

```bash
make uninstall   # unloads and deletes the LaunchAgent plist; config stays
make skills-uninstall
```

Config in `~/.agent-link/` is not removed automatically. Delete it by hand if you want a clean slate.

## Common pitfalls

- Restart Cursor after `setup-machine.sh` — MCP config is read at startup.
- If the peer name on the relay and in `config.json.self_peer` disagree, you get 403 on `/inbox` and the daemon appears offline to everyone.
- If the Heroku app is on the `eco` tier, dynos sleep and the peer looks offline. Use `basic` or higher.
