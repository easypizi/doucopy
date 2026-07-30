SHELL := /usr/bin/env bash
.DEFAULT_GOAL := help

PORT ?= 3000
RELAY_SECRET ?=
APP ?= mcp-ivan-connector
PEER ?=
RELAY ?=
INVITE ?=
TTL ?= 24
FOR ?=
UNTIL ?=
FOLLOW ?=
CLI := node cli/dist/index.js

.PHONY: help install build typecheck test test-watch clean relay \
        join setup policy settings invite chat status logs start stop restart pause resume \
        deploy rotate-secret revoke unrevoke invite-bootstrap health publish

## User-facing (##U) and maintainer (##M) markers keep two sections tidy.
help: ## Show this help
	@printf "\033[1mUser commands\033[0m\n"
	@grep -hE '^[a-zA-Z_-]+:.*?##U ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?##U "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'
	@printf "\n\033[1mMaintainer / relay owner\033[0m\n"
	@grep -hE '^[a-zA-Z_-]+:.*?##M ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?##M "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

# --- User commands ------------------------------------------------------------

join: build ##U Join, reconfigure or resume: make join (bare for wizard) or RELAY=<url> INVITE=<code>
	@if [ -n "$(RELAY)" ] && [ -n "$(INVITE)" ]; then \
		$(CLI) join $(RELAY) $(INVITE); \
	else \
		$(CLI) join; \
	fi

chat: build ##U Interactive terminal REPL for asking peers
	$(CLI) chat

status: build ##U Show daemon, peers, dialogs and paused peers
	$(CLI) status

policy: build ##U Edit ~/.doucopy/policy.md (LLM rules + Never reveal filter)
	$(CLI) policy

settings: build ##U Edit restrictions, model, persona and harness
	$(CLI) settings

logs: build ##U Show responder logs. FOLLOW=1 to stream
	@if [ -n "$(FOLLOW)" ]; then $(CLI) logs -f; else $(CLI) logs; fi

start: build ##U Start the launchd responder daemon
	$(CLI) start

stop: build ##U Stop the launchd responder daemon
	$(CLI) stop

restart: build ##U Restart the launchd responder daemon
	$(CLI) restart

pause: build ##U Pause a peer: make pause PEER=work-mbp FOR=2h (or UNTIL=iso)
	@test -n "$(PEER)" || { echo "PEER is required, e.g. PEER=work-mbp" >&2; exit 2; }
	$(CLI) pause $(PEER) $(if $(FOR),--for $(FOR)) $(if $(UNTIL),--until $(UNTIL))

resume: build ##U Resume a paused peer: make resume PEER=work-mbp
	@test -n "$(PEER)" || { echo "PEER is required" >&2; exit 2; }
	$(CLI) resume $(PEER)

invite: build ##U Issue an invite from this machine (uses local token). TTL=48 to override
	$(CLI) invite --ttl $(TTL)

# --- Maintainer / owner -------------------------------------------------------

setup: build ##M Owner wizard: deploy relay + first join in one flow
	$(CLI) setup

deploy: build ##M Deploy the relay to Heroku and health-check
	$(CLI) deploy --app $(APP)

rotate-secret: build ##M Rotate RELAY_SECRET on Heroku (breaks every peer)
	$(CLI) secret rotate --app $(APP)

revoke: build ##M Revoke a peer: make revoke PEER=<name>
	@test -n "$(PEER)" || { echo "PEER is required, e.g. PEER=ex-mbp" >&2; exit 2; }
	$(CLI) revoke $(PEER) --app $(APP)

unrevoke: build ##M Un-revoke a peer: make unrevoke PEER=<name>
	@test -n "$(PEER)" || { echo "PEER is required" >&2; exit 2; }
	$(CLI) unrevoke $(PEER) --app $(APP)

invite-bootstrap: build ##M Generate a bootstrap invite using the Heroku RELAY_SECRET
	$(CLI) invite --app $(APP) --ttl 48

health: build ##M Hit /health (and /status if a local token exists) for the deployed relay
	$(CLI) health --app $(APP)

relay: build ##M Run the relay locally (needs RELAY_SECRET)
	@test -n "$(RELAY_SECRET)" || { echo "RELAY_SECRET is required" >&2; exit 2; }
	PORT=$(PORT) RELAY_SECRET=$(RELAY_SECRET) $(CLI) relay

publish: build ##M Publish doucopy to npm (runs sync-skills via prepack)
	npm publish --access public

# --- Dev-only targets (hidden from help) --------------------------------------

install:
	npm install

build:
	npm run build

typecheck:
	npx tsc -p relay/tsconfig.json --noEmit
	npx tsc -p daemon/tsconfig.json --noEmit
	npx tsc -p cli/tsconfig.json --noEmit

test:
	npm test

test-watch:
	npx vitest

clean:
	rm -rf relay/dist daemon/dist cli/dist
