#!/usr/bin/env bash
# Test stub for codex. Logs args + CODEX_HOME to FAKE_CODEX_LOG. When invoked as
# `codex exec` (no `resume`), simulates a first turn: writes a rollout file
# under $CODEX_HOME/sessions/YYYY/MM/DD/ so the harness can scrape the session
# id from its filename. Prints STUB ANSWER or FAKE_CODEX_ANSWER.
set -euo pipefail
if [ -n "${FAKE_CODEX_LOG:-}" ]; then
  printf '%s\n' "$@" >> "$FAKE_CODEX_LOG"
  printf 'CODEX_HOME=%s\n' "${CODEX_HOME:-}" >> "$FAKE_CODEX_LOG"
  printf -- '---\n' >> "$FAKE_CODEX_LOG"
fi
if [ "${FAKE_CODEX_MODE:-ok}" = "fail" ]; then
  echo "codex boom" >&2
  exit 2
fi
if [ "${FAKE_CODEX_MODE:-ok}" = "hang" ]; then
  sleep 30
fi
# First turn is `codex exec [flags] PROMPT`. Follow-ups insert `resume` before
# the session id (after parent flags). Scan all args so flag reordering does
# not break first-turn detection.
is_resume=0
for arg in "$@"; do
  if [ "$arg" = "resume" ]; then
    is_resume=1
    break
  fi
done
if [ "${1:-}" = "exec" ] && [ "$is_resume" -eq 0 ]; then
  session_id="${FAKE_CODEX_SESSION_ID:-11111111-2222-3333-4444-555555555555}"
  if [ -n "${CODEX_HOME:-}" ]; then
    dir="$CODEX_HOME/sessions/2026/07/27"
    mkdir -p "$dir"
    printf '{"session":"%s"}\n' "$session_id" > "$dir/rollout-2026-07-27T00-00-00-$session_id.jsonl"
  fi
fi
echo "${FAKE_CODEX_ANSWER:-STUB ANSWER}"
