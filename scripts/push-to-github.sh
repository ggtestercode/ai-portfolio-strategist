#!/usr/bin/env bash
set -e

GITHUB_USERNAME="ggtestercode"
REPO_NAME="ai-portfolio-strategist"

if [ -z "$GITHUB_PERSONAL_ACCESS_TOKEN" ]; then
  echo "ERROR: GITHUB_PERSONAL_ACCESS_TOKEN secret is not set."
  exit 1
fi

REMOTE_URL="https://${GITHUB_USERNAME}:${GITHUB_PERSONAL_ACCESS_TOKEN}@github.com/${GITHUB_USERNAME}/${REPO_NAME}.git"

git remote remove github 2>/dev/null || true
git remote add github "$REMOTE_URL"

git push github main --force

echo ""
echo "Done! View your repo at: https://github.com/${GITHUB_USERNAME}/${REPO_NAME}"
