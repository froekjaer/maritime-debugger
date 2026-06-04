#!/bin/zsh
set -euo pipefail

cd "$(dirname "$0")"

REMOTE="${REMOTE:-origin}"
current_branch="$(git rev-parse --abbrev-ref HEAD)"
BRANCH="${1:-$current_branch}"

if [[ -z "$BRANCH" || "$BRANCH" == "HEAD" ]]; then
  echo "Could not determine the current Git branch."
  echo "Run: ./update-from-github.command main"
  exit 1
fi

echo "Maritime Debugger updater"
echo "Repository: $(pwd)"
echo "Remote:     $REMOTE"
echo "Branch:     $BRANCH"
echo

find .git -name $'Icon\r' -type f -delete 2>/dev/null || true

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "Local tracked files have changes. Commit or stash them before updating."
  echo
  git status --short
  exit 1
fi

echo "Fetching from GitHub..."
git fetch "$REMOTE"

if ! git show-ref --verify --quiet "refs/remotes/$REMOTE/$BRANCH"; then
  echo "GitHub branch '$REMOTE/$BRANCH' was not found."
  echo
  echo "Available remote branches:"
  git branch -r
  exit 1
fi

if [[ "$current_branch" != "$BRANCH" ]]; then
  if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
    echo "Switching to local branch '$BRANCH'..."
    git checkout "$BRANCH"
  else
    echo "Creating local branch '$BRANCH' from '$REMOTE/$BRANCH'..."
    git checkout -b "$BRANCH" "$REMOTE/$BRANCH"
  fi
fi

echo "Updating '$BRANCH'..."
git pull --ff-only "$REMOTE" "$BRANCH"

echo
echo "Done. You are now on the latest '$BRANCH' from GitHub."
