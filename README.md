# agent-link

Connect AI agents from different accounts of the same person (or a small trusted circle) so one can ask the other questions answered from its own memory, chat history and notes.

Two moving parts:

- A **relay** you host once. Stateless HMAC auth, no database.
- A **responder daemon** on every machine that should answer questions.

Every machine also exposes an MCP server (`ask_peer`, `list_peers`, `check_reply`) that plugs directly into Cursor.

## Requirements

- Node.js 22.x on every machine (relay and responders).
- macOS for the responder daemon (uses `launchd`). Linux support is planned.
- A running Heroku or Docker host for the relay.

## Deploy a relay (one time)

Easiest path: click the button on your fork or run

```bash
heroku create my-agent-link-relay
heroku config:set RELAY_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
git push heroku main
```

`RELAY_SECRET` is the only required env variable. It signs every peer token and invite, so keep it safe.

Local relay for testing:

```bash
RELAY_SECRET=$(openssl rand -hex 32) npx agent-link relay
```

## Bootstrap the first machine

```bash
# On any machine with SSH access to the relay host:
heroku config:get RELAY_SECRET -a my-agent-link-relay > /tmp/secret
# Or paste it locally, then:
npx agent-link invite --secret "$(cat /tmp/secret)"
# copy the printed ali1.… invite

npx agent-link join https://my-agent-link-relay.herokuapp.com ali1.…
```

`agent-link join` walks you through:

1. asks for a peer name (letters, digits, `. _ -`)
2. exchanges the invite for a peer token
3. writes `~/.agent-link/config.json`, `~/.agent-link/policy.md`
4. merges `agent-link` into `~/.cursor/mcp.json` (with `.bak` backup)
5. installs a `launchd` responder and waits until it is online

Restart Cursor to pick up the new MCP server.

## Add another machine

From the first machine:

```bash
npx agent-link invite --ttl 24
```

Copy the printed `npx agent-link join …` command and run it on the new machine.

## Daily use

```bash
agent-link status                # daemon, peers, dialogs
agent-link logs -f               # live daemon logs
agent-link start | stop | restart
```

Inside Cursor:

```
list_peers                       # see online peers
ask_peer(peer="work-mbp", question="What did I decide about billing last week?")
check_reply(ticket_id="…")       # fetch a delayed answer
```

## Configuration

`~/.agent-link/config.json` fields worth knowing:

- `memory_sources.transcripts_glob`: JSONL agent transcripts fed to the responder.
- `memory_sources.agents_md_roots`: repositories scanned for `AGENTS.md`.
- `responder.max_concurrent`: parallel `cursor-agent` runs (default 3).
- `redact.literals`, `redact.patterns`: deterministic post-filter on every answer.

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
