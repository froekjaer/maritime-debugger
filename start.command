#!/bin/zsh
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found."
  echo "Install Node.js, then run this script again."
  exit 1
fi

PORT="${PORT:-8787}"
export PORT

echo "Starting Maritime Debugger..."
echo "Open http://localhost:$PORT"
echo

node src/server.js
