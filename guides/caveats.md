# Caveats

## Threat model

doucopy assumes a **trusted circle** of invited peers and an **untrusted question**. Anyone with a valid peer token can ask your responder. Controls on the answering machine (restrictions, `policy.md`, redact, invite/revoke) limit damage from a compromised asker. We do **not** promise isolation against a malicious peer that already holds a valid token. See [CONTEXT.md](../CONTEXT.md).

## Operational limits

- **Responder daemon runs on macOS and Windows.** macOS uses `launchd`. Windows uses Task Scheduler (`schtasks`, task name `doucopy-responder`). Linux can join as asker-only. On unsupported OS, Setup only offers `asker-only`, and `doucopy start` refuses with a clear message.
- **Stopped daemon = no live answers.** A valid token still authenticates to the relay, but nothing runs the harness until the daemon long-polls again. Questions may queue (`peer_offline`) for up to 24h.
- **Keep awake (default on).** While the responder daemon runs, macOS wraps it in `caffeinate` and Windows calls `SetThreadExecutionState` so idle sleep does not freeze the poller. Every 3 days (configurable) the OS asks whether to keep it (osascript on macOS, MessageBox on Windows). **Keep** or Esc/Cancel resets the timer. **Stop** unloads the supervisor. If the dialog never appears (SSH / no GUI) or you ignore it past the grace window, the daemon stops. Configure via `npx doucopy settings` → Keep awake, or `keep_awake` in `~/.doucopy/config.json`. True power-off still means offline.
- **Relay restart drops in-flight questions.** All relay state (open tickets, presence) lives in memory. Queued questions survive for 24h only while the relay is up.
- **No horizontal scaling.** One relay instance by design. Fine for a personal circle, not for a SaaS.
- **Cursor write lockdown is permissions-based**, not a full OS sandbox. Default deny targets common home folders. Prove with the live smoke (`make live-smoke-cursor`) before trusting a release.
- **Codex sandbox is coarse** (`--sandbox` modes only). Per-path write allows and shell deny patterns are approximate there.
- **Old npm versions stay MIT.** Versions published before the license change remain under their original license.

## How it differs from a SaaS

doucopy is built for a small circle of trusted machines, tens rather than thousands:

| A typical SaaS | doucopy |
|---|---|
| Central database with your conversations | No database. Answers are computed on the owner's machine, raw data never uploaded |
| User accounts, sessions, OAuth | Stateless HMAC tokens minted from one relay secret |
| Fleet of servers | One relay instance. Ten peers is ten idle long-poll sockets |
| Privacy policy page | `policy.md` and `restrictions` on each machine, enforced locally in code |
