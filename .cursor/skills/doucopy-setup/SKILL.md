---
name: doucopy-setup
description: "Use when joining a new machine to a doucopy deployment, when the ask_peer MCP tool doesn't appear in Cursor, or when a peer needs to be added to a relay. Covers doucopy join, doucopy settings, invite generation, responder install (launchd on macOS / Task Scheduler on Windows), MCP merge into ~/.cursor/mcp.json, and post-install verification."
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
- discovers memory sources (`~/.cursor/*.md`, `~/.claude/CLAUDE.md` if present, directories containing `AGENTS.md` under common dev roots),
- detects transcript globs from installed harness homes (`~/.cursor/projects`, `~/.claude/projects`, `~/.codex/sessions`). `memory_sources.transcripts_glob` may be a string or an array,
- offers a restrictions step (write folders, read blocklist, shell). Skip keeps the safe default: workspace-only writes, shell off,
- writes `~/.doucopy/config.json` (with `responder.harness` and `restrictions`) and `~/.doucopy/policy.md`. Default `responder.model` is set only for `cursor-agent` (`composer-2.5`). Claude and Codex leave the model unset so the harness default applies,
- merges the relay entry into every detected asker config:
  - `~/.cursor/mcp.json`,
  - `~/.claude.json`,
  - `~/.codex/config.toml` (as `[mcp_servers.doucopy]` with `url` + `http_headers` Authorization. Codex >= 0.146 rejects `bearer_token` on streamable HTTP),
  each with a `.bak` backup,
- installs the responder supervisor: launchd plist on macOS (`~/Library/LaunchAgents/com.doucopy.responder.plist`), or Task Scheduler task `doucopy-responder` on Windows (`~/.doucopy/responder.cmd` + `responder.task.xml`),
- polls the relay `/status` endpoint until the daemon reports online.

A machine that still has `~/.agent-link` from before the rename gets it moved to `~/.doucopy` automatically on the next `doucopy` command (see `migrateLegacyHome` in `doucopy-dev`).

## Reconfigure later

```bash
npx doucopy settings
```

Sectioned menu: Restrictions, Filtering (`policy.md` + redact literals), Model, Persona, Harness. Model presets are harness-aware (Cursor: composer-*, Claude: sonnet/opus/haiku/fable, Codex: gpt-5.6-*). Changing harness clears a model that is invalid for the new harness and re-prompts. Writes config atomically and can restart the daemon at the end. Prefer `make settings` from a repo checkout until the next npm publish. `npx doucopy join` without arguments can also re-walk askers / responder / skills / policy / restrictions while reusing the existing peer token.

## Verify

1. `doucopy status` shows `daemon process: running` and lists other peers (plus any paused peers).
2. Restart the asker (Cursor / Claude Code / Codex) so it picks up the new MCP entry.
3. In a fresh chat call `list_peers` — self is excluded, other peers appear as online when their daemons run.
4. `doucopy health --app <name>` (or `curl -f <relay_url>/health`) returns ok.

## Uninstall

```bash
doucopy stop
# macOS:
rm ~/Library/LaunchAgents/com.doucopy.responder.plist
# Windows also removes the Task Scheduler task via doucopy stop
```

`~/.doucopy/` stays. Delete it by hand for a clean slate.

## Common pitfalls

- Restart Cursor after `doucopy join`, MCP config is read at startup.
- After changing restrictions or model via `doucopy settings`, accept the restart prompt (or run `doucopy restart`).
- If `doucopy status` shows the daemon running but not connected, check `doucopy logs -f` — most often the token was invalidated by a `RELAY_SECRET` rotation or by `REVOKED_PEERS`.
- Heroku `eco` dynos sleep and make peers look offline. Use `basic` or higher.
- Peer names must match `[A-Za-z0-9._-]{1,64}`. The relay rejects anything else.
