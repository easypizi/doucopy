#!/usr/bin/env bash
# Test stub for cursor-agent. Logs args, answers a fixed string.
if [ -n "${FAKE_AGENT_LOG:-}" ]; then
  printf 'cwd=%s\n' "$PWD" >> "$FAKE_AGENT_LOG"
  printf '%s\n' "$@" >> "$FAKE_AGENT_LOG"
fi
if [ "${FAKE_AGENT_MODE:-ok}" = "empty" ]; then
  exit 0
fi
if [ "$1" = "create-chat" ]; then
  if [ "${FAKE_AGENT_MODE:-ok}" = "empty" ]; then
    exit 0
  fi
  echo "chat-123"
  if [ "${FAKE_AGENT_MODE:-ok}" = "create-chat-hang" ]; then
    sleep 30
  fi
  exit 0
fi
if [ "${FAKE_AGENT_MODE:-ok}" = "fail" ]; then
  echo "boom" >&2
  exit 1
fi
if [ "${FAKE_AGENT_MODE:-ok}" = "hang" ]; then
  sleep 30
fi
if [ "${FAKE_AGENT_MODE:-ok}" = "grandchild-hang" ]; then
  # Print the answer, leave a background child holding the stdio pipes, exit.
  # Mimics cursor-agent builds whose helper processes outlive the main one.
  echo "${FAKE_AGENT_ANSWER:-STUB ANSWER}"
  sleep 30 &
  exit 0
fi
echo "${FAKE_AGENT_ANSWER:-STUB ANSWER}"
