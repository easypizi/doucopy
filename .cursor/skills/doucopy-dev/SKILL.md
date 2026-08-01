---
name: doucopy-dev
description: "Use when modifying doucopy itself: changing the relay, daemon, or CLI code, adding an MCP tool, updating the prompt or redaction logic, writing or debugging tests. Documents the repo layout, invariants that must be preserved across changes, and the test map."
---

# doucopy: contributor guide (v2)

## Repo layout

```
relay/                fastify HTTP + MCP streamable
  src/
    index.ts          server bootstrap, /mcp routing, /inbox, /answer, /health
    mcp.ts            MCP tool definitions (list_peers, ask_peer, check_reply)
    mailbox.ts        in-memory inbox, pending, waiters, lastSeen, knownPeers
    auth.ts           createTokenService: HMAC peer tokens + invites, revoke list
    rest.ts           /inbox, /answer, /join, /invite, /status
    types.ts          Question shape
  test/               vitest, one file per module

daemon/               responder daemon
  src/
    index.ts          bootstrap, workspace prune, signal handling, legacy home migration
    poller.ts         long-poll /inbox, up to N parallel handlers, drain()
    handler.ts        per-question orchestration, per-conversation workspace
    workspace.ts      safeDirName, pruneWorkspaces
    runner.ts         spawn cursor-agent (create-chat then --resume)
    prompt.ts         buildFirstTask, buildFollowupTask (+ persona / restrictions preamble)
    permissions.ts    buildPermissions + per-harness materialization
    conversations.ts  conversation_id → chatId map
    redact.ts         built-in patterns + user rules
    config.ts         config.json validation (incl. max_concurrent, restrictions, persona)
    migrate.ts        one-time ~/.agent-link → ~/.doucopy home migration
  test/               vitest
  launchd/            com.doucopy.responder.plist

cli/                  doucopy CLI (bin aliases: doucopy, agent-link)
  src/
    index.ts          argv dispatcher (TTY → Ink TUI, --yes / DOUCOPY_NO_TUI → plain)
    tui/              Ink AppShell: header, tabs, Status/Settings/Peers/Chat/Setup/Invite/Ops
    api.ts            HTTP client for /join, /invite, /status
    setup.ts          discoverMemorySources, writeConfig, mergeMcpJson, writeDefaultPolicy
    settings.ts       settings helpers + legacy inquirer wizard (restrictions, model, persona, harness, keep_awake)
    join.ts           end-to-end machine setup (+ finalizeJoin for TUI)
    invite.ts         invite (server-side or --secret bootstrap)
    status.ts         daemon + relay status
    launchd.ts        install / start / stop / detect the launchd daemon, legacy daemon teardown
    logs.ts           tail responder logs
    migrate.ts        one-time ~/.agent-link → ~/.doucopy home migration
    relay.ts          run the relay via npx doucopy relay

Dockerfile            relay image for self-hosting
app.json              Heroku Deploy button config
docs/                 local specs/plans/checklist (gitignored)
```

## Invariants — do not break these

1. **`check_reply` is single-read.** After the first `answered` or `error` return, the entry is deleted. Askers depend on it.
2. **Online window is 60 seconds** since the last inbox long-poll. `list_peers`, `/status` and the `peer_offline` fast-path all read from `mailbox.knownPeers`/`isOnline`. Do not switch to heartbeats without updating all three.
3. **Inbox cap is 100 questions per peer, 24h TTL.** Overflow returns `"overflow"`, expiry returns `"expired"`. These strings are user-facing.
4. **Redaction runs after the LLM finishes, in code** (`daemon/src/handler.ts`, `redact.ts`). Never move any part of it into the prompt.
5. **MCP tools return one text block containing JSON.** Askers parse it verbatim.
6. **`ask_peer` timeouts: default 120s, max 240s, keepalive every 15s.** If you extend the max, update the responder timeout too.
7. **`conversation_id` is opaque to the relay** — only the daemon maps it to a `cursor-agent` chat id. Keep it uuidv7-friendly.
8. **Tokens are stateless HMAC.** Never introduce a database of peers on the relay. Revocation goes through `REVOKED_PEERS` or a `RELAY_SECRET` rotation.
9. **Per-conversation workspaces** are created via `safeDirName(conversation_id)`. Never write to the workspace root directly, parallel `cursor-agent` runs would clobber each other's `task.md`.
10. **Legacy home migration is a one-way rename.** `migrateLegacyHome` moves `~/.agent-link` to `~/.doucopy` only when the new path doesn't exist yet. Do not make it copy or merge, a bare `renameSync` is the whole contract.
11. **`buildPermissions` invariants** (`daemon/src/permissions.ts`): deny wins over allow in Cursor and Claude rule evaluation. Built-in read denials always include `~/.ssh`, `~/.aws`, plus targeted `~/.doucopy` secrets/sibling workspaces (never a blanket `~/.doucopy/**`, that would block `task.md` in the active workspace). Missing `restrictions` means workspace-only writes and shell off. Do not put a blanket `Write(**)` deny under Cursor `--force`, it would also block the workspace because deny wins. Codex only gets a coarse `--sandbox` mapping. Cursor runner **must** `spawn` with `cwd: workspaceDir` so `<workspace>/.cursor/cli.json` is loaded. Without that cwd, project denies are ignored and `--force` allows outside writes.
12. **`memory_sources.transcripts_glob`** may be a `string` or `string[]`. `loadConfig` normalizes to a non-empty `string[]` (expandHome on each). Default join detection adds Cursor / Claude Code / Codex globs when their home dirs exist. Do not hardcode Cursor-only paths in new defaults.
13. **Responder model is harness-scoped.** Settings presets live in `cli/src/settings.ts` (`MODEL_PRESETS`). `defaultConfig` does not set `model`. Join sets `composer-2.5` only for `cursor-agent`. Switching harness in settings must not leave a foreign model id in place.
14. **Keep awake.** Default `keep_awake.enabled=true` wraps the launchd program in `/usr/bin/caffeinate -dims` so idle sleep cannot freeze the poller. Periodic confirm (`confirm_days`, default 3) is enforced inside the daemon (`keepAwake.ts`). Decline or grace timeout unloads launchd. `confirm_days: 0` disables prompts. Re-install plist via `doucopy restart` / `installDaemon` after changing `keep_awake.enabled`.

## Test map

`npm test` runs vitest across all three workspaces.

| File | What it covers |
|---|---|
| `relay/test/auth.test.ts` | `createTokenService`, invite lifecycle, revoke, bearer parsing |
| `relay/test/mailbox.test.ts` | enqueue, TTL, overflow, online window, waitForAnswer, knownPeers/outgoingFor |
| `relay/test/mcp.test.ts` | list_peers, ask_peer (offline/never-seen/self), check_reply, keepalive |
| `relay/test/rest.test.ts` | /health, /inbox, /answer, /join (+ rate limit), /invite, /status |
| `relay/test/index.test.ts` | /mcp 405 for GET/DELETE |
| `daemon/test/config.test.ts` | loadConfig validation, max_concurrent, redact, restrictions, persona |
| `daemon/test/conversations.test.ts` | store, 7-day prune, corruption recovery |
| `daemon/test/handler.test.ts` | per-conversation workspace, redaction, resume, cli.json materialization |
| `daemon/test/integration.test.ts` | real relay + daemon + fake cursor-agent |
| `daemon/test/permissions.test.ts` | buildPermissions defaults, allow/deny, three harness formats |
| `daemon/test/restrictions-integration.test.ts` | Desktop lockdown, custom allow, read blocklist, shell-off memory reads |
| `daemon/test/poller.test.ts` | poll loop, backoff, parallel dispatch, drain |
| `daemon/test/prompt.test.ts` | first/followup task content, persona, restrictions preamble |
| `daemon/test/redact.test.ts` | literals, patterns, built-ins |
| `daemon/test/runner.test.ts` | createChat, runTask, timeout |
| `daemon/test/workspace.test.ts` | safeDirName, pruneWorkspaces |
| `cli/test/api.test.ts` | HTTP client wrappers |
| `cli/test/setup.test.ts` | memory discovery, config, policy, mcp.json merge |
| `cli/test/settings.test.ts` | settings helpers round-trip |
| `cli/test/join-resume.test.ts` | existing connection reuse, join-draft persistence |

Integration uses `daemon/test/fixtures/fake-cursor-agent.sh`. Keep it fast and deterministic.

## Common commands

```bash
npm install
npm run build                     # tsc emit into relay/dist, daemon/dist, cli/dist
npm test
```

## Adding a new MCP tool

1. Define it in `relay/src/mcp.ts` with a Zod input schema and a return-text-block handler.
2. Add integration coverage in `relay/test/mcp.test.ts`.
3. If askers should know about it, extend `doucopy-ask`.

## Prompt changes

- Persistent rules go in `daemon/src/prompt.ts` (`buildFirstTask` and `buildFollowupTask`).
- Advisory rules stay in the corresponding skill.
- Update `daemon/test/prompt.test.ts` for anything asserted on.
