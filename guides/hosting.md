# Hosting the relay yourself

You need a Heroku (or Docker) deployment, so this is a git-clone workflow.

```bash
git clone https://github.com/easypizi/doucopy ~/dev/doucopy
cd ~/dev/doucopy
make install && make build
heroku login
make setup
```

`make setup` is the owner wizard: it checks Heroku CLI + login, asks for an app name, runs `make deploy`, mints a 24h bootstrap invite, then hands off to the same `join` wizard so this machine ends up configured as the first peer.

Later ops (all default to `APP=mcp-ivan-connector`, override with `APP=<name>`):

```bash
make deploy            # push and health-check
make health            # /health
make invite-bootstrap  # mint another invite using the Heroku RELAY_SECRET
make rotate-secret     # emergencies only, breaks every peer
make revoke   PEER=ex-mbp
make unrevoke PEER=ex-mbp
make publish           # npm publish (owners only, needs npm login)
```

Local relay for testing: `make relay RELAY_SECRET=$(openssl rand -hex 32)`.
