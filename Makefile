SHELL := /usr/bin/env bash
.DEFAULT_GOAL := help

PORT ?= 3000
RELAY_SECRET ?=
APP ?= mcp-ivan-connector
PEER ?=
CLI := node cli/dist/index.js

.PHONY: help install build typecheck test test-watch clean relay \
        deploy rotate-secret revoke unrevoke invite-bootstrap health

help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies for all workspaces
	npm install

build: ## Compile relay, daemon and cli (tsc)
	npm run build

typecheck: ## Type-check without emitting
	npx tsc -p relay/tsconfig.json --noEmit
	npx tsc -p daemon/tsconfig.json --noEmit
	npx tsc -p cli/tsconfig.json --noEmit

test: ## Run the full test suite once
	npm test

test-watch: ## Run tests in watch mode
	npx vitest

clean: ## Remove build output
	rm -rf relay/dist daemon/dist cli/dist

relay: build ## Run the relay locally (needs RELAY_SECRET)
	@test -n "$(RELAY_SECRET)" || { echo "RELAY_SECRET is required" >&2; exit 2; }
	PORT=$(PORT) RELAY_SECRET=$(RELAY_SECRET) $(CLI) relay

## --- Relay ops (APP defaults to $(APP)) ---

deploy: build ## Deploy the relay to Heroku and health-check
	$(CLI) deploy --app $(APP)

rotate-secret: build ## Rotate RELAY_SECRET on Heroku (breaks every peer)
	$(CLI) secret rotate --app $(APP)

revoke: build ## Revoke a peer: make revoke PEER=<name>
	@test -n "$(PEER)" || { echo "PEER is required, e.g. PEER=ex-mbp" >&2; exit 2; }
	$(CLI) revoke $(PEER) --app $(APP)

unrevoke: build ## Un-revoke a peer: make unrevoke PEER=<name>
	@test -n "$(PEER)" || { echo "PEER is required" >&2; exit 2; }
	$(CLI) unrevoke $(PEER) --app $(APP)

invite-bootstrap: build ## Generate a bootstrap invite using the Heroku RELAY_SECRET
	$(CLI) invite --app $(APP) --ttl 48

health: build ## Hit /health for the deployed relay
	$(CLI) health --app $(APP)
