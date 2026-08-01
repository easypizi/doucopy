# Ink CLI TUI design (2026-08-01)

## Goal

Ship a Claude Code-like interactive shell for doucopy: sticky status header, tabbed screens, searchable settings with typed editors, Back/discard without silent saves. Hybrid launch: bare `doucopy` and subcommands open the same AppShell.

## Decisions

- Stack: Ink + React. Business logic stays in pure helpers (`apply*`, join finalize, ops).
- Full surface: Status, Settings, Peers, Chat, Setup/Join, Invite, Ops.
- Non-TTY, `--yes`, `relay`, `logs -f`, and `$EDITOR` for policy stay outside Ink.
- Palette: cyan/green/yellow accent (doucopy), not Claude red. Respect `NO_COLOR`.
- Settings: draft + explicit save. Esc discards (confirm if dirty).
- Keep awake rows: `enabled` switch, `confirm_days`, `confirm_grace_hours` via `applyKeepAwake`.

## Navigation

| Entry | Initial screen |
|---|---|
| `doucopy` | Status |
| `doucopy status` | Status |
| `doucopy settings` | Settings |
| `doucopy chat` | Chat |
| `doucopy join …` | Setup (join mode) |
| `doucopy setup` | Setup (owner deploy) |
| `doucopy invite` | Invite |
| `doucopy pause` / `resume` | Peers |
| ops commands | Ops |

Tabs: Status | Settings | Peers | Chat | Setup | Ops. Tab / ←→ switch. `q` quit.

## Header (poll 3–5s)

peer, model, harness, daemon ●/○, keep-awake ●/○, peers online N/M, incoming queued, open dialogs, short relay host.

## Out of scope

Windows keep-awake, in-Ink log tail, pixel-clone Claude branding.
