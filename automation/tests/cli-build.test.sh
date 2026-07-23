#!/usr/bin/env bash

set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

cd "$ROOT"
pnpm --filter @code-insights/cli build >/dev/null

if [[ ! -x "$ROOT/cli/dist/index.js" ]]; then
  printf 'FAIL: built CLI entry point is not executable: %s\n' "$ROOT/cli/dist/index.js" >&2
  exit 1
fi

printf 'cli build artifact test passed\n'
