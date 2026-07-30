# doucopy

**Two AI agents. Different accounts. Same person or a small trusted circle. One can ask the other about anything already in the other's chat history, notes and code.**

Got an invite? One command:

```bash
npx doucopy join <relay-url> <invite>
```

That's it. The wizard configures Cursor, Claude Code and Codex, installs a responder daemon, and your agents can talk.

## Why does this exist?

Every AI coding agent keeps its memory in a silo. Your Cursor at work doesn't know what your Claude Code at home decided yesterday. Your personal account can't see the conversations on your other account. And nobody's agent can ask a colleague's agent a question.

doucopy connects them. Each machine answers questions **from its own local memory** (agent transcripts, `AGENTS.md`, notes) using its own agent CLI. Raw data never leaves the machine, only the written answer does, filtered through a local policy you control.

**Use cases:**

- Ask your work machine from home: "What did I decide about billing last week?"
- Bridge vendor silos: an agent in Cursor asks an agent running on Codex, or the other way around
- A small trusted circle: your agent asks a friend's agent about their project conventions, their policy controls what gets revealed

## How it works

```
your coding agent (Cursor / Claude Code / Codex)
  ├── calls the doucopy MCP server (ask_peer / list_peers / check_reply)
  ├── relay forwards the question (stateless HMAC auth, no database)
  ├── peer's responder daemon picks it up via long-poll
  ├── daemon runs the peer's own agent CLI over its local memory
  ├── policy.md filter strips anything marked "never reveal"
  └── the answer travels back through the relay to your chat
```

Two moving parts:

- A **relay** somebody in the circle hosts once (Heroku or Docker).
- A **responder daemon** on every machine that should answer questions.

## Install

You need Node 22 and an invite code (looks like `ali1.eyJ...`). Then:

```bash
npx doucopy join <relay-url> <invite>
```

The wizard asks:

1. **Peer name** for this machine (default is your hostname, editable).
2. **Where to authorize** as an asker: Cursor / Claude Code / Codex (multi-select, pre-checked based on what's installed).
3. **Which harness answers questions** for other peers, or pick `asker-only` if you never want to be a responder.
4. **Install skills globally** into `~/.cursor/skills` and `~/.claude/skills`.
5. **Never reveal**: comma-separated words the responder must strip from every outgoing answer.

Then, without asking:

- exchanges the invite for a peer token,
- writes `~/.doucopy/config.json` and `~/.doucopy/policy.md`,
- merges a `doucopy` entry into the MCP config of every chosen client,
- (unless asker-only) installs and starts the `launchd` responder daemon and waits until it reports online.

**Restart your coding agent (Cursor / Claude Code / Codex)** so it picks up the new MCP server.

**Resuming the wizard.** Run `npx doucopy join` without arguments any time:

- If this machine is already connected, the wizard offers to reuse the existing peer and token and just walks through askers / responder / skills / policy again.
- If a previous run was interrupted after you typed the relay URL and invite, they're prefilled on the next attempt (draft stored in `~/.doucopy/join-draft.json`, TTL 48h, deleted on success).

Non-interactive form for scripts:

```bash
npx doucopy join <relay-url> <invite> \
  --name work-mbp --harness claude --askers cursor,claude \
  --never-reveal "AcmeCorp, project-yellowstone" --yes
```

## Requirements

- Node.js 22.x on every machine (relay and peers).
- macOS for the responder daemon (uses `launchd`). Asker-only mode works on Linux too.
- A local coding-agent CLI on every responder machine: `cursor-agent`, `claude` or `codex`.
- Somebody in the circle has a Heroku (or Docker) host for the relay.

## Hosting the relay yourself

You need a Heroku (or Docker) deployment, so this is a git-clone workflow.

```bash
git clone https://github.com/easypizi/doucopy ~/dev/doucopy
cd ~/dev/doucopy
make install && make build
heroku login
make setup
```

`make setup` is the owner wizard: it checks Heroku CLI + login, asks for an app name, runs `make deploy`, mints a 24h bootstrap invite, then hands off to the same `join` wizard so this machine ends up configured as the first peer.

Later ops (all default to `APP=mcp-ivan-connector`, override with `APP=<name>`):

```bash
make deploy            # push and health-check
make health            # /health
make invite-bootstrap  # mint another invite using the Heroku RELAY_SECRET
make rotate-secret     # emergencies only, breaks every peer
make revoke   PEER=ex-mbp
make unrevoke PEER=ex-mbp
make publish           # npm publish (owners only, needs npm login)
```

Local relay for testing: `make relay RELAY_SECRET=$(openssl rand -hex 32)`.

## Daily use

### From your coding agent (MCP)

```
list_peers
    → every known peer + whether it's online right now

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
| `error` | show the `error` field, don't retry silently |

### From the terminal

```bash
npx doucopy chat                      # interactive REPL: colored peers table, /use <peer>, then type
npx doucopy status                    # daemon, peers, dialogs, paused peers, coloured status
npx doucopy policy                    # opens ~/.doucopy/policy.md in $EDITOR
npx doucopy logs -f                   # tail the responder log
npx doucopy pause work-mbp --for 2h   # refuse questions from a peer
npx doucopy resume work-mbp
npx doucopy start | stop | restart    # control the launchd daemon
npx doucopy invite --ttl 48           # mint an invite from this machine
```

Every command has a `make` alias for a repo checkout: `make chat`, `make status`, `make policy`, `make invite`, `make pause PEER=work-mbp FOR=2h`, and so on. Run `make` for the full list.

### The single filter: policy.md

`~/.doucopy/policy.md` is the one place to control the responder:

- The top of the file is the instruction prepended to every task the responder runs.
- The `## Never reveal` section is a deterministic post-filter that runs in daemon code (outside the LLM), stripping matches from every outgoing `answer` and `error`. Bullet lines are case-insensitive literals; slash-wrapped bullets are regex (`- /internal-project-\d+/`).

Edits take effect on the next question, no restart. Open the file with `npx doucopy policy`.

### Counter-questions

If a question is ambiguous, the responder may fire back one clarifying question in the same conversation. Your local daemon answers it from your own memory sources, then the responder produces the final answer. Relay-enforced limits: `hops` capped at 1, at most 4 open tickets per conversation. Expect this? Pass a generous `timeout_seconds: 240`.

## How it differs from a SaaS

doucopy is built for a small circle of trusted machines, tens rather than thousands. That constraint buys radical simplicity:

| A typical SaaS | doucopy |
|---|---|
| Central database with your conversations | No database. Answers are computed on the owner's machine, raw data never uploaded |
| User accounts, sessions, OAuth | Stateless HMAC tokens minted from one relay secret |
| Fleet of servers | One relay instance. Ten peers is ten idle long-poll sockets |
| Privacy policy page | `policy.md` on each machine, enforced locally in code |

## Caveats

- **Responder daemon is macOS-only** (`launchd`). Linux machines can join as askers.
- **Relay restart drops in-flight questions.** All relay state (open tickets, presence) lives in memory. Queued questions survive for 24h only while the relay is up.
- **No horizontal scaling.** One relay instance by design. Fine for a personal circle, not for a SaaS.
- **Old npm versions stay MIT.** Versions published before the license change remain under their original license.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `status` shows `HTTP 401: unauthorized` | Token is stale or `RELAY_SECRET` was rotated. Stop the daemon, delete `~/.doucopy/config.json`, mint a fresh invite (`make invite-bootstrap APP=<app>`), rejoin. |
| `list_peers` empty in the chat | Daemons running on peers? (`npx doucopy status` on each). Did you restart Cursor / Claude Code / Codex after `join`? Check `npx doucopy logs -f`. |
| Peer stuck as offline | Peer hasn't polled the relay for >60s. Question is still queued for 24h, use `check_reply(ticket_id)`. |
| `make deploy` fails on `heroku CLI not found` | `brew install heroku && heroku login`, then `heroku git:remote -a <app>`. |
| Docker relay instead of Heroku | Build with the shipped `Dockerfile`, run with `RELAY_SECRET=... PORT=3000 -p 3000:3000` and point `join` at that URL. |

## Development

```bash
make install
make build
make test
make typecheck
```

To validate the npm tarball before publishing: `npm pack` then `npm i -g ./doucopy-*.tgz`. `npm run sync-skills` mirrors `.cursor/skills/doucopy-{ask,answer,troubleshoot}` into the `skills/` directory that ships in the tarball; it runs automatically on `prepack`.

The package ships two bin names: `doucopy` and the legacy `agent-link` alias, for anyone who installed it under the old name.

## License

[FSL-1.1-MIT](LICENSE) (Functional Source License). Free to use, copy, modify and redistribute for any purpose except building a product or service that competes with doucopy. Each version automatically becomes MIT two years after its release.
