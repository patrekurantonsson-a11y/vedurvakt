#!/bin/bash
# Installs Veðurvakt as a background agent that starts at login and keeps running.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/vedurvakt.py"
LABEL="is.vedurvakt.agent"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PY="$(command -v python3)"
LOGDIR="$HOME/.vedurvakt"

if [ ! -f "$SCRIPT" ]; then
  echo "vedurvakt.py not found next to this installer."
  exit 1
fi

mkdir -p "$LOGDIR" "$HOME/Library/LaunchAgents"

echo "Filling the database with a first observation snapshot..."
"$PY" "$SCRIPT" collect

cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PY</string>
    <string>$SCRIPT</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOGDIR/vedurvakt.log</string>
  <key>StandardErrorPath</key><string>$LOGDIR/vedurvakt.log</string>
  <key>WorkingDirectory</key><string>$HERE</string>
</dict>
</plist>
PLISTEOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo
echo "Veðurvakt is running."
echo "  Dashboard: http://localhost:8787"
echo "  Log:       $LOGDIR/vedurvakt.log"
echo "  Database:  $LOGDIR/vedurvakt.db"
echo
echo "To stop it:   launchctl unload $PLIST"
sleep 3
open "http://localhost:8787" 2>/dev/null || true
