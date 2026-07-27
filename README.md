# agent-link

Connect AI agents from different accounts of the same person (or a small trusted circle) so one can ask the other questions answered from its own memory, chat history and notes.

Two moving parts:

- A **relay** you host once. Stateless HMAC auth, no database.
- A **responder daemon** on every machine that should answer questions.

Every machine also exposes an MCP server (`ask_peer`, `list_peers`, `check_reply`) that plugs directly into Cursor, Claude Code and OpenAI Codex.

## Requirements

- Node.js 22.x on every machine (relay and responders).
- macOS for the responder daemon (uses `launchd`). Linux support is planned.
- A running Heroku or Docker host for the relay.
- A local coding-agent CLI on every responder machine: `cursor-agent`, `claude`, or `codex`.

## Deploy a relay (one time)

Easiest path: click the Heroku Deploy button on your fork, or run

```bash
heroku create my-agent-link-relay
git remote add heroku https://git.heroku.com/my-agent-link-relay.git
npx agent-link deploy --app my-agent-link-relay
```

The CLI generates a `RELAY_SECRET` (32 base64url bytes) if none is set, pushes, and health-checks. `RELAY_SECRET` signs every peer token and invite, so keep it safe.

Later ops:

```bash
npx agent-link health --app my-agent-link-relay
npx agent-link secret rotate --app my-agent-link-relay   # invalidates every peer, use for emergencies
npx agent-link revoke ex-mbp   --app my-agent-link-relay # kills a single peer
npx agent-link unrevoke ex-mbp --app my-agent-link-relay
```

Or via Make: `make deploy APP=my-agent-link-relay`, `make health`, `make rotate-secret`, `make revoke PEER=ex-mbp`.

Local relay for testing:

```bash
RELAY_SECRET=$(openssl rand -hex 32) npx agent-link relay
```

## Bootstrap the first machine

```bash
# On any machine that has the Heroku CLI logged in:
npx agent-link invite --app my-agent-link-relay --ttl 48
# or `make invite-bootstrap APP=my-agent-link-relay`

# copy the printed ali1.… invite and run on the target machine:
npx agent-link join https://my-agent-link-relay.herokuapp.com ali1.…
```

`agent-link join` walks you through:

1. asks for a peer name (letters, digits, `. _ -`)
2. detects local coding-agent CLIs (`cursor-agent`, `claude`, `codex`) and asks which one should run as the responder
3. exchanges the invite for a peer token
4. writes `~/.agent-link/config.json`, `~/.agent-link/policy.md`
5. merges `agent-link` into every detected asker config: `~/.cursor/mcp.json`, `~/.claude.json`, `~/.codex/config.toml` (each with a `.bak` backup)
6. installs a `launchd` responder and waits until it is online

Restart your coding agent to pick up the new MCP server.

## Add another machine

From the first machine:

```bash
npx agent-link invite --ttl 24
```

Copy the printed `npx agent-link join …` command and run it on the new machine.

## Daily use

```bash
agent-link status                    # daemon, peers, dialogs, paused peers
agent-link logs -f                   # live daemon logs
agent-link start | stop | restart
agent-link pause  work-mbp --for 2h  # stop answering questions from a peer
agent-link resume work-mbp
```

Inside Cursor / Claude Code / Codex:

```
list_peers                       # see online peers
ask_peer(peer="work-mbp", question="What did I decide about billing last week?")
check_reply(ticket_id="…")       # fetch a delayed answer
```

## Configuration

`~/.agent-link/config.json` fields worth knowing:

- `memory_sources.transcripts_glob`: JSONL agent transcripts fed to the responder.
- `memory_sources.agents_md_roots`: repositories scanned for `AGENTS.md`.
- `responder.harness`: one of `cursor-agent`, `claude`, `codex`. Defaults to `cursor-agent`.
- `responder.binary`: override the CLI binary path (defaults to the harness name on PATH).
- `responder.max_concurrent`: parallel harness runs (default 3).
- `responder.extra_args`: extra CLI flags appended to every harness invocation.
- `redact.literals`, `redact.patterns`: deterministic post-filter on every answer.

`~/.agent-link/paused.json` (managed by `agent-link pause/resume`) keeps the current pause map. Delete it to clear all pauses.

`~/.agent-link/policy.md` is the instruction file the responder prepends to every task. Edit it to tighten what the responder is allowed to reveal.

## Revoking access

Rotate `RELAY_SECRET` on the relay to disconnect every peer at once. To revoke a single peer without touching the rest, set

```bash
heroku config:set REVOKED_PEERS="ex-machine,retired-laptop"
```

Their tokens will be rejected the next time the relay restarts.

## Development

```bash
npm install
npm run build
npm test
```
