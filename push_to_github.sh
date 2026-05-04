#!/bin/bash
# ══════════════════════════════════════════════════════════════════════════════
# push_to_github.sh — Deploy local changes to GitHub Pages
#
# Assumes the folder is a git working copy (run init_repo.sh once if not).
# Replaces the old "clone fresh every push" approach with a working-copy
# workflow that's faster and surfaces problems before they ship.
#
# Pre-push gates (in order — first failure aborts):
#   1. Is this a git repo? If not, point at init_repo.sh and stop.
#   2. Is the local branch behind origin/main? If yes, pull first.
#   3. Do all .js files pass `node --check`?
#   4. Does `node game-tests.js` pass all tests?
#   5. Show diff stat — what's actually about to ship.
#
# Then: commit + push. Token is injected at push time, never stored on disk.
#
# Usage:
#   ./push_to_github.sh                       # commit message defaults to "Update"
#   ./push_to_github.sh "fix Nidoran dup bug" # custom commit message
# ══════════════════════════════════════════════════════════════════════════════

set -e
cd "$(dirname "$0")"

# ── 1. Check this is a git repo ───────────────────────────────────────────────
if [[ ! -d ".git" ]]; then
  echo "❌ This folder isn't a git repo yet."
  echo "   Run ./init_repo.sh once to set it up, then come back here."
  exit 1
fi

# ── 2. Token resolution ───────────────────────────────────────────────────────
TOKEN="${GITHUB_PAT:-$(cat ~/.p-tcg-token 2>/dev/null)}"
if [[ -z "$TOKEN" ]]; then
  echo "❌ No GitHub token found."
  echo "   Set GITHUB_PAT env var, or put token in ~/.p-tcg-token"
  exit 1
fi

REMOTE_URL_WITH_TOKEN="https://${TOKEN}@github.com/ckierce/p-tcg.git"

# ── 3. Check local is in sync with remote ─────────────────────────────────────
echo "→ Fetching latest from GitHub..."
git fetch "$REMOTE_URL_WITH_TOKEN" main:refs/remotes/origin/main 2>&1 \
  | grep -v "^From " || true

LOCAL=$(git rev-parse HEAD 2>/dev/null || echo "EMPTY")
REMOTE=$(git rev-parse origin/main 2>/dev/null || echo "EMPTY")
BASE=$(git merge-base HEAD origin/main 2>/dev/null || echo "EMPTY")

if [[ "$LOCAL" == "EMPTY" ]] || [[ "$REMOTE" == "EMPTY" ]]; then
  echo "❌ Couldn't resolve local/remote HEAD. Is the repo healthy?"
  exit 1
fi

if [[ "$LOCAL" == "$REMOTE" ]]; then
  : # in sync — proceed
elif [[ "$LOCAL" == "$BASE" ]]; then
  # Local is behind remote — would lose remote work if we pushed
  echo "❌ Local branch is BEHIND origin/main."
  echo "   Someone (probably you, via the GitHub web editor) committed"
  echo "   changes that aren't in your local copy."
  echo ""
  echo "   Run ./pull_from_github.sh first, then re-run this script."
  exit 1
elif [[ "$REMOTE" == "$BASE" ]]; then
  : # local is ahead — that's exactly what push is for, proceed
else
  # Diverged
  echo "❌ Local and remote have DIVERGED — both have commits the other lacks."
  echo "   This shouldn't happen in normal use. Resolve manually with git."
  exit 1
fi

# ── 4. Syntax-check every .js file ────────────────────────────────────────────
echo "→ Syntax-checking JS files..."
for f in *.js; do
  if [[ -f "$f" ]]; then
    node --check "$f" || { echo "❌ Syntax error in $f — aborting push"; exit 1; }
  fi
done

# ── 5. Run regression tests ───────────────────────────────────────────────────
echo "→ Running tests..."
node game-tests.js || { echo "❌ Tests failed — aborting push"; exit 1; }

# ── 6. Stage everything and show what's about to ship ─────────────────────────
git add -A

# Bail early if there's nothing to commit (avoids empty-commit confusion)
if git diff --cached --quiet; then
  echo "✓ No changes to push — everything is already on GitHub."
  exit 0
fi

echo ""
echo "── About to push these changes ───────────────────────────────────────────"
git diff --cached --stat
echo ""

# ── 7. Commit + push ──────────────────────────────────────────────────────────
git commit -m "${1:-Update}"
git push "$REMOTE_URL_WITH_TOKEN" main

echo ""
echo "✅ Pushed successfully."
