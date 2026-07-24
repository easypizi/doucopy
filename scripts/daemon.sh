#!/usr/bin/env bash
set -euo pipefail

# One entry-point for controlling the agent-link responder daemon on macOS.
# Invoked via npm scripts (npm run daemon:<action>).

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.agent-link.responder"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_OUT="$HOME/.agent-link/responder.log"
LOG_ERR="$HOME/.agent-link/responder.err.log"

usage() {
  cat <<EOF
Usage: scripts/daemon.sh <action>

Actions:
  install     interactive machine setup (delegates to scripts/setup-machine.sh)
  start       load the LaunchAgent
  stop        unload the LaunchAgent (peer goes offline)
  restart     kickstart the running LaunchAgent (picks up new dist/ after build)
  status      show state, pid and tail of both logs
  logs        follow stdout/stderr logs (Ctrl+C to exit)
  rebuild     git pull, npm install, build daemon, restart
  uninstall   unload and delete the plist (config stays)

Meant to be called via npm scripts: npm run daemon:start etc.
EOF
}

require_plist() {
  if [ ! -f "$PLIST_DST" ]; then
    echo "LaunchAgent not installed at $PLIST_DST" >&2
    echo "Run: npm run daemon:install" >&2
    exit 1
  fi
}

cmd_install() {
  exec "$ROOT/scripts/setup-machine.sh" "$@"
}

cmd_start() {
  require_plist
  launchctl load "$PLIST_DST"
  echo "loaded $LABEL"
}

cmd_stop() {
  require_plist
  launchctl unload "$PLIST_DST" 2>/dev/null || true
  echo "unloaded $LABEL (peer offline)"
}

cmd_restart() {
  require_plist
  launchctl kickstart -k "gui/$(id -u)/$LABEL"
  echo "restarted $LABEL"
}

cmd_status() {
  if ! launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
    echo "not loaded"
    return 0
  fi
  launchctl print "gui/$(id -u)/$LABEL" | grep -E "^\s*(state|pid|last exit code)" || true
  echo
  if [ -s "$LOG_OUT" ]; then
    echo "--- last 5 stdout lines ($LOG_OUT) ---"
    tail -5 "$LOG_OUT"
  fi
  if [ -s "$LOG_ERR" ]; then
    echo "--- last 5 stderr lines ($LOG_ERR) ---"
    tail -5 "$LOG_ERR"
  fi
}

cmd_logs() {
  local files=()
  [ -f "$LOG_OUT" ] && files+=("$LOG_OUT")
  [ -f "$LOG_ERR" ] && files+=("$LOG_ERR")
  if [ "${#files[@]}" -eq 0 ]; then
    echo "no log files yet at $LOG_OUT or $LOG_ERR" >&2
    exit 1
  fi
  exec tail -F "${files[@]}"
}

cmd_rebuild() {
  cd "$ROOT"
  git pull --ff-only
  npm install --silent
  npm run build --silent -w daemon
  if [ -f "$PLIST_DST" ] && launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
    launchctl kickstart -k "gui/$(id -u)/$LABEL"
    echo "rebuilt and restarted $LABEL"
  else
    echo "rebuilt (LaunchAgent not loaded, run: npm run daemon:start)"
  fi
}

cmd_uninstall() {
  if [ -f "$PLIST_DST" ]; then
    launchctl unload "$PLIST_DST" 2>/dev/null || true
    rm "$PLIST_DST"
    echo "removed $PLIST_DST"
  else
    echo "no LaunchAgent at $PLIST_DST"
  fi
  echo "kept ~/.agent-link/ (config, policy, logs)"
}

if [ "$#" -lt 1 ]; then
  usage
  exit 2
fi

action="$1"
shift || true
case "$action" in
  install)   cmd_install "$@" ;;
  start)     cmd_start ;;
  stop)      cmd_stop ;;
  restart)   cmd_restart ;;
  status)    cmd_status ;;
  logs)      cmd_logs ;;
  rebuild)   cmd_rebuild ;;
  uninstall) cmd_uninstall ;;
  -h|--help) usage ;;
  *) echo "unknown action: $action" >&2; usage; exit 2 ;;
esac
