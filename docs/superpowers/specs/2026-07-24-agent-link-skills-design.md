# agent-link skills set — design

Date: 2026-07-24

## Goal

Ship a maintainable set of Cursor Agent Skills covering every side of `agent-link`: the asking agent, the responding agent, machine setup, day-to-day troubleshooting, relay operations, privacy tuning, and product development. Skills must be grounded in code, not documentation folklore, and must survive independent evolution of prompt/config/runtime.

## Non-goals

- Adding new MCP tools or changing the wire protocol.
- Documenting workflows unrelated to `agent-link` (e.g. general Cursor skill authoring).
- Prescribing how the user should format questions in their own domain.

## Skills and where they live

| Skill | Location | Trigger |
|---|---|---|
| `agent-link-ask` | repo `.cursor/skills/agent-link-ask/`, symlinked into `~/.cursor/skills/` | user wants to ask their other machine's agent something, `ask_peer` intent |
| `agent-link-answer` | repo `.cursor/skills/agent-link-answer/`, symlinked into `~/.cursor/skills/` | headless `cursor-agent` invoked by the responder daemon inside `~/.agent-link/workspace` |
| `agent-link-setup` | repo `.cursor/skills/agent-link-setup/` | joining a new machine, MCP not appearing, token registration |
| `agent-link-troubleshoot` | repo `.cursor/skills/agent-link-troubleshoot/` | peer offline, `pending` answers, `unknown_ticket`, 401/403, empty answers |
| `agent-link-relay` | repo `.cursor/skills/agent-link-relay/` | deploy/rotate/operate the Heroku relay |
| `agent-link-privacy` | repo `.cursor/skills/agent-link-privacy/` | tighten what the responder can reveal, red-teaming |
| `agent-link-dev` | repo `.cursor/skills/agent-link-dev/` | modifying agent-link itself (relay/daemon/tests) |
| `agent-link-peers` | `~/.cursor/skills/agent-link-peers/`, not in git | personal overlay with real peer names and relay URL |

`agent-link-ask` and `agent-link-answer` are the only globally-available skills; the rest fire only inside the repo. `agent-link-peers` is created by hand on each machine and never checked in.

## Facts each skill leans on (from code)

Cited so the SKILL.md files stay honest.

- `ask_peer`: `timeout_seconds` default 120, max 240; MCP keepalive every 15s (`relay/src/mcp.ts:6-8,72-86`).
- Response statuses: `answered`, `error`, `pending`, `peer_offline`; each carries `ticket_id` and `conversation_id` (`relay/src/mcp.ts:60-90`).
- `check_reply`: single-read; consumed entry returns `unknown_ticket` on subsequent calls (`relay/src/mailbox.ts:156-160`).
- Online window: 60 seconds since the last inbox long-poll (`relay/src/mailbox.ts:7,151-154`). No long-poll for >60s → the peer is "offline" to askers.
- Inbox: max 100 questions per peer, 24h TTL for both questions and settled tickets (`relay/src/mailbox.ts:4-6,52,107,171-176`).
- Conversations: `conversation_id` → `cursor-agent` chatId map stored at `~/.agent-link/conversations.json`, pruned after 7 days (`daemon/src/conversations.ts:4,28-32`).
- Redaction: applied in code after the LLM finishes; built-in patterns for OpenAI/GitHub/AWS/Slack keys, JWTs, PEM private keys; user rules from `redact.literals` (case-insensitive substring) and `redact.patterns` (regex, `gi`) (`daemon/src/redact.ts:10-50`).
- Logs: `~/.agent-link/responder.log`, `~/.agent-link/responder.err.log`. LaunchAgent label `com.agent-link.responder`.
- Poller: initial 1s backoff, cap 60s, cap 300s on auth errors; answer POST retried 3× with 1s spacing (`daemon/src/poller.ts:6-8,53,76-77,103-107`).

Each skill cites only what it needs.

## Content contracts

### `agent-link-ask` (global)

Focus: the asker's workflow.

- Check `list_peers` before asking, to pick a peer and confirm it is online.
- Write self-contained questions: the responder has none of the asker's chat context.
- Pick `timeout_seconds` (default 120, max 240) based on expected search depth.
- Handle four statuses inline, no `references/` file.
- Follow-ups: pass the same `conversation_id` back.
- Recovery: `check_reply(ticket_id)` if the client dropped or the peer was offline; single-read, so save the answer.
- Guard: **do not apply this skill when running inside `~/.agent-link/workspace`** (that means you are the responder; use `agent-link-answer` instead).

### `agent-link-answer` (global)

Focus: how to find facts efficiently on the responder side. Deliberately does **not** repeat policy, "don't invent facts", or "plain text output" — those live in the daemon prompt at `daemon/src/prompt.ts` and would drift if duplicated.

Content:
- Transcript file layout: `.jsonl`, one line per event, chronological. Practical search: `rg -N`, filter by date via filename glob when possible.
- Prefer curated sources listed in the task before falling back to workspace scan.
- Token discipline: don't dump whole transcripts, quote spans.
- Follow-ups reuse the first turn's memory, no need to re-list files.

### `agent-link-setup` (repo)

- Preconditions: Node 22+, `cursor-agent` logged in, a relay URL.
- Command: `./scripts/setup-machine.sh` (interactive, generates token, writes `~/.agent-link/config.json`, `policy.md`, merges MCP, installs LaunchAgent).
- Register token on relay: `make release-token PEER=<NAME> TOKEN=<value> APP=<app>`.
- Verify: `make status`, `list_peers` from a Cursor chat, `curl /health`.
- Uninstall: `make uninstall` keeps config.

### `agent-link-troubleshoot` (repo)

Ranked diagnosis:
1. Peer looks offline → check `make status`; if daemon down, `make start`; if daemon up, tail `responder.err.log`, look for auth errors (300s backoff), then relay `/health`.
2. `pending` never resolves → daemon crashed mid-run or `cursor-agent` timed out (`response_timeout_seconds`). Retry via `check_reply(ticket_id)` (24h window). Note: single-read consume.
3. `unknown_ticket` → already consumed, TTL expired (24h), or relay restarted (in-memory).
4. 401/403 → wrong `token` in `config.json` vs `PEER_TOKEN_<NAME>` env on relay, or mismatched peer name.
5. Empty answer → responder produced nothing or got wiped by redaction; check `responder.log` for "redacted N match(es)".

### `agent-link-relay` (repo)

- `make deploy`, `make config`, `make logs-relay`.
- `make release-token PEER=WORK TOKEN=... APP=...` maps to `heroku config:set PEER_TOKEN_WORK=...`.
- Dyno tier: `basic` minimum (eco sleeps → all peers appear offline).
- Storage: in-memory only. Restart drops queued questions, waiters, and unresolved tickets.

### `agent-link-privacy` (repo)

Two-layer model:

- Hard (deterministic, cannot be talked around): `redact.literals`, `redact.patterns`, built-in secret regexes. Applied to `answer` and `error` fields.
- Soft (probabilistic): `policy.md` embedded into the responder prompt with an untrusted-input framing.

Decision rule: any exact string or pattern you cannot leak goes into `redact` first. `policy.md` handles shape-of-answer rules that resist regex.

`references/red-team.md`: the exact four probes from `README.md` plus two more (dump config, list env vars), for use with `ask_peer`.

### `agent-link-dev` (repo)

- Repo layout: `relay/` (Fastify + MCP streamable), `daemon/` (poller → runner → prompt → redact), `scripts/`.
- Invariants to preserve:
  - `check_reply` is single-read.
  - Online window is 60s.
  - Inbox cap 100/peer, 24h TTL.
  - Redaction applies after the LLM.
- Test map: 13 vitest files (`relay/test/*.test.ts`, `daemon/test/*.test.ts`), integration uses `daemon/test/fixtures/fake-cursor-agent.sh`.
- Commands: `make typecheck test`.

### `agent-link-peers` (personal, not in git)

- Real peer names (`work`, `personal`, ...), the relay URL, common ask phrasings.
- Never contains a token; points to `SETUP_NOTES.local.md` for that.
- Loaded alongside `agent-link-ask`, defers to it on any conflict.

## Code changes

1. **Daemon prompt** (`daemon/src/prompt.ts`): add a line to `buildFirstTask` and `buildFollowupTask` telling the responder to follow the `agent-link-answer` skill if available. Update `daemon/test/prompt.test.ts` to assert the mention. Rationale: automatic discovery is documented for headless CLI but unspecified for symlinked skills in headless; an explicit mention costs nothing and de-risks the failure mode.

2. **Install script + Makefile targets**:
   - `scripts/skills.sh` with `install` and `uninstall` subcommands. Symlinks `.cursor/skills/agent-link-ask` and `.cursor/skills/agent-link-answer` into `~/.cursor/skills/`. Idempotent: skip if the symlink already points to the right target, refuse if a non-symlink exists.
   - `make skills-install` and `make skills-uninstall`.

3. **README**: short section documenting `make skills-install` and pointing at the repo skills.

4. **SKILLS_INDEX**: rule 7 in `~/.cursor/SKILLS_INDEX.md` should reference "inside the agent-link repo" rather than the hardcoded `~/Documents/dev/pshpsh/` path, so it works on the second machine.

## Execution order

Spec (this file) → `ask` → `answer` → prompt patch → install script + Makefile → smoke test (ask own daemon to list skills it sees) → `setup` + `troubleshoot` → `relay` + `privacy` → `dev` → personal `peers` → `make typecheck test` and live scenarios against `work` peer.

The smoke test moves up front deliberately: if headless `cursor-agent` doesn't pick up the symlinked skill, we learn it before writing five more.

## Risks

- **Skill discovery in headless via symlinks is undocumented.** Mitigated by the explicit mention in the daemon prompt and the early smoke test.
- **Prompt drift.** `agent-link-answer` is scoped tightly to "how to search" so it can't contradict the daemon prompt. Any rule about output shape or policy stays in `daemon/src/prompt.ts`.
- **Personal overlay leaking secrets.** `agent-link-peers` explicitly forbids inlining tokens; it references `SETUP_NOTES.local.md`.
