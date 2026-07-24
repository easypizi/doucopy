#!/usr/bin/env bash
set -euo pipefail

# Interactive setup for one agent-link peer machine.
# Creates ~/.agent-link/{config.json,policy.md}, merges the relay into
# ~/.cursor/mcp.json, builds the daemon, installs the launchd agent.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_DIR="$HOME/.agent-link"
CONFIG_PATH="$AGENT_DIR/config.json"
POLICY_PATH="$AGENT_DIR/policy.md"
MCP_PATH="$HOME/.cursor/mcp.json"

NO_LAUNCHD=0
for arg in "$@"; do
  case "$arg" in
    --no-launchd) NO_LAUNCHD=1 ;;
    -h|--help)
      cat <<EOF
Usage: scripts/setup-machine.sh [--no-launchd]

Interactive setup for this machine as an agent-link peer.
  --no-launchd   Skip the launchd install step (for dry runs)
EOF
      exit 0
      ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

prompt() {
  local var_name="$1" label="$2" default="${3:-}" reply
  if [ -n "$default" ]; then
    read -r -p "$label [$default]: " reply || true
    reply="${reply:-$default}"
  else
    read -r -p "$label: " reply || true
  fi
  printf -v "$var_name" '%s' "$reply"
}

echo "agent-link machine setup"
echo

prompt PEER_NAME "Peer name (personal/work)" "personal"
if [ -z "$PEER_NAME" ]; then
  echo "peer name is required" >&2
  exit 1
fi
PEER_NAME="$(printf '%s' "$PEER_NAME" | tr '[:upper:]' '[:lower:]')"

prompt RELAY_URL "Relay URL" "https://agent-link-relay.herokuapp.com"
if [[ ! "$RELAY_URL" =~ ^https?:// ]]; then
  echo "relay url must start with http:// or https://" >&2
  exit 1
fi

prompt TOKEN_INPUT "Bearer token (leave empty to generate one)" ""
if [ -z "$TOKEN_INPUT" ]; then
  if ! command -v openssl >/dev/null 2>&1; then
    echo "openssl not found, cannot generate a token" >&2
    exit 1
  fi
  TOKEN_INPUT="$(openssl rand -hex 32)"
  echo
  echo "Generated token for peer '$PEER_NAME':"
  echo "  $TOKEN_INPUT"
  echo "Save it - the relay needs the same value in PEER_TOKEN_$(printf '%s' "$PEER_NAME" | tr '[:lower:]' '[:upper:]')."
  echo
fi

mkdir -p "$AGENT_DIR"

# Build daemon if not already built.
if [ ! -f "$ROOT/daemon/dist/index.js" ]; then
  echo "Building daemon..."
  ( cd "$ROOT" && npm install --silent && npm run build --silent -w daemon )
fi

# Write config.json via node so JSON is well-formed and paths escaped.
CONFIG_TMP="$(mktemp)"
PEER_NAME="$PEER_NAME" RELAY_URL="$RELAY_URL" TOKEN_INPUT="$TOKEN_INPUT" \
node -e '
const fs = require("node:fs");
const out = {
  relay_url: process.env.RELAY_URL,
  self_peer: process.env.PEER_NAME,
  token: process.env.TOKEN_INPUT,
  memory_sources: {
    transcripts_glob: "~/.cursor/projects/*/agent-transcripts/*.jsonl",
    agents_md_roots: ["~/Documents/dev"],
    extra_files: [],
  },
  responder: {
    cursor_agent_binary: "cursor-agent",
    workspace_dir: "~/.agent-link/workspace",
    response_timeout_seconds: 300,
  },
};
fs.writeFileSync(process.argv[1], JSON.stringify(out, null, 2) + "\n");
' "$CONFIG_TMP"
mv "$CONFIG_TMP" "$CONFIG_PATH"
chmod 600 "$CONFIG_PATH"
echo "wrote $CONFIG_PATH"

# Seed policy.md only if it does not exist.
if [ ! -f "$POLICY_PATH" ]; then
  cat > "$POLICY_PATH" <<'POLICY'
You are answering an agent from my other account. Talk about my actions,
achievements, habits and goals. Do not disclose:
- contents of specific source files
- secrets, keys, tokens, passwords
- internal names of companies, clients or projects that sound confidential

When in doubt, generalise or decline to answer that specific point and
briefly explain why.
POLICY
  echo "wrote $POLICY_PATH (edit it to add your own rules)"
else
  echo "kept existing $POLICY_PATH"
fi

# Merge relay into ~/.cursor/mcp.json, preserving other servers, with a backup.
mkdir -p "$(dirname "$MCP_PATH")"
MCP_PATH="$MCP_PATH" RELAY_URL="$RELAY_URL" TOKEN_INPUT="$TOKEN_INPUT" \
node -e '
const fs = require("node:fs");
const path = process.env.MCP_PATH;
let data = {};
if (fs.existsSync(path)) {
  const raw = fs.readFileSync(path, "utf8");
  try { data = JSON.parse(raw); } catch { data = {}; }
  fs.writeFileSync(path + ".bak", raw);
}
if (!data.mcpServers || typeof data.mcpServers !== "object") data.mcpServers = {};
data.mcpServers["agent-link"] = {
  url: process.env.RELAY_URL.replace(/\/$/, "") + "/mcp",
  headers: { Authorization: "Bearer " + process.env.TOKEN_INPUT },
};
fs.writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
'
echo "updated $MCP_PATH (backup at $MCP_PATH.bak if it existed before)"

if [ "$NO_LAUNCHD" -eq 1 ]; then
  echo
  echo "Skipped launchd install (--no-launchd)."
else
  echo
  echo "Installing launchd agent..."
  "$ROOT/scripts/install-daemon.sh"
fi

PEER_UPPER="$(printf '%s' "$PEER_NAME" | tr '[:lower:]' '[:upper:]')"
echo
echo "Done. Next steps:"
echo "  1. On the Heroku app (once, from any machine with heroku CLI):"
echo "       heroku config:set PEER_TOKEN_$PEER_UPPER=$TOKEN_INPUT -a <your-heroku-app>"
echo "  2. Run this script on the OTHER machine with a different peer name and a fresh token."
echo "  3. Restart Cursor so it picks up the new MCP server."
