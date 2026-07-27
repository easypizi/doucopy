SHELL := /usr/bin/env bash
.DEFAULT_GOAL := help

PORT ?= 3000
RELAY_SECRET ?=

.PHONY: help install build typecheck test test-watch clean relay

help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

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
	PORT=$(PORT) RELAY_SECRET=$(RELAY_SECRET) node cli/dist/index.js relay
