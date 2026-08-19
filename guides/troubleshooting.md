# Troubleshooting

| Symptom | Fix |
|---|---|
| `status` shows `HTTP 401: unauthorized` | Token is stale or `RELAY_SECRET` was rotated. Stop the daemon, delete `~/.doucopy/config.json`, mint a fresh invite (`make invite-bootstrap APP=<app>`), rejoin. |
| `list_peers` empty in the chat | Daemons running on peers? (`npx doucopy status` on each). Did you restart Cursor / Claude Code / Codex after `join`? Check `npx doucopy logs -f`. |
| Peer stuck as offline | Peer hasn't polled the relay for >60s. Question is still queued for 24h, use `check_reply(ticket_id)`. |
| `make deploy` fails on `heroku CLI not found` | `brew install heroku && heroku login`, then `heroku git:remote -a <app>`. |
| Docker relay instead of Heroku | Build with the shipped `Dockerfile`, run with `RELAY_SECRET=... PORT=3000 -p 3000:3000` and point `join` at that URL. |
| TUI shows empty squares or broken panel borders (Windows) | The terminal has no font fallback (legacy console host with Consolas). Use Windows Terminal, or run with `DOUCOPY_ASCII=1` for plain ASCII chips and borders. Not a code page issue: an interactive TUI is written through `WriteConsoleW`, so `chcp` does not matter. |
| `doucopy stop` on Windows, then peers still see me online | Stop disables the scheduled task instead of deleting it, so config survives. Check with `schtasks /Query /TN doucopy-responder /FO LIST /V`: it should say `Disabled`. `doucopy start` re-creates and runs it. |
| `ask_peer` rejects attachments | Limits are 5 files, 256 KiB each, 512 KiB total, basename `[A-Za-z0-9._-]`, UTF-8 text only. `too many queued attachment bytes` means an offline peer already has ~4 MiB of files waiting in relay memory. |
