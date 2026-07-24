#!/usr/bin/env bash
# Test stub for cursor-agent. Logs args, answers a fixed string.
if [ "${FAKE_AGENT_MODE:-ok}" = "empty" ]; then
  exit 0
fi
if [ "$1" = "create-chat" ]; then
  echo "chat-123"
  exit 0
fi
if [ -n "${FAKE_AGENT_LOG:-}" ]; then
  printf '%s\n' "$@" >> "$FAKE_AGENT_LOG"
fi
if [ "${FAKE_AGENT_MODE:-ok}" = "fail" ]; then
  echo "boom" >&2
  exit 1
fi
if [ "${FAKE_AGENT_MODE:-ok}" = "hang" ]; then
  sleep 30
fi
echo "STUB ANSWER"
