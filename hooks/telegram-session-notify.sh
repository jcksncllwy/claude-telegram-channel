#!/bin/bash
# telegram-session-notify.sh — Write active session metadata for the Telegram plugin.
# Used by both SessionStart and SessionEnd hooks.
# SessionStart: writes session info so the plugin can tail the JSONL.
# SessionEnd: clears the file so the plugin stops tailing.

if ! command -v jq &>/dev/null; then
  echo "telegram-session-notify: jq is required but not installed" >&2
  exit 1
fi

ACTIVE_FILE="$HOME/.claude/channels/telegram/active-session.json"

INPUT=$(cat)
EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // empty')

if [ "$EVENT" = "SessionStart" ]; then
  SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
  TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // empty')
  CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
  MODEL=$(echo "$INPUT" | jq -r '.model // empty')

  mkdir -p "$(dirname "$ACTIVE_FILE")"
  cat > "$ACTIVE_FILE" <<EOF
{
  "session_id": "$SESSION_ID",
  "transcript_path": "$TRANSCRIPT",
  "cwd": "$CWD",
  "model": "$MODEL",
  "started_at": $(date +%s)000
}
EOF

elif [ "$EVENT" = "SessionEnd" ]; then
  rm -f "$ACTIVE_FILE"
fi

exit 0
