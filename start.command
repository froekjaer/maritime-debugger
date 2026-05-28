#!/bin/zsh
cd "$(dirname "$0")"

URL="http://localhost:${PORT:-8787}"

if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
elif [ -x "/Applications/Codex.app/Contents/Resources/node" ]; then
  NODE_BIN="/Applications/Codex.app/Contents/Resources/node"
else
  echo "Node.js was not found."
  echo "Install it with: brew install node"
  read -k 1 "?Press any key to close..."
  exit 1
fi

if lsof -iTCP:${PORT:-8787} -sTCP:LISTEN -n -P >/dev/null 2>&1; then
  echo "Maritime Debugger is already running on $URL"
  open "$URL"
  exit 0
fi

"$NODE_BIN" src/server.js &
SERVER_PID=$!

sleep 1
open "$URL"
wait "$SERVER_PID"
