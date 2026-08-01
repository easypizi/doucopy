# doucopy

**Two agents. Different machines. Same trusted circle. Ask across chat history, notes, and code without uploading raw memory.**

[![npm](https://img.shields.io/npm/v/doucopy.svg)](https://www.npmjs.com/package/doucopy)
[![license](https://img.shields.io/npm/l/doucopy.svg)](LICENSE)
[![node](https://img.shields.io/node/v/doucopy.svg)](https://nodejs.org)

<!-- Drop demo.webp in the repo root after you record the TUI walkthrough. -->
<!-- ![demo](demo.webp) -->

```
You:  Hey Claude, ask John's agent how he implemented auth in Cursor.
John's agent:  Session cookies + refresh token in httpOnly storage. See AGENTS.md under auth/.
```

## Install

Got an invite?

```bash
npx doucopy join <relay-url> <invite>
```

The wizard wires Cursor / Claude Code / Codex, installs the responder daemon, and you're done. Restart your coding agent so it picks up MCP.

Full wizard details: [guides/install.md](guides/install.md).

## Why does this exist?

Every AI coding agent keeps memory in a silo. Your work Cursor doesn't know what home Claude decided yesterday. Nobody's agent can ask a colleague's agent a question.

doucopy connects them. Each machine answers from **its own local memory**. Raw data never leaves. Only the written answer does, through policy and restrictions you control.

**Use cases:** work ↔ home memory, Cursor ↔ Codex bridges, small trusted circles with per-machine policy.

## How it works

```
your coding agent (Cursor / Claude Code / Codex)
  ├── natural-language ask (skills → ask_peer)
  ├── relay forwards the question (stateless HMAC, no database)
  ├── peer's responder daemon long-polls + runs its agent CLI
  └── answer returns through the relay into your chat
```

Two parts: a **relay** someone hosts once, a **responder daemon** on every answering Mac.

## Daily use

| Surface | How |
|---|---|
| **Coding apps** | "Ask my work machine what I decided about billing." |
| **TUI** | `npx doucopy` — Status / Settings / Peers / Chat (Ctrl+C twice to quit) |
| **Classic CLI** | `DOUCOPY_NO_TUI=1`, `--yes`, `logs -f`, scripted join |

More: [guides/daily-use.md](guides/daily-use.md).

## Guides

| Guide | |
|---|---|
| [Install & requirements](guides/install.md) | Join wizard, asker-only, non-interactive flags |
| [Hosting the relay](guides/hosting.md) | Heroku / Docker owner setup |
| [Daily use](guides/daily-use.md) | Apps, TUI, CLI, MCP tools, restrictions |
| [Caveats](guides/caveats.md) | Threat model, keep-awake, limits |
| [Troubleshooting](guides/troubleshooting.md) | 401, offline peers, deploy |
| [Development](guides/development.md) | Build, test, pack |
| [CONTEXT.md](CONTEXT.md) | Project intent and constraints |

## License

[FSL-1.1-MIT](LICENSE). Free to use and modify except competing commercial products. Becomes MIT two years after each release.
