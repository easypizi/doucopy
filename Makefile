SHELL := /usr/bin/env bash
.DEFAULT_GOAL := help

# Local relay run
PORT ?= 3000
PEER_TOKEN_A ?= aaa
PEER_TOKEN_B ?= bbb

# Heroku app for deploy targets, override: make deploy APP=my-relay
APP ?=
HEROKU_APP_FLAG := $(if $(APP),-a $(APP),)

.PHONY: help install build typecheck test test-watch clean relay setup \
        start stop restart status logs rebuild uninstall \
        deploy release-token config logs-relay \
        skills-install skills-uninstall skills-status

help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

## --- Development ---

install: ## Install dependencies for all workspaces
	npm install

build: ## Compile relay and daemon (tsc)
	npm run build

typecheck: ## Type-check both workspaces without emitting
	npx tsc -p relay/tsconfig.json --noEmit
	npx tsc -p daemon/tsconfig.json --noEmit

test: ## Run the full test suite once
	npm test

test-watch: ## Run tests in watch mode
	npx vitest

clean: ## Remove build output
	rm -rf relay/dist daemon/dist

relay: build ## Run the relay locally (override PORT, PEER_TOKEN_A, PEER_TOKEN_B)
	PORT=$(PORT) PEER_TOKEN_A=$(PEER_TOKEN_A) PEER_TOKEN_B=$(PEER_TOKEN_B) npm start -w relay

## --- Daemon (macOS launchd) ---

setup: ## Interactive machine setup (config, policy, MCP, LaunchAgent)
	npm run daemon:install

start: ## Load the LaunchAgent (peer goes online)
	npm run daemon:start

stop: ## Unload the LaunchAgent (peer goes offline)
	npm run daemon:stop

restart: ## Restart the daemon after a config or code change
	npm run daemon:restart

status: ## Show daemon state, pid, last exit code and log tails
	npm run daemon:status

logs: ## Follow daemon stdout and stderr
	npm run daemon:logs

rebuild: ## git pull, install, build, restart the daemon
	npm run daemon:rebuild

uninstall: ## Unload and remove the LaunchAgent (config stays)
	npm run daemon:uninstall

## --- Agent skills ---

skills-install: ## Symlink global agent-link skills (ask, answer) into ~/.cursor/skills/
	scripts/skills.sh install

skills-uninstall: ## Remove those symlinks (only if they point at this repo)
	scripts/skills.sh uninstall

skills-status: ## Show what agent-link skills are installed globally
	scripts/skills.sh status

## --- Heroku relay ---

deploy: ## Push the current branch to Heroku main
	git push heroku HEAD:main

release-token: ## Register a peer token: make release-token PEER=WORK TOKEN=xxx APP=my-relay
	@test -n "$(PEER)" || { echo "PEER is required, e.g. PEER=WORK" >&2; exit 2; }
	@test -n "$(TOKEN)" || { echo "TOKEN is required" >&2; exit 2; }
	heroku config:set PEER_TOKEN_$(PEER)=$(TOKEN) $(HEROKU_APP_FLAG)

config: ## Show relay config vars on Heroku
	heroku config $(HEROKU_APP_FLAG)

logs-relay: ## Tail relay logs on Heroku
	heroku logs --tail $(HEROKU_APP_FLAG)
