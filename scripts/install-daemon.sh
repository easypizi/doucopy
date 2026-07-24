#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_SRC="$ROOT/daemon/launchd/com.agent-link.responder.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.agent-link.responder.plist"

if [ ! -f "$ROOT/daemon/dist/index.js" ]; then
  echo "daemon is not built, run: npm run build -w daemon" >&2
  exit 1
fi
if [ ! -f "$HOME/.agent-link/config.json" ]; then
  echo "missing ~/.agent-link/config.json, create it first (see the spec, section 3.3)" >&2
  exit 1
fi

if ! NODE_BIN="$(command -v node)"; then
  echo "node not found in PATH" >&2
  exit 1
fi

escape() { printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'; }

NODE_ESC="$(escape "$NODE_BIN")"
ROOT_ESC="$(escape "$ROOT")"
HOME_ESC="$(escape "$HOME")"

mkdir -p "$HOME/.agent-link/workspace"
chmod 600 "$HOME/.agent-link/config.json"

sed -e "s|__NODE__|$NODE_ESC|g" \
    -e "s|__REPO__|$ROOT_ESC|g" \
    -e "s|__HOME__|$HOME_ESC|g" \
    "$PLIST_SRC" > "$PLIST_DST"

launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load "$PLIST_DST"
echo "agent-link responder installed and started, logs: ~/.agent-link/responder.log"
