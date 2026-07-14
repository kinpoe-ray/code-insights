#!/usr/bin/env bash

set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
SCRIPT="$ROOT/throttled-analyze.sh"
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/code-insights-throttled-lock-test.XXXXXX")
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

mkdir -p "$TMP_ROOT/bin" "$TMP_ROOT/home/.code-insights/locks"
touch "$TMP_ROOT/home/.code-insights/data.db"

cat > "$TMP_ROOT/bin/sqlite3" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ -z "${SQLITE_LOG:-}" ]] || printf 'sqlite3 %s\n' "$*" >> "$SQLITE_LOG"
query=${*: -1}
if [[ "$query" == *"SELECT s.id"* ]]; then
  printf 'session-1\n'
elif [[ "$query" == *"COUNT(DISTINCT analysis_type)"* ]]; then
  printf '2\n'
fi
EOF

cat > "$TMP_ROOT/bin/code-insights" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'code-insights %s\n' "$*" >> "$CALL_LOG"
if [[ "${1:-}" == 'lock-run' ]]; then
  shift
  [[ ! -d "$HOME/.code-insights/locks/llm.lock" ]] || exit 75
  CODE_INSIGHTS_LOCK_HELD=1 "$@"
fi
exit 0
EOF
chmod +x "$TMP_ROOT/bin/sqlite3" "$TMP_ROOT/bin/code-insights"

export HOME="$TMP_ROOT/home"
export PATH="$TMP_ROOT/bin:/usr/bin:/bin"
export CODE_INSIGHTS_DB="$HOME/.code-insights/data.db"
export CODE_INSIGHTS_LOG="$HOME/.code-insights/test.log"
export CODE_INSIGHTS_FAIL_LOG="$HOME/.code-insights/test.failures"
export CALL_LOG="$TMP_ROOT/calls.log"
export SQLITE_LOG="$TMP_ROOT/sqlite.log"

"$SCRIPT" --days 1 --batch-size 1 --delay 0 > "$TMP_ROOT/delegated.log" 2>&1
grep -Fq "code-insights lock-run /bin/bash $SCRIPT --days 1 --batch-size 1 --delay 0" "$CALL_LOG" \
  || fail 'standalone batch did not delegate locking to the Node lock runner'

mkdir -p "$HOME/.code-insights/locks/llm.lock"
printf '%s\n' "$$" > "$HOME/.code-insights/locks/llm.lock/pid"

set +e
"$SCRIPT" --days 1 --batch-size 1 --delay 0 > "$TMP_ROOT/busy.log" 2>&1
status=$?
set -e
[[ "$status" -eq 75 ]] || fail "expected shared lock exit 75, got $status"

CODE_INSIGHTS_LOCK_HELD=1 "$SCRIPT" --days 1 --batch-size 1 --delay 0 > "$TMP_ROOT/inherited.log" 2>&1
grep -Fq 'Completed: 1 succeeded, 0 failed' "$TMP_ROOT/inherited.log" || fail 'inherited lock did not allow serial child batch'

# All default data/log paths follow CODE_INSIGHTS_CONFIG_DIR. Maintenance sets
# this in launchd, so the child batch must not silently fall back to $HOME.
unset CODE_INSIGHTS_DB CODE_INSIGHTS_LOG CODE_INSIGHTS_FAIL_LOG
export CODE_INSIGHTS_CONFIG_DIR="$TMP_ROOT/custom-config"
mkdir -p "$CODE_INSIGHTS_CONFIG_DIR"
touch "$CODE_INSIGHTS_CONFIG_DIR/data.db"
: > "$SQLITE_LOG"
CODE_INSIGHTS_LOCK_HELD=1 "$SCRIPT" --days 1 --batch-size 1 --delay 0 > "$TMP_ROOT/custom.log" 2>&1
grep -Fq "sqlite3 $CODE_INSIGHTS_CONFIG_DIR/data.db" "$SQLITE_LOG" \
  || fail 'custom config directory did not select its database'
[[ -f "$CODE_INSIGHTS_CONFIG_DIR/throttled-analyze.log" ]] \
  || fail 'custom config directory did not receive the analysis log'

printf 'throttled shared-lock tests passed\n'
