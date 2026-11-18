#!/bin/zsh
# Starts Flow Credits and opens the dashboard.
cd "$(dirname "$0")"

PORT=3847
LABEL=com.flowcredits.tracker
AGENT="$HOME/Library/LaunchAgents/$LABEL.plist"

if lsof -i tcp:$PORT -sTCP:LISTEN -t >/dev/null 2>&1 ; then
  echo "Flow Credits is already running."
  open "http://localhost:$PORT"
  exit 0
fi

if [[ -f "$AGENT" ]]; then
  # "Start at login" is on: run in the background via launchd (no Terminal window needed).
  launchctl bootstrap gui/$(id -u) "$AGENT" 2>/dev/null || launchctl kickstart gui/$(id -u)/$LABEL
  for i in {1..20}; do lsof -i tcp:$PORT -sTCP:LISTEN -t >/dev/null 2>&1 && break; sleep 0.25; done
  echo "Flow Credits started in the background."
  open "http://localhost:$PORT"
  exit 0
fi

echo "Starting Flow Credits on http://localhost:$PORT (keep this window open) ..."
(sleep 1 && open "http://localhost:$PORT") &
node server.js
