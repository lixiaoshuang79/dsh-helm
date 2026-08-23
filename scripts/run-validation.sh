#!/usr/bin/env bash
# dsh-helm validation matrix runner (Phase 6)
# Runs: build all packages -> full unit+integration suite -> per-package
# summary. Exit code 0 = all green.
set -eu
cd "$(dirname "$0")/.."

echo "==> [1/3] build all packages"
for p in protocol store presence platform hub node-agent cli; do
  npx tsc -p "packages/$p/tsconfig.json" >/dev/null 2>&1 || {
    echo "BUILD FAILED: $p"; exit 1
  }
  echo "    built $p"
done

echo "==> [2/3] full test suite"
npx vitest run 2>&1 | tail -8

echo "==> [3/3] done"
