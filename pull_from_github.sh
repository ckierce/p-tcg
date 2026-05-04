#!/bin/bash
# ══════════════════════════════════════════════════════════════════════════════
# pull_from_github.sh — Sync remote changes down to local working copy
#
# Use this when:
#   • You started a session, but you (or someone) made commits via the
#     GitHub web editor since your last push.
#   • push_to_github.sh refused to push because local is behind origin/main.
#   • You want to start a fresh session from the current deployed state.
#
# What it does:
#   1. Verifies the folder is a git repo.
#   2. Checks for uncommitted local changes — if found, refuses to pull
#      (would clobber your edits) and tells you what to do.
#   3. Fetches and fast-forwards origin/main into the local branch.
#   4. Reports what changed so you know what's now in your folder.
#
# Token is injected at fetch time, never stored on disk.
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

# ── 3. Refuse to pull if there are uncommitted local changes ──────────────────
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "❌ You have uncommitted local changes. Pulling now would risk"
  echo "   conflicts or accidentally overwriting your edits."
  echo ""
  echo "   Files with changes:"
  git status --short | sed 's/^/     /'
  echo ""
  echo "   Either:"
  echo "     • Push your changes first: ./push_to_github.sh \"message\""
  echo "     • Or stash them:           git stash"
  echo "     • Or discard them:         git checkout -- ."
  exit 1
fi

# ── 4. Fetch and check what's incoming ────────────────────────────────────────
echo "→ Fetching latest from GitHub..."
git fetch "$REMOTE_URL_WITH_TOKEN" main:refs/remotes/origin/main 2>&1 \
  | grep -v "^From " || true

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
BASE=$(git merge-base HEAD origin/main)

if [[ "$LOCAL" == "$REMOTE" ]]; then
  echo "✓ Already up to date with origin/main."
  exit 0
fi

if [[ "$LOCAL" != "$BASE" ]]; then
  echo "❌ Local has commits that aren't on origin/main — can't fast-forward."
  echo "   Push first, or resolve manually with git."
  exit 1
fi

# ── 5. Show what's about to come in ───────────────────────────────────────────
echo ""
echo "── Incoming changes ──────────────────────────────────────────────────────"
git log --oneline "$LOCAL..$REMOTE"
echo ""
echo "── Files affected ────────────────────────────────────────────────────────"
git diff --stat "$LOCAL..$REMOTE"
echo ""

# ── 6. Fast-forward ───────────────────────────────────────────────────────────
echo "→ Fast-forwarding local to origin/main..."
git merge --ff-only origin/main

echo ""
echo "✅ Synced. Local is now at $(git rev-parse --short HEAD)."
