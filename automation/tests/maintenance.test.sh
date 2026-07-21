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

HOST_NODE_BIN=$(command -v node 2>/dev/null || true)
[[ -n "$HOST_NODE_BIN" ]] || fail 'node executable not found'
ln -s "$HOST_NODE_BIN" "$TMP_ROOT/bin/node"

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
    [[ -z "${PAUSE_AFTER_SYNC_FILE:-}" ]] || touch "$PAUSE_AFTER_SYNC_FILE"
    ;;
  queue)
    ;;
  reanalyze)
    if [[ "${2:-}" == 'run' ]]; then
      if [[ -n "${HISTORY_REFRESH_STATUS:-}" ]]; then
        printf '{"active":false,"status":"%s","processed":1,"stopReason":"%s"}\n' \
          "$HISTORY_REFRESH_STATUS" "$HISTORY_REFRESH_STATUS"
      elif [[ "${HISTORY_REFRESH_ACTIVE:-0}" == '1' ]]; then
        printf '{"active":true,"status":"active","processed":2,"stopReason":"batch_limit"}\n'
      else
        printf '{"active":false,"status":"idle","processed":0,"stopReason":"no_active_campaign"}\n'
      fi
    fi
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
printf 'analysis-deadline %s\n' "${CODE_INSIGHTS_DEADLINE_EPOCH:-none}" >> "$CALL_LOG"
if [[ -n "${ANALYZE_PAUSE_FILE:-}" ]]; then
  touch "$ANALYZE_PAUSE_FILE"
  printf 'Selected: 2 session(s)\nCompleted: 0 succeeded, 0 failed, 2 not attempted.\n'
  exit 3
fi
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

cat > "$TMP_ROOT/bin/date" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == '+%H:%M' && -n "${WINDOW_TIME_COUNT_FILE:-}" ]]; then
  count=0
  [[ -f "$WINDOW_TIME_COUNT_FILE" ]] && read -r count < "$WINDOW_TIME_COUNT_FILE"
  printf '%s\n' "$((count + 1))" > "$WINDOW_TIME_COUNT_FILE"
  if [[ "$count" -ge "${WINDOW_TIME_SWITCH_AFTER:-0}" ]]; then
    printf '%s\n' "${WINDOW_TIME_AFTER:-06:00}"
  else
    printf '%s\n' "${WINDOW_TIME_BEFORE:-05:59}"
  fi
  exit 0
fi
exec /bin/date "$@"
EOF

chmod +x "$TMP_ROOT/bin/code-insights" "$TMP_ROOT/bin/analyze" "$TMP_ROOT/bin/sqlite3" "$TMP_ROOT/bin/curl" "$TMP_ROOT/bin/date"

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
export WINDOW_TIME_COUNT_FILE="$TMP_ROOT/window-time-count"

# A paused maintenance run exits successfully before lock acquisition, sync,
# queue processing, analysis, or reflection.
: > "$CALL_LOG"
touch "$HOME/.code-insights/maintenance.paused"
set +e
"$SCRIPT" run > "$TMP_ROOT/paused.log" 2>&1
paused_status=$?
set -e
[[ "$paused_status" -eq 0 ]] || fail "expected paused maintenance exit 0, got $paused_status"
[[ ! -s "$CALL_LOG" ]] || fail 'paused maintenance invoked an automatic command'
assert_contains "$TMP_ROOT/paused.log" 'Maintenance is paused; no work was started.'
rm -f "$HOME/.code-insights/maintenance.paused"

# A pause requested after sync stops the same maintenance chain before queue,
# analysis, and reflection.
: > "$CALL_LOG"
export PAUSE_AFTER_SYNC_FILE="$HOME/.code-insights/maintenance.paused"
"$SCRIPT" run > "$TMP_ROOT/paused-after-sync.log" 2>&1
unset PAUSE_AFTER_SYNC_FILE
assert_contains "$CALL_LOG" 'code-insights sync'
assert_not_contains "$CALL_LOG" 'code-insights queue process'
assert_not_contains "$CALL_LOG" 'analyze '
assert_not_contains "$CALL_LOG" 'code-insights reflect'
assert_contains "$TMP_ROOT/paused-after-sync.log" 'Maintenance was paused; remaining work will resume later.'
rm -f "$HOME/.code-insights/maintenance.paused"

# A malformed maintenance-window boundary is rejected before any automatic
# command starts.
: > "$CALL_LOG"
set +e
CODE_INSIGHTS_WINDOW_END='24:00' "$SCRIPT" run > "$TMP_ROOT/invalid-window.log" 2>&1
invalid_window_status=$?
set -e
[[ "$invalid_window_status" -eq 64 ]] \
  || fail "expected invalid maintenance window exit 64, got $invalid_window_status"
assert_not_contains "$CALL_LOG" 'code-insights sync'
assert_contains "$TMP_ROOT/invalid-window.log" 'Invalid CODE_INSIGHTS_WINDOW_END'

# A run that starts at or after its cutoff exits cleanly without sync or LLM
# work. Midnight is a deterministic already-ended boundary for this test.
: > "$CALL_LOG"
CODE_INSIGHTS_WINDOW_END='00:00' \
  "$SCRIPT" run > "$TMP_ROOT/closed-window.log" 2>&1
assert_not_contains "$CALL_LOG" 'code-insights sync'
assert_not_contains "$CALL_LOG" 'code-insights queue process'
assert_not_contains "$CALL_LOG" 'analyze '
assert_not_contains "$CALL_LOG" 'code-insights reflect'
assert_contains "$TMP_ROOT/closed-window.log" \
  'Maintenance window ended at 00:00; no work was started.'

# Newest-first drain repeats bounded batches until there is no work.
FACET_COUNT=0 "$SCRIPT" run > "$TMP_ROOT/run.log" 2>&1
assert_contains "$CALL_LOG" "code-insights lock-run /bin/bash $SCRIPT run"
assert_contains "$CALL_LOG" 'code-insights sync'
assert_contains "$CALL_LOG" 'code-insights queue process -q --limit 5 --delay 0'
assert_contains "$CALL_LOG" 'code-insights reanalyze run --batch-size 5 --retry-failed --json'
assert_contains "$CALL_LOG" 'analyze --days 36500 --batch-size 5 --delay 0'
[[ "$(grep -c '^analyze ' "$CALL_LOG")" -eq 2 ]] || fail 'expected two bounded analyze calls'

# The cutoff is checked before every analysis batch. Work completed before the
# boundary stays complete; unstarted sessions are retained for the next run.
: > "$CALL_LOG"
rm -f "$ANALYZE_COUNT_FILE" "$WINDOW_TIME_COUNT_FILE"
WINDOW_TIME_SWITCH_AFTER=4 CODE_INSIGHTS_WINDOW_END='06:00' FACET_COUNT=0 \
  "$SCRIPT" run > "$TMP_ROOT/window-boundary.log" 2>&1
[[ "$(grep -c '^analyze ' "$CALL_LOG")" -eq 1 ]] \
  || fail 'expected the window boundary to stop before the second analysis batch'
assert_contains "$TMP_ROOT/window-boundary.log" \
  'Maintenance window ended at 06:00; remaining analysis will resume on the next schedule.'

# The absolute cutoff is exported to the inner analyzer so it can stop between
# individual sessions, not only between outer batches.
: > "$CALL_LOG"
rm -f "$ANALYZE_COUNT_FILE" "$WINDOW_TIME_COUNT_FILE"
WINDOW_TIME_SWITCH_AFTER=100 CODE_INSIGHTS_WINDOW_END='06:00' \
  CODE_INSIGHTS_DEADLINE_EPOCH=9999999999 FACET_COUNT=0 \
  "$SCRIPT" run > "$TMP_ROOT/deadline-propagation.log" 2>&1
assert_contains "$CALL_LOG" 'analysis-deadline 9999999999'

# Exit 3 from the inner analyzer is a normal pause/deadline stop. Maintenance
# must not launch another batch or reflection after it.
: > "$CALL_LOG"
rm -f "$ANALYZE_COUNT_FILE" "$REFLECTED_FILE"
export ANALYZE_PAUSE_FILE="$HOME/.code-insights/maintenance.paused"
FACET_COUNT=9 SNAPSHOT_COUNT=8 CURL_STATUS=0 \
  "$SCRIPT" run > "$TMP_ROOT/paused-during-analysis.log" 2>&1
unset ANALYZE_PAUSE_FILE
[[ "$(grep -c '^analyze ' "$CALL_LOG")" -eq 1 ]] \
  || fail 'pause did not stop after the current analysis batch'
assert_not_contains "$CALL_LOG" 'code-insights reflect'
assert_contains "$TMP_ROOT/paused-during-analysis.log" 'Maintenance was paused; remaining work will resume later.'
rm -f "$HOME/.code-insights/maintenance.paused"

# A durable history refresh owns the scheduled analysis budget. Maintenance
# advances it once, then skips legacy selection and reflection so mixed model
# generations are not synthesized mid-campaign.
: > "$CALL_LOG"
rm -f "$ANALYZE_COUNT_FILE" "$REFLECTED_FILE"
HISTORY_REFRESH_ACTIVE=1 FACET_COUNT=9 SNAPSHOT_COUNT=8 CURL_STATUS=0 \
  "$SCRIPT" run > "$TMP_ROOT/history-refresh.log" 2>&1
assert_contains "$CALL_LOG" 'code-insights reanalyze run --batch-size 5 --retry-failed --json'
[[ "$(grep -c '^analyze ' "$CALL_LOG" || true)" -eq 0 ]] \
  || fail 'active history refresh also started legacy analysis'
assert_not_contains "$CALL_LOG" 'code-insights reflect'
assert_contains "$TMP_ROOT/history-refresh.log" 'Durable history reanalysis remains active'

# A campaign completed by this batch reports active=false, so maintenance
# continues legacy analysis/reflection in the same window instead of waiting
# for the next day's schedule.
: > "$CALL_LOG"
rm -f "$ANALYZE_COUNT_FILE" "$REFLECTED_FILE"
HISTORY_REFRESH_STATUS=completed FACET_COUNT=0 \
  "$SCRIPT" run > "$TMP_ROOT/history-refresh-completed.log" 2>&1
assert_contains "$CALL_LOG" 'code-insights reanalyze run --batch-size 5 --retry-failed --json'
assert_contains "$CALL_LOG" 'analyze --days 36500 --batch-size 5 --delay 0'
assert_not_contains "$TMP_ROOT/history-refresh-completed.log" 'Durable history reanalysis remains active'

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
