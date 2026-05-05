#!/usr/bin/env bash
# PreToolUse(Edit|Write) — block edits until both ARCHITECTURE.md and CURRENT.md
# have been read in this session (same calendar day).
# The post-read hook stamps .claude/state/.session-init automatically once both are read.

TODAY=$(date +%Y-%m-%d)
INIT=$(cat .claude/state/.session-init 2>/dev/null || true)

if [ "$INIT" != "$TODAY" ]; then
  echo "Read ARCHITECTURE.md and CURRENT.md before editing (CLAUDE.md project rule). The session flag is set automatically once both are read."
  exit 2
fi
