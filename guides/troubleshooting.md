# Troubleshooting

| Symptom | Fix |
|---|---|
| `status` shows `HTTP 401: unauthorized` | Token is stale or `RELAY_SECRET` was rotated. Stop the daemon, delete `~/.doucopy/config.json`, mint a fresh invite (`make invite-bootstrap APP=<app>`), rejoin. |
| `list_peers` empty in the chat | Daemons running on peers? (`npx doucopy status` on each). Did you restart Cursor / Claude Code / Codex after `join`? Check `npx doucopy logs -f`. |
| Peer stuck as offline | Peer hasn't polled the relay for >60s. Question is still queued for 24h, use `check_reply(ticket_id)`. |
| `make deploy` fails on `heroku CLI not found` | `brew install heroku && heroku login`, then `heroku git:remote -a <app>`. |
| Docker relay instead of Heroku | Build with the shipped `Dockerfile`, run with `RELAY_SECRET=... PORT=3000 -p 3000:3000` and point `join` at that URL. |
