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

# ask_yn LABEL DEFAULT(y|n) -> exit code 0 for yes, 1 for no
ask_yn() {
  local label="$1" default="$2" hint reply
  if [ "$default" = "y" ]; then hint="[Y/n]"; else hint="[y/N]"; fi
  read -r -p "$label $hint: " reply || true
  reply="${reply:-$default}"
  case "$reply" in
    y|Y|yes|YES|Yes) return 0 ;;
    *) return 1 ;;
  esac
}

echo "agent-link machine setup"
echo

prompt PEER_NAME "Peer name (personal/work)" "personal"
if [ -z "$PEER_NAME" ]; then
  echo "peer name is required" >&2
  exit 1
fi
PEER_NAME="$(printf '%s' "$PEER_NAME" | tr '[:upper:]' '[:lower:]')"

prompt RELAY_URL "Relay URL (one relay serves ALL machines, e.g. https://my-relay.herokuapp.com)" ""
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

echo
echo "Memory sources"
echo "Chat transcripts (~/.cursor/projects/*/agent-transcripts) are always included."
echo "Note: Cursor's built-in Memories are not stored as files and cannot be read."
echo

AGENTS_ROOTS=""
EXTRA_FILES=""

append_csv() {
  # append_csv VAR_NAME VALUE
  local var_name="$1" value="$2" current
  eval "current=\"\$$var_name\""
  if [ -n "$current" ]; then
    printf -v "$var_name" '%s,%s' "$current" "$value"
  else
    printf -v "$var_name" '%s' "$value"
  fi
}

# Global Cursor markdown files, not bound to any project.
GLOBAL_MD_FOUND=0
for f in "$HOME/.cursor/"*.md; do
  [ -f "$f" ] || continue
  GLOBAL_MD_FOUND=1
  if ask_yn "Include global Cursor file ~/.cursor/$(basename "$f")?" "y"; then
    append_csv EXTRA_FILES "$f"
  fi
done
if [ "$GLOBAL_MD_FOUND" -eq 0 ]; then
  echo "No global markdown files found in ~/.cursor."
fi

# Common dev folders containing AGENTS.md memory files.
ROOTS_FOUND=0
for root in "$HOME/dev" "$HOME/Documents/dev" "$HOME/Projects" "$HOME/projects" \
            "$HOME/code" "$HOME/src" "$HOME/work" "$HOME/Developer"; do
  [ -d "$root" ] || continue
  count="$(find "$root" -maxdepth 4 -name AGENTS.md -type f 2>/dev/null | wc -l | tr -d ' ')"
  [ "$count" -gt 0 ] || continue
  ROOTS_FOUND=1
  if ask_yn "Scan $root for AGENTS.md ($count found)?" "y"; then
    append_csv AGENTS_ROOTS "$root"
  fi
done
if [ "$ROOTS_FOUND" -eq 0 ]; then
  echo "No AGENTS.md files found in common dev folders."
fi

prompt MANUAL_ROOTS "Extra folders to scan for AGENTS.md (comma-separated, optional)" ""
if [ -n "$MANUAL_ROOTS" ]; then
  append_csv AGENTS_ROOTS "$MANUAL_ROOTS"
fi
prompt MANUAL_FILES "Extra memory files to include as-is (comma-separated, optional)" ""
if [ -n "$MANUAL_FILES" ]; then
  append_csv EXTRA_FILES "$MANUAL_FILES"
fi

echo
echo "Privacy policy"
echo "These answers generate ~/.agent-link/policy.md (instructions for the responding"
echo "agent) and hard redaction rules in config.json (applied in code, cannot be"
echo "bypassed by any prompt). Secrets, keys and tokens are always blocked."
echo

POLICY_EXTRA_RULES=""
REDACT_WORDS=""

if ! ask_yn "Allow discussing work projects and achievements?" "y"; then
  POLICY_EXTRA_RULES="$POLICY_EXTRA_RULES
- Do not discuss work projects or achievements. Only answer about general
  habits, tools and skills."
fi

if ! ask_yn "Allow naming companies, clients and internal project codenames?" "n"; then
  POLICY_EXTRA_RULES="$POLICY_EXTRA_RULES
- Never name companies, clients or internal project codenames. Refer to them
  generically (\"a client\", \"an internal project\")."
  prompt REDACT_WORDS "Names to hard-redact from every answer (comma-separated, optional)" ""
fi

if ! ask_yn "Allow quoting or describing source code contents?" "n"; then
  POLICY_EXTRA_RULES="$POLICY_EXTRA_RULES
- Never quote, paraphrase or describe the contents of source code files."
fi

if ! ask_yn "Allow revealing file paths, repository and directory names?" "n"; then
  POLICY_EXTRA_RULES="$POLICY_EXTRA_RULES
- Never reveal file paths, repository names or directory structures."
fi

prompt EXTRA_REDACT "Any other words to hard-redact from every answer (comma-separated, optional)" ""
if [ -n "$EXTRA_REDACT" ]; then
  if [ -n "$REDACT_WORDS" ]; then
    REDACT_WORDS="$REDACT_WORDS,$EXTRA_REDACT"
  else
    REDACT_WORDS="$EXTRA_REDACT"
  fi
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
AGENTS_ROOTS="$AGENTS_ROOTS" EXTRA_FILES="$EXTRA_FILES" REDACT_WORDS="$REDACT_WORDS" \
node -e '
const fs = require("node:fs");
const splitList = (s) => (s || "").split(",").map((x) => x.trim()).filter(Boolean);
const out = {
  relay_url: process.env.RELAY_URL,
  self_peer: process.env.PEER_NAME,
  token: process.env.TOKEN_INPUT,
  memory_sources: {
    transcripts_glob: "~/.cursor/projects/*/agent-transcripts/**/*.jsonl",
    agents_md_roots: splitList(process.env.AGENTS_ROOTS),
    extra_files: splitList(process.env.EXTRA_FILES),
  },
  responder: {
    cursor_agent_binary: "cursor-agent",
    workspace_dir: "~/.agent-link/workspace",
    response_timeout_seconds: 300,
  },
  redact: {
    literals: splitList(process.env.REDACT_WORDS),
    patterns: [],
  },
};
fs.writeFileSync(process.argv[1], JSON.stringify(out, null, 2) + "\n");
' "$CONFIG_TMP"
mv "$CONFIG_TMP" "$CONFIG_PATH"
chmod 600 "$CONFIG_PATH"
echo "wrote $CONFIG_PATH"

# Generate policy.md from the wizard answers. Keep an existing file unless
# the user agrees to replace it.
WRITE_POLICY=1
if [ -f "$POLICY_PATH" ]; then
  if ask_yn "policy.md already exists, replace it with the wizard result?" "n"; then
    cp "$POLICY_PATH" "$POLICY_PATH.bak"
    echo "backed up old policy to $POLICY_PATH.bak"
  else
    WRITE_POLICY=0
  fi
fi
if [ "$WRITE_POLICY" -eq 1 ]; then
  {
    cat <<'POLICY'
You are answering an agent from my other account. Answer questions about my
actions, achievements, habits and goals based on my chat history and memory.

Rules:
- Never disclose secrets, keys, tokens, passwords or credentials of any kind.
POLICY
    if [ -n "$POLICY_EXTRA_RULES" ]; then
      printf '%s\n' "$POLICY_EXTRA_RULES" | sed '/^$/d'
    fi
    cat <<'POLICY'

When in doubt, generalise or decline to answer that specific point and
briefly explain why.
POLICY
  } > "$POLICY_PATH"
  echo "wrote $POLICY_PATH"
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

# Save a personalised reminder in the repo. It contains the token, so it must
# stay out of git (*.local.md is gitignored) and be private to the user.
NOTES_PATH="$ROOT/SETUP_NOTES.local.md"
cat > "$NOTES_PATH" <<NOTES
# agent-link setup notes (peer: $PEER_NAME)

Generated by scripts/setup-machine.sh on $(date '+%Y-%m-%d %H:%M').
This file contains a secret token. It is gitignored, never commit or share it.

## This machine

- Peer name: $PEER_NAME
- Relay URL: $RELAY_URL
- Token: $TOKEN_INPUT

## Register this peer on the relay (once)

\`\`\`bash
heroku config:set PEER_TOKEN_$PEER_UPPER=$TOKEN_INPUT -a <your-heroku-app>
\`\`\`

## Other machines

Run scripts/setup-machine.sh there with a different peer name and a fresh
token. Use the SAME relay URL: $RELAY_URL

## Where to adjust things

- $POLICY_PATH
  Soft rules: instructions the responding agent follows. Free-form text.
- $CONFIG_PATH -> "redact"
  Hard rules: literals/regex patterns cut from every outgoing answer in
  daemon code. A prompt can never bypass these. Common secret formats
  (API keys, tokens, private keys) are always redacted.
- $CONFIG_PATH -> "memory_sources", "responder.model"
  What the responder reads and which model it answers with.
- $MCP_PATH
  The MCP server entry the asking side uses.

## Daemon control

Run from the repo root ($ROOT):

\`\`\`bash
npm run daemon:status
npm run daemon:logs
npm run daemon:restart    # after editing config.json or policy.md
npm run daemon:stop       # peer goes offline
npm run daemon:start      # peer back online
npm run daemon:rebuild    # git pull + npm install + build + restart
npm run daemon:uninstall  # remove the LaunchAgent (keeps ~/.agent-link)
\`\`\`
NOTES
chmod 600 "$NOTES_PATH"

echo
echo "Done. Next steps:"
echo "  1. On the Heroku app (once, from any machine with heroku CLI):"
echo "       heroku config:set PEER_TOKEN_$PEER_UPPER=$TOKEN_INPUT -a <your-heroku-app>"
echo "  2. Run this script on the OTHER machine with a different peer name and a"
echo "     fresh token. Use the SAME relay URL: $RELAY_URL"
echo "  3. Restart Cursor so it picks up the new MCP server."
echo
echo "Where to adjust things later:"
echo "  $POLICY_PATH"
echo "      Soft rules: instructions the responding agent follows. Free-form text."
echo "  $CONFIG_PATH -> \"redact\" section"
echo "      Hard rules: literals/regex patterns cut from every outgoing answer"
echo "      in daemon code. A prompt can never bypass these. Common secret"
echo "      formats (API keys, tokens, private keys) are always redacted."
echo "  $CONFIG_PATH -> \"memory_sources\", \"responder.model\""
echo "      What the responder reads and which model it answers with."
echo "  $MCP_PATH"
echo "      The MCP server entry the asking side uses."
echo "Daemon control (from the repo root):"
echo "  npm run daemon:status     state, pid, last log lines"
echo "  npm run daemon:logs       follow logs"
echo "  npm run daemon:restart    after editing config.json or policy.md"
echo "  npm run daemon:stop       peer goes offline"
echo "  npm run daemon:start      peer back online"
echo "  npm run daemon:rebuild    git pull + npm i + build + restart"
echo
echo "Saved a copy of these notes to $NOTES_PATH (gitignored)."
