#!/usr/bin/env bash
# Sync sanitized code from private repo to the public MetaMe repo.
#
# Usage:
#   ./scripts/publish-public.sh              # generate to ../MetaMe-public
#   ./scripts/publish-public.sh --push       # generate + push to public repo
#
# Workflow:
#   - You develop in MetaMe-private (this repo), push to origin as usual
#   - Run this script when you want to update the public mirror
#   - Private modules (listed in .private-modules) get replaced with stubs

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

if [ ! -f "$PRIVATE_LIST" ]; then
  echo "Error: .private-modules not found"
  exit 1
fi

PRIVATE_FILES=()
while IFS= read -r line; do
  line="${line%%#*}"
  line="${line// /}"
  [ -z "$line" ] && continue
  PRIVATE_FILES+=("$line")
done < "$PRIVATE_LIST"

echo "==> Generating public release to: $OUT_DIR"
echo "    Stripping ${#PRIVATE_FILES[@]} private modules"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

git -C "$REPO_ROOT" archive HEAD | tar -x -C "$OUT_DIR"

# Strip .private-modules itself from public release
rm -f "$OUT_DIR/.private-modules"

for pattern in "${PRIVATE_FILES[@]}"; do
  for file in $OUT_DIR/$pattern; do
    [ -f "$file" ] || continue
    rel="${file#$OUT_DIR/}"
    basename=$(basename "$file" .js)
    cat > "$file" << STUB
// This module is part of MetaMe's proprietary core.
// See https://github.com/Yaron9/MetaMe for the open-source components.
//
// Module: ${basename}
// License: Business Source License (BSL 1.1)
//
// For licensing inquiries: github.com/Yaron9/MetaMe/issues

module.exports = {};
STUB
    echo "    [stub] $rel"
  done
done

echo "==> Done. ${#PRIVATE_FILES[@]} modules stubbed."

if [ "$DO_PUSH" = true ]; then
  cd "$OUT_DIR"
  if [ ! -d .git ]; then
    git init -b main
    git remote add origin "$PUBLIC_REMOTE"
  fi
  git add -A
  COMMIT_MSG="sync: $(git -C "$REPO_ROOT" log -1 --format='%h %s')"
  git commit -m "$COMMIT_MSG" --allow-empty
  echo "==> Pushing to public repo..."
  git push -u origin main --force
  echo "==> Public repo updated."
fi
