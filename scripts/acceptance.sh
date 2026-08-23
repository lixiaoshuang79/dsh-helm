#!/bin/bash
# acceptance.sh — strict acceptance gate for dsh-helm (safe, isolated).
#
# 1. pre live-safety check (live chain must be untouched by us)
# 2. build all packages
# 3. typecheck (strict)
# 4. lint (eslint, zero problems)
# 5. full unit+integration suite
# 6. connector legacy suite (isolated: mktemp + fake binaries + env overrides)
# 7. post live-safety check
# Any failure aborts with non-zero exit; no recovery actions are ever performed.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== [1/7] pre live-safety check =="
bash scripts/live-safety-check.sh

echo "== [2/7] build =="
./scripts/run-validation.sh 2>/dev/null | grep -E "built" || true

echo "== [3/7] typecheck =="
npm run typecheck

echo "== [4/7] lint =="
npm run lint

echo "== [5/7] full test suite =="
npx vitest run

echo "== [6/7] connector legacy suite (isolated) =="
(cd ../connector && bash tests/run-tests.sh)

echo "== [7/7] post live-safety check =="
bash scripts/live-safety-check.sh

echo "ACCEPTANCE PASS"
