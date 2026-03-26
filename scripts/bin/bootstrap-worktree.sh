#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required" >&2
  exit 1
fi

if [[ -f package-lock.json ]]; then
  echo "Using npm ci in $(pwd)"
  npm ci --no-audit --no-fund
else
  echo "package-lock.json missing, using npm install in $(pwd)"
  npm install --no-audit --no-fund
fi

node -e "require('js-yaml'); require('./scripts/resolve-yaml'); console.log('bootstrap-ok')"
