#!/usr/bin/env bash
# Test stub for claude. Logs args to FAKE_CLAUDE_LOG, prints STUB ANSWER.
if [ -n "${FAKE_CLAUDE_LOG:-}" ]; then
  printf '%s\n' "$@" >> "$FAKE_CLAUDE_LOG"
fi
if [ "${FAKE_CLAUDE_MODE:-ok}" = "fail" ]; then
  echo "claude boom" >&2
  exit 2
fi
if [ "${FAKE_CLAUDE_MODE:-ok}" = "hang" ]; then
  sleep 30
fi
echo "${FAKE_CLAUDE_ANSWER:-STUB ANSWER}"
