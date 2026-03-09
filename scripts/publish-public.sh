#!/usr/bin/env bash
# Sync code from private repo to the public MetaMe repo.
#
# Usage:
#   ./scripts/publish-public.sh              # dry-run: generate to ../MetaMe-public
#   ./scripts/publish-public.sh --push       # generate + push to public repo
#
# Files listed in .private-modules are excluded entirely (secrets, tokens, etc).
# Everything else is published as-is (full open source).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PRIVATE_LIST="$REPO_ROOT/.private-modules"
OUT_DIR="$REPO_ROOT/../MetaMe-public"
PUBLIC_REMOTE="git@github.com:Yaron9/MetaMe.git"

DO_PUSH=false
for arg in "$@"; do
  case "$arg" in
    --push) DO_PUSH=true ;;
  esac
done

# Read exclusion list
EXCLUDE_FILES=()
if [ -f "$PRIVATE_LIST" ]; then
  while IFS= read -r line; do
    line="${line%%#*}"
    line="${line// /}"
    [ -z "$line" ] && continue
    EXCLUDE_FILES+=("$line")
  done < "$PRIVATE_LIST"
fi

echo "==> Generating public release to: $OUT_DIR"
echo "    Excluding ${#EXCLUDE_FILES[@]} private files"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

# Export all tracked files
git -C "$REPO_ROOT" archive HEAD | tar -x -C "$OUT_DIR"

# Remove .private-modules list itself
rm -f "$OUT_DIR/.private-modules"

# Remove excluded files (secrets, tokens, config with credentials)
REMOVED=0
for pattern in "${EXCLUDE_FILES[@]}"; do
  for file in $OUT_DIR/$pattern; do
    [ -f "$file" ] || continue
    rel="${file#$OUT_DIR/}"
    rm -f "$file"
    echo "    [excluded] $rel"
    REMOVED=$((REMOVED + 1))
  done
done

echo "==> Done. ${REMOVED} private files excluded."

if [ "$DO_PUSH" = true ]; then
  cd "$OUT_DIR"
  if [ ! -d .git ]; then
    git init -b main
    git remote add origin "$PUBLIC_REMOTE"
  fi
  git add -A
  COMMIT_MSG="sync: $(git -C "$REPO_ROOT" log -1 --format='%h') $(date -u +%Y-%m-%d)"
  git commit -m "$COMMIT_MSG" --allow-empty
  echo "==> Pushing to public repo..."
  git push -u origin main --force
  echo "==> Public repo updated."
fi
