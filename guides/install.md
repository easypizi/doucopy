# Install

You need Node 22 and an invite code (looks like `ali1.eyJ...`). Then:

```bash
npx doucopy join <relay-url> <invite>
```

The wizard asks:

1. **Peer name** for this machine (default is your hostname, editable).
2. **Where to authorize** as an asker: Cursor / Claude Code / Codex (multi-select, pre-checked based on what's installed).
3. **Which harness answers questions** for other peers, or pick `asker-only` if you never want to be a responder.
4. **Install skills globally** into `~/.cursor/skills` and `~/.claude/skills` (these teach your agent to use natural-language asks).
5. **Never reveal**: comma-separated words the responder must strip from every outgoing answer.
6. **Restrictions** (optional, skip = safe default): write folders, read blocklist, shell mode.

Then, without asking:

- exchanges the invite for a peer token,
- writes `~/.doucopy/config.json` and `~/.doucopy/policy.md`,
- merges a `doucopy` entry into the MCP config of every chosen client,
- (unless asker-only) installs and starts the `launchd` responder daemon and waits until it reports online.

**Restart your coding agent (Cursor / Claude Code / Codex)** so it picks up the new MCP server.

## Resuming the wizard

Run `npx doucopy join` without arguments any time:

- If this machine is already connected, the wizard offers to reuse the existing peer and token and just walks through askers / responder / skills / policy / restrictions again.
- If a previous run was interrupted after you typed the relay URL and invite, they're prefilled on the next attempt (draft stored in `~/.doucopy/join-draft.json`, TTL 48h, deleted on success).

## Non-interactive join

```bash
npx doucopy join <relay-url> <invite> \
  --name work-mbp --harness claude --askers cursor,claude \
  --never-reveal "AcmeCorp, project-yellowstone" --yes
```

## Requirements

### To join as a peer

- Node.js 22.x on the machine.
- An invite code from someone already in the circle.
- macOS if this machine should run the responder daemon (`launchd`). Asker-only mode works on Linux too.
- A local coding-agent CLI on every responder machine: `cursor-agent`, `claude` or `codex`.

If the circle already has a relay, you can stop here and run `npx doucopy join`.

### To host the relay

- Heroku (or Docker) capacity for one small Node service.
- See [hosting.md](hosting.md).
