#!/usr/bin/env bash
# Test stub for codex. Logs args to FAKE_CODEX_LOG, prints STUB ANSWER.
if [ -n "${FAKE_CODEX_LOG:-}" ]; then
  printf '%s\n' "$@" >> "$FAKE_CODEX_LOG"
  printf 'CODEX_SESSION_ID=%s\n' "${CODEX_SESSION_ID:-}" >> "$FAKE_CODEX_LOG"
fi
if [ "${FAKE_CODEX_MODE:-ok}" = "fail" ]; then
  echo "codex boom" >&2
  exit 2
fi
if [ "${FAKE_CODEX_MODE:-ok}" = "hang" ]; then
  sleep 30
fi
echo "${FAKE_CODEX_ANSWER:-STUB ANSWER}"
