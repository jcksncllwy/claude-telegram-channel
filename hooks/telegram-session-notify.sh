#!/bin/bash
# telegram-session-notify.sh — Write active session metadata for the Telegram plugin.
# Used by both SessionStart and SessionEnd hooks.
# SessionStart: writes session info so the plugin can tail the JSONL.
# SessionEnd: clears the file so the plugin stops tailing.

ACTIVE_FILE="$HOME/.claude/channels/telegram/active-session.json"

INPUT=$(cat)
EVENT=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('hook_event_name',''))" 2>/dev/null)

if [ "$EVENT" = "SessionStart" ]; then
  SESSION_ID=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null)
  TRANSCRIPT=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('transcript_path',''))" 2>/dev/null)
  CWD=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('cwd',''))" 2>/dev/null)
  MODEL=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('model',''))" 2>/dev/null)

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
