#!/bin/bash
# ══════════════════════════════════════════════════════════════════════════════
# init_repo.sh — ONE-TIME SETUP
#
# Converts your plain ~/documents/projects/tcg folder into a proper git
# working copy linked to github.com/ckierce/p-tcg. After this runs, your
# local folder behaves like a normal git repo: `git status`, `git diff`,
# `git log`, etc. all work, and push/pull operate on the working copy
# instead of cloning fresh every time.
#
# RUN THIS ONCE. Then never run it again.
#
# What it does:
#   1. Verifies you're in the tcg folder and it's NOT already a git repo
#   2. Backs up your current files to ../tcg-backup-YYYYMMDD/ (safety net)
#   3. Clones the GitHub repo into a sibling tmp dir
#   4. Moves the .git directory from tmp into your tcg folder
#   5. Runs `git status` so you can see what differs from GitHub
#
# At the end, your folder is a working copy with your local edits showing
# up as uncommitted changes. From there, push_to_github.sh handles deploys
# and pull_from_github.sh handles syncing remote changes down.
# ══════════════════════════════════════════════════════════════════════════════

set -e

cd "$(dirname "$0")"
SCRIPT_DIR="$(pwd)"
FOLDER_NAME="$(basename "$SCRIPT_DIR")"

# ── Sanity checks ─────────────────────────────────────────────────────────────
if [[ -d ".git" ]]; then
  echo "❌ This folder is already a git repo. init_repo.sh is for first-time"
  echo "   setup only. If something's wrong with the existing .git, delete it"
  echo "   manually first (rm -rf .git) and re-run."
  exit 1
fi

if [[ ! -f "pokemon-game.html" ]] || [[ ! -f "push_to_github.sh" ]]; then
  echo "❌ Doesn't look like the tcg folder — pokemon-game.html or"
  echo "   push_to_github.sh is missing. Run this from inside the project."
  exit 1
fi

# ── Token resolution (same pattern as push script) ────────────────────────────
TOKEN="${GITHUB_PAT:-$(cat ~/.p-tcg-token 2>/dev/null)}"
if [[ -z "$TOKEN" ]]; then
  echo "❌ No GitHub token found."
  echo "   Set GITHUB_PAT env var, or put token in ~/.p-tcg-token"
  exit 1
fi

REPO="https://${TOKEN}@github.com/ckierce/p-tcg.git"

# ── Backup the current folder ─────────────────────────────────────────────────
BACKUP_DIR="../${FOLDER_NAME}-backup-$(date +%Y%m%d-%H%M%S)"
echo "→ Backing up current folder to $BACKUP_DIR"
cp -R "$SCRIPT_DIR" "$BACKUP_DIR"
echo "  ✓ Backup created. If anything goes wrong, your files are at:"
echo "    $BACKUP_DIR"

# ── Clone repo to tmp, move .git into our folder ──────────────────────────────
TMPDIR=$(mktemp -d)
echo "→ Cloning repo to temporary location..."
git clone "$REPO" "$TMPDIR/clone"

echo "→ Linking your folder to the GitHub repo..."
mv "$TMPDIR/clone/.git" "$SCRIPT_DIR/.git"
rm -rf "$TMPDIR"

# ── Strip the token out of the remote URL so it's not stored in .git/config ──
# (push/pull scripts inject the token at runtime; storing it on disk is risky)
cd "$SCRIPT_DIR"
git remote set-url origin "https://github.com/ckierce/p-tcg.git"

# ── Configure local git identity ──────────────────────────────────────────────
git config user.email "deploy@p-tcg"
git config user.name  "p-tcg deploy"

# ── Show the diff ─────────────────────────────────────────────────────────────
echo ""
echo "✅ Done. Your folder is now a git working copy."
echo ""
echo "── Files that differ from GitHub ─────────────────────────────────────────"
git status --short
echo ""
echo "── What to do next ───────────────────────────────────────────────────────"
echo "  • Review the diff above. These are your local changes."
echo "  • If they look right, run: ./push_to_github.sh \"first push from new workflow\""
echo "  • If something looks wrong, your backup is at: $BACKUP_DIR"
echo "  • From now on, use push_to_github.sh and pull_from_github.sh."
echo "  • DO NOT run init_repo.sh again — it'll refuse anyway."
