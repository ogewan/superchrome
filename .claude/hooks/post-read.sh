#!/usr/bin/env bash
# PostToolUse(Read) — track when ARCHITECTURE.md and CURRENT.md are read.
# Once both are read on the same calendar day, stamps .claude/state/.session-init
# so the pre-edit hook lets edits through for the rest of the session.

TODAY=$(date +%Y-%m-%d)
mkdir -p .claude/state

FILE=$(python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(data.get('tool_input', {}).get('file_path', ''))
except:
    print('')
")

case "$FILE" in
  *ARCHITECTURE.md) echo "$TODAY" > .claude/state/.arch-read ;;
  *CURRENT.md)      echo "$TODAY" > .claude/state/.curr-read ;;
esac

ARCH=$(cat .claude/state/.arch-read 2>/dev/null || true)
CURR=$(cat .claude/state/.curr-read 2>/dev/null || true)
[ "$ARCH" = "$TODAY" ] && [ "$CURR" = "$TODAY" ] && echo "$TODAY" > .claude/state/.session-init

exit 0
