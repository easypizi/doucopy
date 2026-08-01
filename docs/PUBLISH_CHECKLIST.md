# Publish checklist (bar C)

Do not run `make publish` until every row is **pass**. Hybrid: agent can run Cursor live smoke on this machine. Claude/Codex live and second-machine items need a human.

Threat model: trusted circle, untrusted question ([ADR 0001](adr/0001-trusted-circle-untrusted-question.md)).

| id | check | who | pass/fail | date | notes |
|---|---|---|---|---|---|
| L1 | `make typecheck test` green | agent | pass | 2026-08-01 | re-verify: typecheck ok, 272 tests |
| L2 | Cursor live: default restrictions → no `~/Desktop/doucopy-pwned.txt` | agent | pass | 2026-08-01 | re-verify `make live-smoke-cursor` → DENIED |
| L3 | Cursor live: custom Desktop allow → file created, then cleaned | agent | pass | 2026-08-01 | CREATED then cleaned |
| L4 | Cursor live: shell off → memory Q&A still answers | agent | pass | 2026-08-01 | answered 2+2 |
| L5 | Claude live: default deny Desktop write | human | blocked | 2026-08-01 | `claude` 2.1.92 present but: "Your organization does not have access to Claude." Desktop file absent (inconclusive). |
| L6 | Claude live: custom allow Desktop write | human | blocked | 2026-08-01 | same auth block. Allow phase did not create file. |
| L7 | Codex live: sandbox denies write outside workspace (document if only coarse) | human | blocked | 2026-08-01 | `codex` binary not installed on this machine |
| R1 | Red-team A1–A4 side effects | hybrid | pass | 2026-07-31 | A1/A2 via live-smoke; A3/A4 local harness. Re-smoke Cursor still green 2026-08-01. |
| R2 | Red-team B1–B3 exfil / redact | hybrid | pending | 2026-08-01 | needs second peer asker (`list_peers` empty aside from self) |
| R3 | Red-team C1–C3 prompt injection | hybrid | pending | 2026-08-01 | needs second peer asker |
| S1 | Relay `/health` ok | hybrid | pass | 2026-08-01 | re-verify `{"ok":true}` |
| S2 | Second peer `npx doucopy join` with invite | human | pending | | |
| S3 | Asker-only join works | human | pending | | |
| S4 | Cursor MCP `list_peers` / `ask_peer` | human | pending | 2026-08-01 | MCP `list_peers` = `[]` (self filtered). Needs non-self peer. |
| S5 | Claude MCP `list_peers` / `ask_peer` | human | pending | | |
| S6 | Daemon stop → `peer_offline` + queue, start → `check_reply` answers | hybrid | partial | 2026-07-31 | stop/start via CLI ok. Full queue/`check_reply` needs second peer. |
| S7 | `make settings` changes model/restrictions, restart applies | hybrid | pending | | interactive wizard, human |
| S8 | Codex asker: `~/.codex/config.toml` merge + `list_peers` | human | blocked | 2026-08-01 | no `codex` binary |
| P1 | Version bumped (target 2.3.0) | agent | pass | 2026-08-01 | package.json 2.3.0 |
| P2 | `npm pack` contains `cli/dist` with `settings`, skills, no secrets | agent | pass | 2026-08-01 | re-verify dry-run: settings.js + skills, 88 files |
| P3 | Explicit human approval to publish | human | pending | 2026-08-01 | gate checked: `make publish` refuses without `PUBLISH_I_MEAN_IT=1`. Checklist not fully green. |

## Sign-off

- Checklist completed by: ________
- Date: ________
- Publish command only after P3: `PUBLISH_I_MEAN_IT=1 make publish`

## Agent notes

- Cursor project permissions require spawn `cwd = workspaceDir` (fixed in `daemon/src/runner.ts`).
- Do not blanket-deny `Read(~/.doucopy/**)`. That blocks `task.md` in the active workspace. Use targeted denials for config/policy/sibling workspaces.
- Live report artifacts (gitignored): `docs/live-smoke-cursor-last.json`, `docs/live-smoke-claude-last.json`.
- Re-verify 2026-08-01: agent rows still green. Claude/Codex live blocked on this host. Second peer still missing for R2/R3/S4/S6 full path. **Not ready to publish.**
