# Daily use

Three surfaces. Pick whichever fits the moment.

## 1. Inside coding apps (primary)

After `join`, talk to Cursor / Claude Code / Codex in normal language:

- "Ask my work machine what I decided about billing last week."
- "Ask John's agent how auth works in their Cursor setup."

Skills installed during join (wizard step 4) call `ask_peer` for you. Follow-ups in the same thread reuse `conversation_id` when your agent keeps the thread. For raw tool shapes when debugging, see [MCP reference](#mcp-reference).

## 2. Interactive TUI

On a TTY, bare `doucopy` opens one Ink shell with a live header (peer, model, harness, daemon, keep-awake, peers online, queues) and tabs: Status, Settings, Peers, Chat, Setup, Ops.

```bash
npx doucopy                           # AppShell home (Status)
npx doucopy status                    # Status tab
npx doucopy settings                  # searchable switches, Esc discards unsaved
npx doucopy chat                      # Chat tab (ask peers, poll pending replies)
npx doucopy join | setup | invite     # Setup / Invite wizards in the same shell
npx doucopy pause | resume            # Peers tab
```

Settings: draft + explicit save (Ctrl+S). Esc discards with confirm if dirty. Invite `RELAY_SECRET` input is masked. Tab / arrows switch tabs. Press **Ctrl+C twice** (within ~2s) to quit. `q` twice works the same way.

## 3. Classic CLI

Use when non-TTY, scripting, or you want streams instead of the full-screen UI:

```bash
DOUCOPY_NO_TUI=1 npx doucopy status   # one-shot text dump
npx doucopy join <url> <invite> --yes # non-interactive join
npx doucopy logs -f                   # tail responder logs
npx doucopy policy                    # opens ~/.doucopy/policy.md in $EDITOR
npx doucopy start | stop | restart    # launchd daemon
npx doucopy pause work-mbp --for 2h
npx doucopy resume work-mbp
npx doucopy invite --ttl 48 --yes
```

`--yes` and `DOUCOPY_NO_TUI=1` force the classic path. From a repo checkout every command has a `make` alias (`make chat`, `make status`, `make settings`, …). Run `make` for the full list.

## Restrictions and filtering

Three layers on every answering machine:

1. **Harness permissions** (default: write only inside the responder workspace, shell off). Built-in read denials always include `~/.ssh`, `~/.aws`, plus `~/.doucopy` secrets and sibling workspaces (the active workspace stays readable). Edit with `npx doucopy settings` (or `make settings` from a checkout). Model presets follow the chosen harness (Cursor / Claude Code / Codex).
2. **`policy.md`** soft instructions for topics and tone.
3. **`## Never reveal` / redact** hard post-filter on every outgoing answer.

Memory sources cover Cursor, Claude Code and Codex transcript dirs when present. Codex only supports coarse `--sandbox` modes, so per-path write allows are approximate there.

## MCP reference

Raw tool shapes, useful when debugging or writing skills:

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
| `peer_offline` | peer hasn't polled the relay for >60s, question is queued for 24h, use `check_reply` |
| `error` | show the `error` field, don't retry silently |

## Counter-questions

If a question is ambiguous, the responder may fire back one clarifying question in the same conversation. Your local daemon answers it from your own memory sources, then the responder produces the final answer. Relay-enforced limits: `hops` capped at 1, at most 4 open tickets per conversation. Expect this? Pass a generous `timeout_seconds: 240`.
