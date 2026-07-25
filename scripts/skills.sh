#!/usr/bin/env bash
set -euo pipefail

# Install the global agent-link skills (ask, answer) into ~/.cursor/skills/
# as symlinks to the versions in this repo. Idempotent.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="$ROOT/.cursor/skills"
DST_DIR="$HOME/.cursor/skills"

GLOBAL_SKILLS=(agent-link-ask agent-link-answer)

usage() {
  cat <<EOF
Usage: scripts/skills.sh <action>

Actions:
  install     symlink global agent-link skills into ~/.cursor/skills/
  uninstall   remove those symlinks (only if they point at this repo)
  status      show what is installed
EOF
}

cmd_install() {
  mkdir -p "$DST_DIR"
  for skill in "${GLOBAL_SKILLS[@]}"; do
    local src="$SRC_DIR/$skill"
    local dst="$DST_DIR/$skill"
    if [ ! -d "$src" ]; then
      echo "missing source: $src" >&2
      exit 1
    fi
    if [ -L "$dst" ]; then
      local current
      current="$(readlink "$dst")"
      if [ "$current" = "$src" ]; then
        echo "ok: $skill already linked"
        continue
      fi
      echo "replace: $skill was pointing at $current"
      rm "$dst"
    elif [ -e "$dst" ]; then
      echo "refuse: $dst exists and is not a symlink, move it aside first" >&2
      exit 1
    fi
    ln -s "$src" "$dst"
    echo "linked: $skill -> $src"
  done
}

cmd_uninstall() {
  for skill in "${GLOBAL_SKILLS[@]}"; do
    local dst="$DST_DIR/$skill"
    if [ ! -L "$dst" ]; then
      if [ -e "$dst" ]; then
        echo "skip: $dst is not a symlink, leaving alone"
      else
        echo "skip: $skill not installed"
      fi
      continue
    fi
    local current
    current="$(readlink "$dst")"
    case "$current" in
      "$SRC_DIR/"*)
        rm "$dst"
        echo "removed: $skill"
        ;;
      *)
        echo "skip: $dst points at $current, not this repo"
        ;;
    esac
  done
}

cmd_status() {
  for skill in "${GLOBAL_SKILLS[@]}"; do
    local dst="$DST_DIR/$skill"
    if [ -L "$dst" ]; then
      printf "%-24s -> %s\n" "$skill" "$(readlink "$dst")"
    elif [ -e "$dst" ]; then
      printf "%-24s (real dir, not a symlink)\n" "$skill"
    else
      printf "%-24s (not installed)\n" "$skill"
    fi
  done
}

action="${1:-}"
case "$action" in
  install) cmd_install ;;
  uninstall) cmd_uninstall ;;
  status) cmd_status ;;
  ""|-h|--help) usage ;;
  *) usage; exit 2 ;;
esac
