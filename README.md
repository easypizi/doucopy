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

---

## Step-by-step guide

Below, `<relay-url>` is your deployed relay (e.g. `https://mcp-ivan-connector-c134d42b797f.herokuapp.com`) and `<app>` is your Heroku app name (e.g. `mcp-ivan-connector`).

### Step 1. Deploy the relay (one time, on any machine with Heroku CLI)

```bash
heroku create <app>
git remote add heroku https://git.heroku.com/<app>.git
npx agent-link deploy --app <app>
```

`deploy` generates a `RELAY_SECRET` (32 base64url bytes) if there isn't one, pushes to Heroku, and health-checks. `RELAY_SECRET` signs every peer token and invite, so keep it safe.

Later ops:

```bash
npx agent-link health        --app <app>
npx agent-link secret rotate --app <app>   # invalidates every peer, use for emergencies
npx agent-link revoke   ex-mbp --app <app>
npx agent-link unrevoke ex-mbp --app <app>
```

Or via Make: `make deploy APP=<app>`, `make health APP=<app>`, `make rotate-secret APP=<app>`, `make revoke PEER=ex-mbp APP=<app>`.

For a local relay: `RELAY_SECRET=$(openssl rand -hex 32) npx agent-link relay`.

### Step 2. Bootstrap the first machine

Generate a bootstrap invite (needs Heroku CLI, reads `RELAY_SECRET` from the app):

```bash
npx agent-link invite --app <app> --ttl 48
# copy the printed invite string (looks like: ali1.eyJ...)
```

Join the relay:

```bash
npx agent-link join <relay-url> <invite>
```

`join` interactively asks two things:

1. **Peer name** for this machine (letters, digits, `. _ -`, e.g. `personal-mbp`).
2. **Which harness answers questions** (only asked if more than one of `cursor-agent`, `claude`, `codex` is on `PATH`).

Then it, without asking:

- exchanges the invite for a peer token,
- writes `~/.agent-link/config.json` and `~/.agent-link/policy.md`,
- merges an `agent-link` entry into every detected asker config (`~/.cursor/mcp.json`, `~/.claude.json`, `~/.codex/config.toml`), keeping a `.bak` backup of the previous file,
- installs a `launchd` responder daemon and waits until it reports online.

**Restart your coding agent (Cursor / Claude Code / Codex)** so it picks up the new MCP server.

### Step 3. Add another machine

From the first, already-joined machine:

```bash
npx agent-link invite --ttl 24
# copy the invite
```

On the new machine (needs `git`, Node 22+, and one of the harness CLIs):

```bash
git clone <your-fork-of-this-repo> ~/dev/agent-link
cd ~/dev/agent-link
npm install && npm run build
npx agent-link join <relay-url> <invite>
```

Repeat for as many machines as you like. Every machine ends up with the same `agent-link` MCP server available in its coding agent.

### Step 4. Daily use inside your coding agent

In a Cursor / Claude Code / Codex chat, call these tools:

```
list_peers
    → shows every known peer and whether it is currently online

ask_peer(peer="work-mbp", question="What did I decide about billing last week?")
    → save both ticket_id and conversation_id from the response

ask_peer(peer="work-mbp", question="And the trial?", conversation_id="<same>")
    → continues the same thread, responder remembers prior turn

check_reply(ticket_id="…")
    → fetch a delayed answer if ask_peer returned pending or peer_offline
```

`ask_peer` response statuses:

| status | what to do |
|---|---|
| `answered` | you have `answer`, done |
| `pending` | didn't finish inside `timeout_seconds`, call `check_reply` later |
| `peer_offline` | peer hasn't polled the relay for >60s; question is queued for 24h, use `check_reply` |
| `error` | show the `error` field to the user, don't retry silently |

### Step 5. Daily use from the terminal

```bash
agent-link status                     # daemon, known peers, active dialogs, paused peers
agent-link logs -f                    # live responder log
agent-link start | stop | restart     # control the launchd daemon
agent-link pause  work-mbp --for 2h   # 90s / 15m / 2h / 1d, or --until 2026-07-28T09:00:00Z, or no flag for indefinite
agent-link resume work-mbp
```

Pauses live in `~/.agent-link/paused.json` and are local to the machine. While a peer is paused, its `ask_peer` calls to you come back as `error: peer paused until ...`.

### Step 6. Counter-questions (v2.1)

If a question is ambiguous, the responder may fire back one clarifying question via `ask_peer(peer=<asker>, conversation_id=<same>, hops: 1)`. Your local daemon answers it from your own memory sources, the responder then produces the final answer.

Limits are enforced by the relay:

- `hops` is capped at 1, no ping-pong,
- at most 4 open tickets per conversation.

If you expect a counter-question, ask with a generous `timeout_seconds: 240`.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `agent-link status` shows `HTTP 401: unauthorized` | Token is stale or `RELAY_SECRET` was rotated. `agent-link stop`, `rm ~/.agent-link/config.json`, generate a fresh invite (`invite --app <app>`), then `join` again. |
| `list_peers` doesn't show any peers in chat | 1) daemons running on peers? (`agent-link status` on each) 2) did you restart Cursor / Claude Code / Codex after `join`? 3) `agent-link logs -f` and look for errors. |
| Peer stuck as offline | Peer hasn't polled the relay for >60s. Question is still queued for 24h; use `check_reply(ticket_id)` later. |
| `agent-link deploy` fails on `heroku CLI not found` | Install and log in: `brew install heroku` and `heroku login`, then set the remote: `heroku git:remote -a <app>`. |
| Want to kick one machine without breaking others | `agent-link revoke <peer> --app <app>`. Its token stops working after the relay restarts. |
| Docker relay instead of Heroku | Build with the shipped `Dockerfile`, run with `RELAY_SECRET=... PORT=3000 -p 3000:3000` and point `join` at that URL. |

## Configuration reference

`~/.agent-link/config.json` fields worth knowing:

- `memory_sources.transcripts_glob`: JSONL agent transcripts fed to the responder.
- `memory_sources.agents_md_roots`: repositories scanned for `AGENTS.md`.
- `responder.harness`: one of `cursor-agent`, `claude`, `codex`. Defaults to `cursor-agent`.
- `responder.binary`: override the CLI binary path (defaults to the harness name on PATH).
- `responder.max_concurrent`: parallel harness runs (default 3).
- `responder.extra_args`: extra CLI flags appended to every harness invocation.
- `redact.literals`, `redact.patterns`: deterministic post-filter on every outgoing answer.

`~/.agent-link/policy.md` is the instruction file the responder prepends to every task. Edit it to tighten what the responder is allowed to reveal.

`~/.agent-link/paused.json` (managed by `agent-link pause/resume`) keeps the current pause map. Delete it to clear all pauses.

## Development

```bash
npm install
npm run build
npm test
```
