#!/usr/bin/env bash
# push-clean.sh — Push to remote, stripping local-only checkpoint/safety commits.
#
# Usage:  npm run push
#
# What it does:
#   1. Collects non-checkpoint commits between origin/main and HEAD (in order).
#   2. If none exist → plain `git push` (nothing to strip).
#   3. Otherwise → cherry-picks them onto a temp branch based at origin/main,
#      pushes that branch as origin/main, then resets local main to match remote.

set -euo pipefail

REMOTE="${METAME_PUSH_REMOTE:-origin}"
BRANCH="${METAME_PUSH_BRANCH:-main}"
TEMP_BRANCH="_push-clean-$(date +%s)"

upstream="$REMOTE/$BRANCH"

# ── 1. Fetch so we have an up-to-date upstream ref ────────────────────────────
echo "[push] Fetching $upstream …"
git fetch "$REMOTE" "$BRANCH" --quiet

# ── 2. Collect ALL commits ahead of upstream (oldest first) ──────────────────
all_commits=()
while IFS= read -r sha; do
  [ -n "$sha" ] && all_commits+=("$sha")
done < <(git log --reverse --format="%H" "$upstream"..HEAD 2>/dev/null)

if [ ${#all_commits[@]} -eq 0 ]; then
  echo "[push] Nothing ahead of $upstream — already up to date."
  exit 0
fi

# ── 3. Filter out checkpoint/safety commits ───────────────────────────────────
clean_commits=()
cp_count=0
for sha in "${all_commits[@]}"; do
  subject=$(git log -1 --format="%s" "$sha")
  if echo "$subject" | grep -qE '^\[metame-checkpoint\]|^\[metame-safety\]'; then
    cp_count=$((cp_count + 1))
    echo "[push] Skipping checkpoint: $sha  ${subject:0:60}"
  else
    clean_commits+=("$sha")
  fi
done

if [ ${#clean_commits[@]} -eq 0 ]; then
  echo "[push] Only checkpoint commits ahead — nothing to push."
  exit 0
fi

echo "[push] Pushing ${#clean_commits[@]} commit(s) (skipping $cp_count checkpoint(s)) …"

# ── 4. Cherry-pick onto a temp branch at upstream ────────────────────────────
git checkout -q -b "$TEMP_BRANCH" "$upstream"

for sha in "${clean_commits[@]}"; do
  subject=$(git log -1 --format="%s" "$sha")
  echo "[push]   cherry-pick $sha  ${subject:0:60}"
  git cherry-pick --allow-empty --keep-redundant-commits "$sha" --quiet
done

# ── 5. Push temp branch → remote main ────────────────────────────────────────
git push "$REMOTE" "$TEMP_BRANCH:$BRANCH"

# ── 6. Reset local main to match remote (fast-forward) ───────────────────────
git checkout -q "$BRANCH"
git reset --hard "$REMOTE/$BRANCH"
git branch -D "$TEMP_BRANCH"

echo "[push] Done. Local $BRANCH is now aligned with $REMOTE/$BRANCH."
