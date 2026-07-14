#!/usr/bin/env bash

set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
SCRIPT="$ROOT/automation/code-insights-maintenance.sh"
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/code-insights-maintenance-test.XXXXXX")
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

assert_contains() {
  local file=$1
  local expected=$2
  grep -Fq -- "$expected" "$file" || fail "expected $file to contain: $expected"
}

assert_not_contains() {
  local file=$1
  local unexpected=$2
  if [[ -f "$file" ]] && grep -Fq -- "$unexpected" "$file"; then
    fail "expected $file not to contain: $unexpected"
  fi
}

mkdir -p "$TMP_ROOT/bin" "$TMP_ROOT/home/.code-insights"
touch "$TMP_ROOT/home/.code-insights/data.db"

cat > "$TMP_ROOT/bin/code-insights" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'code-insights %s\n' "$*" >> "$CALL_LOG"
case "${1:-}" in
  lock-run)
    shift
    export CODE_INSIGHTS_LOCK_HELD=1
    exec "$@"
    ;;
  sync)
    printf 'Already up to date!\n'
    ;;
  queue)
    ;;
  dashboard)
    printf '%s\n' "$$" > "$DASHBOARD_PID_FILE"
    touch "$DASHBOARD_STARTED_FILE"
    trap 'rm -f "$DASHBOARD_STARTED_FILE"; exit 0' TERM INT
    while :; do sleep 1; done
    ;;
  reflect)
    touch "$REFLECTED_FILE"
    printf 'Reflection complete\n'
    ;;
esac
EOF

cat > "$TMP_ROOT/bin/analyze" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'analyze %s\n' "$*" >> "$CALL_LOG"
count=0
[[ -f "$ANALYZE_COUNT_FILE" ]] && read -r count < "$ANALYZE_COUNT_FILE"
if [[ "$count" -eq 0 ]]; then
  printf '1\n' > "$ANALYZE_COUNT_FILE"
  printf 'Selected: 2 session(s)\nCompleted: 2 succeeded, 0 failed, 0 not attempted.\n'
else
  printf 'Selected: 0 session(s)\nNo incomplete sessions match this batch.\n'
fi
EOF

cat > "$TMP_ROOT/bin/sqlite3" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
query=${*: -1}
if [[ "$query" == *"MAX(sf.extracted_at)"* ]]; then
  printf '%s\n' "${FACETS_NEWER_THAN_SNAPSHOT:-0}"
elif [[ "$query" == *"FROM session_facets"* ]]; then
  printf '%s\n' "${FACET_COUNT:-0}"
elif [[ "$query" == *"SELECT session_count"* ]]; then
  if [[ "${SNAPSHOT_MATCH:-0}" == "1" || -f "$REFLECTED_FILE" ]]; then
    printf '%s\n' "${FACET_COUNT:-0}"
  else
    printf '%s\n' "${SNAPSHOT_COUNT:-0}"
  fi
fi
EOF

cat > "$TMP_ROOT/bin/curl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CURL_LOG"
if [[ -n "${CURL_STATUS:-}" ]]; then
  exit "$CURL_STATUS"
fi
[[ -f "$DASHBOARD_STARTED_FILE" ]]
EOF

chmod +x "$TMP_ROOT/bin/code-insights" "$TMP_ROOT/bin/analyze" "$TMP_ROOT/bin/sqlite3" "$TMP_ROOT/bin/curl"

export HOME="$TMP_ROOT/home"
export PATH="$TMP_ROOT/bin:/usr/bin:/bin"
export CODE_INSIGHTS_BIN="$TMP_ROOT/bin/code-insights"
export CODE_INSIGHTS_ANALYZE_SCRIPT="$TMP_ROOT/bin/analyze"
export CODE_INSIGHTS_SQLITE_BIN="$TMP_ROOT/bin/sqlite3"
export CODE_INSIGHTS_CURL_BIN="$TMP_ROOT/bin/curl"
export CODE_INSIGHTS_DB="$HOME/.code-insights/data.db"
export CODE_INSIGHTS_MAX_BATCHES=3
export CODE_INSIGHTS_BATCH_SIZE=5
export CODE_INSIGHTS_DELAY=0
export CODE_INSIGHTS_REFLECT_WEEK=2026-W27
export CODE_INSIGHTS_CURRENT_WEEK_START=2026-07-06
export CALL_LOG="$TMP_ROOT/calls.log"
export ANALYZE_COUNT_FILE="$TMP_ROOT/analyze-count"
export REFLECTED_FILE="$TMP_ROOT/reflected"
export CURL_LOG="$TMP_ROOT/curl.log"
export DASHBOARD_PID_FILE="$TMP_ROOT/dashboard.pid"
export DASHBOARD_STARTED_FILE="$TMP_ROOT/dashboard.started"

# Newest-first drain repeats bounded batches until there is no work.
FACET_COUNT=0 "$SCRIPT" run > "$TMP_ROOT/run.log" 2>&1
assert_contains "$CALL_LOG" "code-insights lock-run /bin/bash $SCRIPT run"
assert_contains "$CALL_LOG" 'code-insights sync'
assert_contains "$CALL_LOG" 'code-insights queue process -q --limit 5 --delay 0'
assert_contains "$CALL_LOG" 'analyze --days 36500 --batch-size 5 --delay 0'
[[ "$(grep -c '^analyze ' "$CALL_LOG")" -eq 2 ]] || fail 'expected two bounded analyze calls'

# A stale weekly snapshot is refreshed through an already-running dashboard.
: > "$CALL_LOG"
printf '1\n' > "$ANALYZE_COUNT_FILE"
rm -f "$REFLECTED_FILE"
FACET_COUNT=9 SNAPSHOT_COUNT=8 CURL_STATUS=0 "$SCRIPT" run > "$TMP_ROOT/reflect.log" 2>&1
assert_contains "$CALL_LOG" 'code-insights reflect --week 2026-W27'
assert_not_contains "$CALL_LOG" 'code-insights dashboard'
[[ -f "$REFLECTED_FILE" ]] || fail 'expected reflect to update the snapshot marker'

# An up-to-date weekly snapshot is idempotently skipped.
: > "$CALL_LOG"
SNAPSHOT_MATCH=1 FACET_COUNT=9 FACETS_NEWER_THAN_SNAPSHOT=0 \
  "$SCRIPT" run > "$TMP_ROOT/idempotent.log" 2>&1
assert_not_contains "$CALL_LOG" 'code-insights reflect'

# Equal counts are still stale when any facet was re-extracted after the
# snapshot was generated.
grep -Fq 'WHEN datetime(MAX(sf.extracted_at)) > datetime((' "$SCRIPT" \
  || fail 'snapshot freshness does not normalize SQLite and ISO timestamps'
: > "$CALL_LOG"
rm -f "$REFLECTED_FILE"
SNAPSHOT_MATCH=1 FACET_COUNT=9 FACETS_NEWER_THAN_SNAPSHOT=1 CURL_STATUS=0 \
  "$SCRIPT" run > "$TMP_ROOT/content-stale.log" 2>&1
assert_contains "$CALL_LOG" 'code-insights reflect --week 2026-W27'
[[ -f "$REFLECTED_FILE" ]] || fail 'expected newer facet content to refresh the snapshot'

# The configured dashboard port drives both the health check and the temporary
# server, so reflection never probes one port while starting another.
printf '%s\n' '{"dashboard":{"port":8123}}' > "$HOME/.code-insights/config.json"
: > "$CALL_LOG"
: > "$CURL_LOG"
printf '1\n' > "$ANALYZE_COUNT_FILE"
rm -f "$REFLECTED_FILE" "$DASHBOARD_STARTED_FILE" "$DASHBOARD_PID_FILE"
FACET_COUNT=9 SNAPSHOT_COUNT=8 FACETS_NEWER_THAN_SNAPSHOT=0 \
  "$SCRIPT" run > "$TMP_ROOT/configured-port.log" 2>&1
assert_contains "$CURL_LOG" 'http://127.0.0.1:8123/api/health'
assert_contains "$CALL_LOG" 'code-insights dashboard --no-open --no-sync --port 8123'
[[ ! -f "$DASHBOARD_STARTED_FILE" ]] || fail 'temporary dashboard was not stopped after reflection'

# An explicit URL overrides config.json, including the port used when a local
# temporary dashboard has to be started.
: > "$CALL_LOG"
: > "$CURL_LOG"
rm -f "$REFLECTED_FILE" "$DASHBOARD_STARTED_FILE" "$DASHBOARD_PID_FILE"
CODE_INSIGHTS_DASHBOARD_URL='http://127.0.0.1:9123' \
  FACET_COUNT=9 SNAPSHOT_COUNT=8 FACETS_NEWER_THAN_SNAPSHOT=0 \
  "$SCRIPT" run > "$TMP_ROOT/url-override.log" 2>&1
assert_contains "$CURL_LOG" 'http://127.0.0.1:9123/api/health'
assert_not_contains "$CURL_LOG" 'http://127.0.0.1:8123/api/health'
assert_contains "$CALL_LOG" 'code-insights dashboard --no-open --no-sync --port 9123'

# An unhealthy explicit remote URL cannot be repaired by launching a local
# dashboard. Fail the reflection promptly without starting an unrelated server.
: > "$CALL_LOG"
: > "$CURL_LOG"
rm -f "$REFLECTED_FILE" "$DASHBOARD_STARTED_FILE" "$DASHBOARD_PID_FILE"
set +e
CODE_INSIGHTS_DASHBOARD_URL='https://insights.example.test' CURL_STATUS=1 \
  FACET_COUNT=9 SNAPSHOT_COUNT=8 FACETS_NEWER_THAN_SNAPSHOT=0 \
  "$SCRIPT" run > "$TMP_ROOT/remote-url.log" 2>&1
remote_status=$?
set -e
[[ "$remote_status" -eq 1 ]] || fail "expected unhealthy remote dashboard exit 1, got $remote_status"
assert_contains "$CURL_LOG" 'https://insights.example.test/api/health'
assert_not_contains "$CALL_LOG" 'code-insights dashboard'
assert_contains "$TMP_ROOT/remote-url.log" 'Explicit dashboard URL is unavailable; cannot start a local replacement.'

# Week boundaries must use UTC because the server parses YYYY-WNN in UTC.
grep -Fq "date -u '+%u'" "$SCRIPT" || fail 'calendar calculation is not aligned to server UTC weeks'

# TERM must stop maintenance immediately and let EXIT cleanup release its
# temporary dashboard child. The Node lock-run tests cover shared-lock release.
: > "$CALL_LOG"
printf '1\n' > "$ANALYZE_COUNT_FILE"
rm -f "$REFLECTED_FILE" "$DASHBOARD_PID_FILE" "$DASHBOARD_STARTED_FILE"
FACET_COUNT=9 SNAPSHOT_COUNT=8 CURL_STATUS=1 \
  "$SCRIPT" run > "$TMP_ROOT/term.log" 2>&1 &
maintenance_pid=$!
for _ in {1..100}; do
  [[ -f "$DASHBOARD_PID_FILE" ]] && break
  sleep 0.05
done
[[ -f "$DASHBOARD_PID_FILE" ]] || fail 'maintenance never started its temporary dashboard'
read -r dashboard_pid < "$DASHBOARD_PID_FILE"
kill -TERM "$maintenance_pid"
set +e
wait "$maintenance_pid"
term_status=$?
set -e
[[ "$term_status" -eq 143 ]] || fail "expected TERM exit 143, got $term_status"
if kill -0 "$dashboard_pid" 2>/dev/null; then
  fail 'TERM left the temporary dashboard running'
fi
assert_not_contains "$TMP_ROOT/term.log" 'Code Insights maintenance finished'

printf 'maintenance automation tests passed\n'
