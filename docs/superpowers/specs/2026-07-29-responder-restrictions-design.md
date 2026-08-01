# Responder restrictions and settings

Status: approved for implementation, 2026-07-29. Owner: doucopy.

## Goal

Keep the responder a full coding agent, while enforcing owner-chosen limits (filesystem write, filesystem read, shell, conversation topics) in harness-native permission config generated per run. Add a re-runnable `doucopy settings` wizard for those limits, plus model, persona, and harness.

## Decisions

- One channel: everything goes through `ask_peer`. No separate `peer_action` tool.
- Enforcement is code on the answering machine, not prompt-only. The daemon materializes harness permissions before each run.
- Safe default when `restrictions` is missing: write only inside the responder workspace, shell off. Built-in read denials always include `~/.ssh`, `~/.aws`, `~/.doucopy`.
- No interactive approval prompts in the headless responder. Denied means blocked.
- Topic filtering stays on `policy.md` (soft) plus redact (hard). Restrictions cover tools and paths.

## Config shape

```json
{
  "restrictions": {
    "fs_write": { "mode": "workspace_only", "allow": [] },
    "fs_read": { "deny": [] },
    "shell": { "mode": "off", "deny": [] }
  },
  "responder": {
    "persona": "short friendly tone, answer in Russian"
  }
}
```

- `fs_write.mode`: `workspace_only` | `custom` (`custom` = workspace plus `allow` paths).
- `fs_read.deny`: extra read blocklist paths (merged with the built-in three).
- `shell.mode`: `off` | `deny_patterns` | `open`.
- Missing `restrictions` applies the safe default above.

## Per-harness mapping

Verified against current docs (Cursor CLI, Claude Code, Codex CLI) on 2026-07-29.

### cursor-agent

Write `<workspaceDir>/.cursor/cli.json`:

```json
{
  "permissions": {
    "allow": ["Read(...)", "Write(<workspace>/**)", "..."],
    "deny": ["Read(~/.ssh/**)", "Shell(*)", "Write(<outside>/**)", "..."]
  }
}
```

Tokens: `Read(glob)`, `Write(glob)`, `Shell(cmd)`. Deny always wins over allow. `--force` stays (auto-approve unless denied). Because deny wins, a blanket `Write(**)` deny would also block the workspace, so write lockdown uses explicit deny paths for common outside targets (home top-level dirs not covered by allow roots, plus built-in sensitive paths) rather than `Write(**)`.

### claude

Pass `--permission-mode dontAsk` and `--settings` JSON with the same intent in Claude rule syntax (`Read`, `Edit`, `Write`, `Bash`). Absolute on-disk paths use the `//` prefix per Claude docs. `dontAsk` denies tool calls that are not approved, so the allow list is the write/read surface and `Bash` is omitted (or denied) when shell is off.

### codex

Map to the nearest `--sandbox` value only (`read-only` | `workspace-write` | `danger-full-access`). Codex cannot express per-path write allows or shell deny patterns. Document that limitation in skills and CONNECT.

| restrictions | codex `--sandbox` |
|---|---|
| shell off or deny_patterns, write workspace_only | `workspace-write` |
| shell open, or custom write allows outside workspace | `danger-full-access` |

## Prompt

Replace the bare "Do not modify files..." line with a short description of the active restriction modes, inject `responder.persona` when set, keep `policy.md` text as before.

## Settings UX

- Command: `doucopy settings` (sectioned menu).
- Same sections offered during `join` with skip = safe default.
- Atomic config writes reuse existing CLI writers. Offer `doucopy restart` at the end.

## Tests

Unit: `buildPermissions` defaults, custom allows, read deny, shell modes, built-in blocklist always present, three harness formats. Config validation. Settings round-trip. Integration-style checks that default denies Desktop writes and memory answers still work with shell off (via permission artifact assertions and fake harness where a real agent CLI is unavailable).
