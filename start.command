#!/bin/zsh
cd "$(dirname "$0")"

if command -v node >/dev/null 2>&1; then
  exec node src/server.js
fi

CODEX_NODE="/Applications/Codex.app/Contents/Resources/node"
if [ -x "$CODEX_NODE" ]; then
  exec "$CODEX_NODE" src/server.js
fi

echo "Node.js was not found."
echo "Install it with: brew install node"
read -k 1 "?Press any key to close..."
