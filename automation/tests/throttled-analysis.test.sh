#!/usr/bin/env bash

set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
SCRIPT="$ROOT/throttled-analyze.sh"
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/code-insights-throttled-analysis-test.XXXXXX")
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

REAL_SQLITE3=$(command -v sqlite3) || fail 'sqlite3 is required for this test'
mkdir -p "$TMP_ROOT/home/.code-insights"
DB="$TMP_ROOT/home/.code-insights/data.db"

"$REAL_SQLITE3" "$DB" <<'SQL'
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  source_tool TEXT NOT NULL,
  started_at TEXT NOT NULL,
  message_count INTEGER NOT NULL,
  deleted_at TEXT
);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL
);
CREATE TABLE analysis_usage (
  session_id TEXT NOT NULL,
  analysis_type TEXT NOT NULL,
  session_message_count INTEGER,
  PRIMARY KEY (session_id, analysis_type)
);
INSERT INTO sessions VALUES ('dry-run-session', 'codex-cli', datetime('now', '-1 day'), 3, NULL);
INSERT INTO messages VALUES (1, 'dry-run-session');
INSERT INTO sessions VALUES ('complete-session', 'claude-code', datetime('now', '-2 days'), 4, NULL);
INSERT INTO messages VALUES (2, 'complete-session');
INSERT INTO analysis_usage VALUES ('complete-session', 'session', 4);
INSERT INTO analysis_usage VALUES ('complete-session', 'prompt_quality', 4);
INSERT INTO sessions VALUES ('paused-before-session', 'claude-code', datetime('now', '-3 days'), 4, NULL);
INSERT INTO messages VALUES (8, 'paused-before-session');
INSERT INTO analysis_usage VALUES ('paused-before-session', 'session', 4);
INSERT INTO analysis_usage VALUES ('paused-before-session', 'prompt_quality', 4);
INSERT INTO sessions VALUES ('range-start', 'cursor', '2026-05-31T16:00:00Z', 3, NULL);
INSERT INTO messages VALUES (3, 'range-start');
INSERT INTO sessions VALUES ('range-middle', 'cursor', '2026-06-15 12:00:00', 3, NULL);
INSERT INTO messages VALUES (4, 'range-middle');
INSERT INTO sessions VALUES ('range-end', 'cursor', '2026-06-30T15:59:59Z', 3, NULL);
INSERT INTO messages VALUES (5, 'range-end');
INSERT INTO sessions VALUES ('range-local-start', 'cursor', '2026-05-31T16:00:00Z', 3, NULL);
INSERT INTO messages VALUES (11, 'range-local-start');
INSERT INTO sessions VALUES ('range-local-after', 'cursor', '2026-06-30T16:00:00Z', 3, NULL);
INSERT INTO messages VALUES (12, 'range-local-after');
INSERT INTO sessions VALUES ('before-range', 'cursor', '2026-05-31T15:59:59Z', 3, NULL);
INSERT INTO messages VALUES (6, 'before-range');
INSERT INTO sessions VALUES ('after-range', 'cursor', '2026-06-30T16:00:00Z', 3, NULL);
INSERT INTO messages VALUES (7, 'after-range');
INSERT INTO sessions VALUES ('default-window-inside', 'copilot', datetime('now', '-13 days'), 3, NULL);
INSERT INTO messages VALUES (9, 'default-window-inside');
INSERT INTO sessions VALUES ('default-window-outside', 'copilot', datetime('now', '-15 days'), 3, NULL);
INSERT INTO messages VALUES (10, 'default-window-outside');
SQL

# Dry-run is a read-only preview and must work before the executable that can
# call the model has been installed. Restrict PATH so code-insights is absent.
if PATH='/usr/bin:/bin' command -v code-insights >/dev/null 2>&1; then
  fail 'test PATH unexpectedly contains code-insights'
fi

HOME="$TMP_ROOT/home" PATH='/usr/bin:/bin' \
  CODE_INSIGHTS_DB="$DB" \
  CODE_INSIGHTS_LOG="$TMP_ROOT/analysis.log" \
  CODE_INSIGHTS_FAIL_LOG="$TMP_ROOT/failures.log" \
  "$SCRIPT" --dry-run --batch-size 10 --delay 0 > "$TMP_ROOT/dry-run.log" 2>&1

assert_contains "$TMP_ROOT/dry-run.log" 'dry-run-session'
assert_not_contains "$TMP_ROOT/dry-run.log" 'complete-session'
assert_contains "$TMP_ROOT/dry-run.log" 'Dry run: no analysis calls made.'
[[ ! -e "$TMP_ROOT/analysis.log" ]] || fail 'dry-run created an analysis log'
[[ ! -e "$TMP_ROOT/failures.log" ]] || fail 'dry-run created a failure log'

# Omitting all date controls preserves the rolling 14-day default.
HOME="$TMP_ROOT/home" PATH='/usr/bin:/bin' \
  CODE_INSIGHTS_DB="$DB" \
  CODE_INSIGHTS_LOG="$TMP_ROOT/analysis.log" \
  CODE_INSIGHTS_FAIL_LOG="$TMP_ROOT/failures.log" \
  "$SCRIPT" --source copilot --dry-run --batch-size 10 --delay 0 > "$TMP_ROOT/default-window.log" 2>&1
assert_contains "$TMP_ROOT/default-window.log" 'days 14'
assert_contains "$TMP_ROOT/default-window.log" 'default-window-inside'
assert_not_contains "$TMP_ROOT/default-window.log" 'default-window-outside'

# Existing failure quarantine remains isolated from ordinary resumable runs,
# and retry-failed is still the explicit route back into that work.
printf '%s\n' 'dry-run-session' > "$TMP_ROOT/failures.log"
HOME="$TMP_ROOT/home" PATH='/usr/bin:/bin' \
  CODE_INSIGHTS_DB="$DB" \
  CODE_INSIGHTS_LOG="$TMP_ROOT/analysis.log" \
  CODE_INSIGHTS_FAIL_LOG="$TMP_ROOT/failures.log" \
  "$SCRIPT" --source codex-cli --dry-run --batch-size 10 --delay 0 > "$TMP_ROOT/quarantined.log" 2>&1
assert_not_contains "$TMP_ROOT/quarantined.log" 'dry-run-session'
assert_contains "$TMP_ROOT/quarantined.log" 'No incomplete sessions match this batch.'

HOME="$TMP_ROOT/home" PATH='/usr/bin:/bin' \
  CODE_INSIGHTS_DB="$DB" \
  CODE_INSIGHTS_LOG="$TMP_ROOT/analysis.log" \
  CODE_INSIGHTS_FAIL_LOG="$TMP_ROOT/failures.log" \
  "$SCRIPT" --source codex-cli --retry-failed --dry-run --batch-size 10 --delay 0 \
    > "$TMP_ROOT/retry-quarantined.log" 2>&1
assert_contains "$TMP_ROOT/retry-quarantined.log" 'dry-run-session'
rm -f "$TMP_ROOT/failures.log"

# Force mode includes already-complete sessions so a model migration can be
# previewed before any paid calls are made.
HOME="$TMP_ROOT/home" PATH='/usr/bin:/bin' \
  CODE_INSIGHTS_DB="$DB" \
  CODE_INSIGHTS_LOG="$TMP_ROOT/analysis.log" \
  CODE_INSIGHTS_FAIL_LOG="$TMP_ROOT/failures.log" \
  "$SCRIPT" --force --dry-run --batch-size 10 --delay 0 > "$TMP_ROOT/force-dry-run.log" 2>&1

assert_contains "$TMP_ROOT/force-dry-run.log" 'complete-session'
assert_contains "$TMP_ROOT/force-dry-run.log" 'dry-run-session'
assert_contains "$TMP_ROOT/force-dry-run.log" 'Dry run: no analysis calls made.'

# The real batch must propagate force to the per-session public command;
# selecting a complete session is insufficient because insights otherwise
# resumes by skipping that session.
mkdir -p "$TMP_ROOT/bin"
cat > "$TMP_ROOT/bin/code-insights" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$CALL_LOG"
if [[ "${1:-}" == 'insights' && -n "${PAUSE_AFTER_CALL:-}" ]]; then
  touch "$PAUSE_AFTER_CALL"
fi
exit 0
EOF
chmod +x "$TMP_ROOT/bin/code-insights"
export CALL_LOG="$TMP_ROOT/code-insights-calls.log"

HOME="$TMP_ROOT/home" PATH="$TMP_ROOT/bin:/usr/bin:/bin" \
  CODE_INSIGHTS_LOCK_HELD=1 \
  CODE_INSIGHTS_DB="$DB" \
  CODE_INSIGHTS_LOG="$TMP_ROOT/analysis.log" \
  CODE_INSIGHTS_FAIL_LOG="$TMP_ROOT/failures.log" \
  "$SCRIPT" --force --source claude-code --batch-size 1 --delay 0 > "$TMP_ROOT/force-run.log" 2>&1

assert_contains "$CALL_LOG" 'insights complete-session --force'
assert_contains "$TMP_ROOT/force-run.log" 'Completed: 1 succeeded, 0 failed, 0 not attempted.'

# The maintenance pause marker is checked between sessions. A marker created
# after one completed call leaves the next selected session untouched.
: > "$CALL_LOG"
PAUSE_CONFIG="$TMP_ROOT/pause-config"
mkdir -p "$PAUSE_CONFIG"
export PAUSE_AFTER_CALL="$PAUSE_CONFIG/maintenance.paused"
set +e
HOME="$TMP_ROOT/home" PATH="$TMP_ROOT/bin:/usr/bin:/bin" \
  CODE_INSIGHTS_CONFIG_DIR="$PAUSE_CONFIG" \
  CODE_INSIGHTS_LOCK_HELD=1 \
  CODE_INSIGHTS_DB="$DB" \
  CODE_INSIGHTS_LOG="$TMP_ROOT/paused-analysis.log" \
  CODE_INSIGHTS_FAIL_LOG="$TMP_ROOT/paused-failures.log" \
  "$SCRIPT" --force --source claude-code --batch-size 2 --delay 0 > "$TMP_ROOT/paused-run.log" 2>&1
paused_run_status=$?
set -e
unset PAUSE_AFTER_CALL

[[ "$paused_run_status" -eq 3 ]] || fail "expected mid-run pause exit 3, got $paused_run_status"
[[ "$(wc -l < "$CALL_LOG" | tr -d ' ')" -eq 1 ]] || fail 'pause marker did not stop before the next session call'
assert_contains "$CALL_LOG" 'insights complete-session --force'
assert_not_contains "$CALL_LOG" 'paused-before-session'
assert_contains "$TMP_ROOT/paused-run.log" 'Analysis paused by maintenance.paused.'
assert_contains "$TMP_ROOT/paused-run.log" 'Completed: 1 succeeded, 0 failed, 1 not attempted.'

# Explicit date bounds form a closed calendar-date interval. Both boundary
# dates are included in full, while adjacent timestamps stay outside.
TZ='Asia/Shanghai' HOME="$TMP_ROOT/home" PATH='/usr/bin:/bin' \
  CODE_INSIGHTS_DB="$DB" \
  CODE_INSIGHTS_LOG="$TMP_ROOT/analysis.log" \
  CODE_INSIGHTS_FAIL_LOG="$TMP_ROOT/failures.log" \
  "$SCRIPT" --from 2026-06-01 --to 2026-06-30 --source cursor \
    --dry-run --batch-size 10 --delay 0 > "$TMP_ROOT/date-range.log" 2>&1

assert_contains "$TMP_ROOT/date-range.log" 'range-start'
assert_contains "$TMP_ROOT/date-range.log" 'range-middle'
assert_contains "$TMP_ROOT/date-range.log" 'range-end'
assert_contains "$TMP_ROOT/date-range.log" 'range-local-start'
assert_not_contains "$TMP_ROOT/date-range.log" 'range-local-after'
assert_not_contains "$TMP_ROOT/date-range.log" 'before-range'
assert_not_contains "$TMP_ROOT/date-range.log" 'after-range'

set +e
HOME="$TMP_ROOT/home" PATH='/usr/bin:/bin' CODE_INSIGHTS_DB="$DB" \
  "$SCRIPT" --from 2026-06-01 --dry-run > "$TMP_ROOT/unpaired-range.log" 2>&1
unpaired_status=$?
set -e
[[ "$unpaired_status" -eq 64 ]] || fail "expected unpaired date range exit 64, got $unpaired_status"
assert_contains "$TMP_ROOT/unpaired-range.log" '--from and --to must be used together'

set +e
HOME="$TMP_ROOT/home" PATH='/usr/bin:/bin' CODE_INSIGHTS_DB="$DB" \
  "$SCRIPT" --days 7 --from 2026-06-01 --to 2026-06-30 --dry-run \
    > "$TMP_ROOT/conflicting-range.log" 2>&1
conflicting_status=$?
set -e
[[ "$conflicting_status" -eq 64 ]] || fail "expected conflicting range exit 64, got $conflicting_status"
assert_contains "$TMP_ROOT/conflicting-range.log" '--days cannot be combined with --from/--to'

# The legacy positional lookback is still an explicit date control and cannot
# silently override an exact calendar range.
set +e
HOME="$TMP_ROOT/home" PATH='/usr/bin:/bin' CODE_INSIGHTS_DB="$DB" \
  "$SCRIPT" 0 7 --from 2026-06-01 --to 2026-06-30 --dry-run \
    > "$TMP_ROOT/legacy-conflicting-range.log" 2>&1
legacy_conflicting_status=$?
set -e
[[ "$legacy_conflicting_status" -eq 64 ]] \
  || fail "expected legacy conflicting range exit 64, got $legacy_conflicting_status"
assert_contains "$TMP_ROOT/legacy-conflicting-range.log" '--days cannot be combined with --from/--to'

set +e
HOME="$TMP_ROOT/home" PATH='/usr/bin:/bin' CODE_INSIGHTS_DB="$DB" \
  "$SCRIPT" --from 2026-02-30 --to 2026-06-30 --dry-run \
    > "$TMP_ROOT/invalid-date.log" 2>&1
invalid_date_status=$?
set -e
[[ "$invalid_date_status" -eq 64 ]] || fail "expected invalid date exit 64, got $invalid_date_status"
assert_contains "$TMP_ROOT/invalid-date.log" '--from must be a valid date in YYYY-MM-DD format'

set +e
HOME="$TMP_ROOT/home" PATH='/usr/bin:/bin' CODE_INSIGHTS_DB="$DB" \
  "$SCRIPT" --from 2026-07-01 --to 2026-06-30 --dry-run \
    > "$TMP_ROOT/reversed-range.log" 2>&1
reversed_range_status=$?
set -e
[[ "$reversed_range_status" -eq 64 ]] || fail "expected reversed range exit 64, got $reversed_range_status"
assert_contains "$TMP_ROOT/reversed-range.log" '--from must not be later than --to'

set +e
HOME="$TMP_ROOT/home" PATH='/usr/bin:/bin' CODE_INSIGHTS_DB="$DB" \
  "$SCRIPT" --from "2026-06-01' OR 1=1 --" --to 2026-06-30 --dry-run \
    > "$TMP_ROOT/injected-date.log" 2>&1
injected_date_status=$?
set -e
[[ "$injected_date_status" -eq 64 ]] || fail "expected injected date exit 64, got $injected_date_status"
assert_contains "$TMP_ROOT/injected-date.log" '--from must be a valid date in YYYY-MM-DD format'
assert_not_contains "$TMP_ROOT/injected-date.log" 'Selected:'

# A hard deadline is checked between individual sessions, not merely between
# outer maintenance batches. A session already in flight may finish, but no new
# model call starts after the deadline.
cat > "$TMP_ROOT/bin/date" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == '+%s' ]]; then
  count=0
  [[ -f "$DEADLINE_CLOCK_FILE" ]] && read -r count < "$DEADLINE_CLOCK_FILE"
  printf '%s\n' "$((count + 1))" > "$DEADLINE_CLOCK_FILE"
  if [[ "$count" -ge 2 ]]; then
    printf '200\n'
  else
    printf '100\n'
  fi
  exit 0
fi
exec /bin/date "$@"
EOF
chmod +x "$TMP_ROOT/bin/date"
: > "$CALL_LOG"
rm -f "$PAUSE_CONFIG/maintenance.paused" "$TMP_ROOT/deadline-clock"
export DEADLINE_CLOCK_FILE="$TMP_ROOT/deadline-clock"
set +e
HOME="$TMP_ROOT/home" PATH="$TMP_ROOT/bin:/usr/bin:/bin" \
  CODE_INSIGHTS_CONFIG_DIR="$PAUSE_CONFIG" \
  CODE_INSIGHTS_DEADLINE_EPOCH=150 \
  CODE_INSIGHTS_LOCK_HELD=1 \
  CODE_INSIGHTS_DB="$DB" \
  CODE_INSIGHTS_LOG="$TMP_ROOT/deadline-analysis.log" \
  CODE_INSIGHTS_FAIL_LOG="$TMP_ROOT/deadline-failures.log" \
  "$SCRIPT" --force --source claude-code --batch-size 2 --delay 0 \
    > "$TMP_ROOT/deadline-run.log" 2>&1
deadline_status=$?
set -e
[[ "$deadline_status" -eq 3 ]] || fail "expected deadline exit 3, got $deadline_status"
[[ "$(wc -l < "$CALL_LOG" | tr -d ' ')" -eq 1 ]] \
  || fail 'deadline did not stop before the next session call'
assert_contains "$TMP_ROOT/deadline-run.log" 'Analysis deadline reached; remaining work was not attempted.'

printf 'throttled analysis tests passed\n'
