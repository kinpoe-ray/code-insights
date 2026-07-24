#!/usr/bin/env bash

set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
RUNNER="$ROOT/automation/code-insights-maintenance-runner.sh"
ALERT_SCRIPT="$ROOT/automation/code-insights-analysis-alert.mjs"
REAL_SQLITE3=$(command -v sqlite3)
REAL_NODE=$(command -v node)
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/code-insights-maintenance-alert-test.XXXXXX")
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

mkdir -p "$TMP_ROOT/bin" "$TMP_ROOT/home/.code-insights"
chmod 700 "$TMP_ROOT/home" "$TMP_ROOT/home/.code-insights"
DB="$TMP_ROOT/home/.code-insights/data.db"
CONFIG="$TMP_ROOT/home/.code-insights/analysis-alert.json"
STATE="$TMP_ROOT/home/.code-insights/analysis-alert-state.json"
SEND_LOG="$TMP_ROOT/send.log"
CALL_LOG="$TMP_ROOT/calls.log"
SENDER="$TMP_ROOT/fake-tt-send.mjs"

"$REAL_SQLITE3" "$DB" <<'SQL'
CREATE TABLE analysis_campaigns (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  pipeline_revision TEXT NOT NULL,
  status TEXT NOT NULL,
  total_items INTEGER NOT NULL
);
CREATE TABLE analysis_campaign_items (
  campaign_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL,
  error_code TEXT,
  safe_error TEXT,
  PRIMARY KEY (campaign_id, session_id)
);
INSERT INTO analysis_campaigns
  (id, provider, model, pipeline_revision, status, total_items)
VALUES
  ('campaign-maintenance', 'anthropic', 'glm-5.2', 'two-pass-v5', 'active', 1);
INSERT INTO analysis_campaign_items
  (campaign_id, session_id, status, error_code, safe_error)
VALUES
  ('campaign-maintenance', 'session-1', 'pending', NULL, NULL);
SQL

cat > "$SENDER" <<'EOF'
#!/usr/bin/env node
import { appendFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const sendLog = fileURLToPath(new URL('./send.log', import.meta.url));
const failSend = fileURLToPath(new URL('./fail-send', import.meta.url));
const lockMarker = fileURLToPath(new URL('./llm-lock-held', import.meta.url));
if (args[0] === '--config-paths') {
  process.stdout.write('{"success":true}\n');
} else if (args[0] === '--check') {
  process.stdout.write('{"success":true,"configured":true}\n');
} else {
  if (existsSync(failSend)) {
    process.stdout.write('{"success":false,"recipient":"PRIVATE_RECIPIENT","error":"PRIVATE_TOKEN"}\n');
    process.stderr.write('PRIVATE_SENDER_STDERR\n');
    process.exitCode = 1;
    process.exit();
  }
  appendFileSync(
    sendLog,
    `SEND|lock=${existsSync(lockMarker) ? 'held' : 'released'}|${args[1]}\n`,
  );
  process.stdout.write('{"success":true,"messageIds":["maintenance-test"]}\n');
}
EOF
chmod +x "$SENDER"
printf '%s\n' \
  "{\"version\":1,\"enabled\":true,\"target\":\"Test Contact\",\"senderScript\":\"$SENDER\"}" \
  > "$CONFIG"
chmod 600 "$CONFIG"

cat > "$TMP_ROOT/bin/code-insights" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$CALL_LOG"
case "${1:-}" in
  lock-run)
    shift
    export CODE_INSIGHTS_LOCK_HELD=1
    touch "$LOCK_MARKER"
    set +e
    "$@"
    status=$?
    set -e
    rm -f "$LOCK_MARKER"
    exit "$status"
    ;;
  sync)
    printf 'Already up to date!\n'
    ;;
  queue)
    ;;
  reanalyze)
    campaign_id=${HISTORY_CAMPAIGN_ID:-campaign-maintenance}
    session_id=${HISTORY_SESSION_ID:-session-1}
    "$REAL_SQLITE3" "$CODE_INSIGHTS_DB" "
      UPDATE analysis_campaign_items
      SET status = 'failed',
          error_code = 'INVALID_MODEL_OUTPUT',
          safe_error = 'private model response'
      WHERE campaign_id = '$campaign_id'
        AND session_id = '$session_id';
    "
    printf '{"active":true,"status":"active","processed":0,"remaining":1,"failed":1,"stopReason":"failed_items"}\n'
    ;;
esac
EOF

cat > "$TMP_ROOT/bin/analyze" <<'EOF'
#!/usr/bin/env bash
exit 99
EOF

cat > "$TMP_ROOT/bin/curl" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF

chmod +x "$TMP_ROOT/bin/code-insights" "$TMP_ROOT/bin/analyze" "$TMP_ROOT/bin/curl"
ln -s "$REAL_NODE" "$TMP_ROOT/bin/node"

export HOME="$TMP_ROOT/home"
export PATH="$TMP_ROOT/bin:/usr/bin:/bin"
export CODE_INSIGHTS_BIN="$TMP_ROOT/bin/code-insights"
export CODE_INSIGHTS_ANALYZE_SCRIPT="$TMP_ROOT/bin/analyze"
export CODE_INSIGHTS_SQLITE_BIN="$REAL_SQLITE3"
export CODE_INSIGHTS_CURL_BIN="$TMP_ROOT/bin/curl"
export CODE_INSIGHTS_DB="$DB"
export CODE_INSIGHTS_CONFIG_DIR="$HOME/.code-insights"
export CODE_INSIGHTS_ALERT_SCRIPT="$ALERT_SCRIPT"
export CODE_INSIGHTS_ALERT_CONFIG="$CONFIG"
export CODE_INSIGHTS_ALERT_STATE="$STATE"
export REAL_SQLITE3
export CALL_LOG
export LOCK_MARKER="$TMP_ROOT/llm-lock-held"
export HISTORY_CAMPAIGN_ID=campaign-maintenance
export HISTORY_SESSION_ID=session-1

"$RUNNER" run > "$TMP_ROOT/maintenance.out" 2> "$TMP_ROOT/maintenance.err"

[[ "$(grep -c '^SEND|' "$SEND_LOG")" -eq 1 ]] \
  || fail 'maintenance did not deliver the new current-campaign failure'
grep -Fq 'SEND|lock=released|Code Insights 自动分析失败：当前任务发现 1 条失败。' "$SEND_LOG" \
  || fail 'maintenance delivered the alert while still holding the LLM lock'
if grep -Eq 'private model response|Test Contact' \
  "$TMP_ROOT/maintenance.out" "$TMP_ROOT/maintenance.err" "$HOME/.code-insights/logs/"*; then
  fail 'maintenance logs leaked alert-private content'
fi

# A TeamTalk failure never changes the maintenance exit code, never leaks the
# sender response, and leaves the delivery cursor ready for a later retry.
"$REAL_SQLITE3" "$DB" <<'SQL'
UPDATE analysis_campaigns SET status = 'cancelled' WHERE id = 'campaign-maintenance';
INSERT INTO analysis_campaigns
  (id, provider, model, pipeline_revision, status, total_items)
VALUES
  ('campaign-delivery-failure', 'anthropic', 'glm-5.2', 'two-pass-v5', 'active', 1);
INSERT INTO analysis_campaign_items
  (campaign_id, session_id, status, error_code, safe_error)
VALUES
  ('campaign-delivery-failure', 'session-2', 'pending', NULL, NULL);
SQL
export HISTORY_CAMPAIGN_ID=campaign-delivery-failure
export HISTORY_SESSION_ID=session-2
set +e
touch "$TMP_ROOT/fail-send"
"$RUNNER" run \
  > "$TMP_ROOT/delivery-failure.out" 2> "$TMP_ROOT/delivery-failure.err"
delivery_failure_status=$?
rm -f "$TMP_ROOT/fail-send"
set -e
[[ "$delivery_failure_status" -eq 0 ]] \
  || fail "alert failure changed maintenance exit status to $delivery_failure_status"
if grep -Eq 'PRIVATE_RECIPIENT|PRIVATE_TOKEN|PRIVATE_SENDER_STDERR|private model response|Test Contact' \
  "$TMP_ROOT/delivery-failure.out" "$TMP_ROOT/delivery-failure.err" "$HOME/.code-insights/logs/"*; then
  fail 'failed alert leaked sender or campaign-private content'
fi
[[ "$(grep -c '^SEND|' "$SEND_LOG")" -eq 1 ]] \
  || fail 'failed sender was incorrectly recorded as a successful delivery'

"$RUNNER" run > "$TMP_ROOT/delivery-retry.out" 2> "$TMP_ROOT/delivery-retry.err"
[[ "$(grep -c '^SEND|' "$SEND_LOG")" -eq 2 ]] \
  || fail 'maintenance did not retry the undelivered alert'
[[ "$(grep -c '^SEND|lock=released|' "$SEND_LOG")" -eq 2 ]] \
  || fail 'a retried alert was sent while the LLM lock was held'

# If the campaign completes but recovery delivery fails, the next scheduled
# run retries only the already tracked campaign. It does not scan arbitrary
# completed history.
"$REAL_SQLITE3" "$DB" "
  UPDATE analysis_campaign_items
  SET status = 'succeeded', error_code = NULL, safe_error = NULL
  WHERE campaign_id = 'campaign-delivery-failure'
    AND session_id = 'session-2';
  UPDATE analysis_campaigns
  SET status = 'completed'
  WHERE id = 'campaign-delivery-failure';
"
cat > "$TMP_ROOT/bin/maintenance-success" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$TMP_ROOT/bin/maintenance-success"
set +e
touch "$TMP_ROOT/fail-send"
CODE_INSIGHTS_MAINTENANCE_SCRIPT="$TMP_ROOT/bin/maintenance-success" \
  "$RUNNER" run > "$TMP_ROOT/recovery-failure.out" 2> "$TMP_ROOT/recovery-failure.err"
recovery_failure_status=$?
rm -f "$TMP_ROOT/fail-send"
set -e
[[ "$recovery_failure_status" -eq 0 ]] \
  || fail 'recovery alert failure changed maintenance exit status'
[[ "$(grep -c '^SEND|' "$SEND_LOG")" -eq 2 ]] \
  || fail 'failed recovery delivery was recorded as sent'

CODE_INSIGHTS_MAINTENANCE_SCRIPT="$TMP_ROOT/bin/maintenance-success" \
  "$RUNNER" run > "$TMP_ROOT/recovery-retry.out" 2> "$TMP_ROOT/recovery-retry.err"
[[ "$(grep -c '^SEND|' "$SEND_LOG")" -eq 3 ]] \
  || fail 'completed tracked campaign recovery was not retried'
grep -Fq 'Code Insights 自动分析已恢复：此前失败的 1 条会话已成功完成。' "$SEND_LOG" \
  || fail 'retried recovery was not based on verified session success'

# An older failed delivery must not block capture of a newer current failure.
# Once TeamTalk recovers, both immutable failures are sent before maintenance
# can turn the newer item into succeeded, followed by its verified recovery.
"$REAL_SQLITE3" "$DB" <<'SQL'
INSERT INTO analysis_campaigns
  (id, provider, model, pipeline_revision, status, total_items)
VALUES
  ('campaign-old-outbox', 'anthropic', 'glm-5.2', 'two-pass-v5', 'active', 1);
INSERT INTO analysis_campaign_items
  (campaign_id, session_id, status, error_code, safe_error)
VALUES
  ('campaign-old-outbox', 'session-old-outbox', 'pending', NULL, NULL);
SQL
export HISTORY_CAMPAIGN_ID=campaign-old-outbox
export HISTORY_SESSION_ID=session-old-outbox
set +e
touch "$TMP_ROOT/fail-send"
"$RUNNER" run > "$TMP_ROOT/old-outbox-failure.out" 2> "$TMP_ROOT/old-outbox-failure.err"
old_outbox_status=$?
rm -f "$TMP_ROOT/fail-send"
set -e
[[ "$old_outbox_status" -eq 0 ]] \
  || fail 'older queued alert changed maintenance exit status'
"$REAL_SQLITE3" "$DB" <<'SQL'
UPDATE analysis_campaigns SET status = 'completed' WHERE id = 'campaign-old-outbox';
INSERT INTO analysis_campaigns
  (id, provider, model, pipeline_revision, status, total_items)
VALUES
  ('campaign-new-behind-outbox', 'anthropic', 'glm-5.2', 'two-pass-v5', 'active', 1);
INSERT INTO analysis_campaign_items
  (campaign_id, session_id, status, error_code, safe_error)
VALUES
  ('campaign-new-behind-outbox', 'session-new-behind-outbox', 'failed', 'AUTHENTICATION', 'private auth detail');
SQL
cat > "$TMP_ROOT/bin/maintenance-resolve-new" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
"$REAL_SQLITE3" "$CODE_INSIGHTS_DB" "
  UPDATE analysis_campaign_items
  SET status = 'succeeded', error_code = NULL, safe_error = NULL
  WHERE campaign_id = 'campaign-new-behind-outbox'
    AND session_id = 'session-new-behind-outbox';
  UPDATE analysis_campaigns
  SET status = 'completed'
  WHERE id = 'campaign-new-behind-outbox';
"
EOF
chmod +x "$TMP_ROOT/bin/maintenance-resolve-new"
send_count_before=$(grep -c '^SEND|' "$SEND_LOG")
CODE_INSIGHTS_MAINTENANCE_SCRIPT="$TMP_ROOT/bin/maintenance-resolve-new" \
  "$RUNNER" run > "$TMP_ROOT/new-behind-outbox.out" 2> "$TMP_ROOT/new-behind-outbox.err"
[[ "$(grep -c '^SEND|' "$SEND_LOG")" -eq "$((send_count_before + 3))" ]] \
  || fail 'older outbox event caused the current failure or recovery to be lost'
grep -Fq '模型服务鉴权失败。' "$SEND_LOG" \
  || fail 'new current failure behind the old outbox kept the wrong cause'

# A first-delivery failure leaves only an outbox event (no open incident yet).
# Even if the campaign completes before the next schedule, the runner must find
# that queued campaign, deliver the immutable failure, then report recovery.
"$REAL_SQLITE3" "$DB" <<'SQL'
INSERT INTO analysis_campaigns
  (id, provider, model, pipeline_revision, status, total_items)
VALUES
  ('campaign-outbox-only', 'anthropic', 'glm-5.2', 'two-pass-v5', 'active', 1);
INSERT INTO analysis_campaign_items
  (campaign_id, session_id, status, error_code, safe_error)
VALUES
  ('campaign-outbox-only', 'session-3', 'pending', NULL, NULL);
SQL
export HISTORY_CAMPAIGN_ID=campaign-outbox-only
export HISTORY_SESSION_ID=session-3
set +e
touch "$TMP_ROOT/fail-send"
"$RUNNER" run > "$TMP_ROOT/outbox-first-failure.out" 2> "$TMP_ROOT/outbox-first-failure.err"
outbox_first_failure_status=$?
rm -f "$TMP_ROOT/fail-send"
set -e
[[ "$outbox_first_failure_status" -eq 0 ]] \
  || fail 'first alert delivery failure changed maintenance exit status'
send_count_before=$(grep -c '^SEND|' "$SEND_LOG")
"$REAL_SQLITE3" "$DB" "
  UPDATE analysis_campaign_items
  SET status = 'succeeded', error_code = NULL, safe_error = NULL
  WHERE campaign_id = 'campaign-outbox-only' AND session_id = 'session-3';
  UPDATE analysis_campaigns
  SET status = 'completed'
  WHERE id = 'campaign-outbox-only';
"
CODE_INSIGHTS_MAINTENANCE_SCRIPT="$TMP_ROOT/bin/maintenance-success" \
  "$RUNNER" run > "$TMP_ROOT/outbox-after-completion.out" 2> "$TMP_ROOT/outbox-after-completion.err"
[[ "$(grep -c '^SEND|' "$SEND_LOG")" -eq "$((send_count_before + 2))" ]] \
  || fail 'outbox-only campaign was lost after completing before retry'
recent_sends=$(grep '^SEND|' "$SEND_LOG" | tail -2)
grep -Fq 'Code Insights 自动分析失败：当前任务发现 1 条失败。' <<< "$recent_sends" \
  || fail 'queued failure was not delivered after completion'
grep -Fq 'Code Insights 自动分析已恢复：此前失败的 1 条会话已成功完成。' <<< "$recent_sends" \
  || fail 'queued failure recovery was not delivered after completion'

# Signals are also forwarded while either the pre- or post-maintenance alert
# subprocess is active. No alert child or private output file may be left.
"$REAL_SQLITE3" "$DB" <<'SQL'
INSERT INTO analysis_campaigns
  (id, provider, model, pipeline_revision, status, total_items)
VALUES
  ('campaign-signal', 'anthropic', 'glm-5.2', 'two-pass-v5', 'active', 1);
INSERT INTO analysis_campaign_items
  (campaign_id, session_id, status, error_code, safe_error)
VALUES
  ('campaign-signal', 'session-signal', 'pending', NULL, NULL);
SQL
cat > "$TMP_ROOT/bin/slow-alert.mjs" <<'EOF'
#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const callFile = process.env.ALERT_CALL_FILE;
const pidFile = process.env.ALERT_CHILD_PID_FILE;
const stopAfter = Number(process.env.SLOW_ALERT_AFTER_CALL || '1');
const calls = existsSync(callFile) ? Number(readFileSync(callFile, 'utf8')) + 1 : 1;
writeFileSync(callFile, `${calls}\n`);
if (calls < stopAfter) {
  process.stdout.write('{"success":true,"action":"no_change"}\n');
} else {
  writeFileSync(pidFile, `${process.pid}\n`);
  process.once('SIGINT', () => process.exit(130));
  process.once('SIGTERM', () => process.exit(143));
  setInterval(() => {}, 1_000);
}
EOF
cat > "$TMP_ROOT/bin/maintenance-marker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
touch "$SIGNAL_MAINTENANCE_MARKER"
EOF
chmod +x "$TMP_ROOT/bin/slow-alert.mjs" "$TMP_ROOT/bin/maintenance-marker"

for alert_phase in pre post; do
  alert_call_file="$TMP_ROOT/alert-$alert_phase.calls"
  alert_pid_file="$TMP_ROOT/alert-$alert_phase.pid"
  maintenance_marker="$TMP_ROOT/maintenance-$alert_phase.started"
  slow_after_call=1
  [[ "$alert_phase" == 'pre' ]] || slow_after_call=2
  set -m
  ALERT_CALL_FILE="$alert_call_file" \
    ALERT_CHILD_PID_FILE="$alert_pid_file" \
    SLOW_ALERT_AFTER_CALL="$slow_after_call" \
    SIGNAL_MAINTENANCE_MARKER="$maintenance_marker" \
    CODE_INSIGHTS_ALERT_SCRIPT="$TMP_ROOT/bin/slow-alert.mjs" \
    CODE_INSIGHTS_MAINTENANCE_SCRIPT="$TMP_ROOT/bin/maintenance-marker" \
    "$RUNNER" run > "$TMP_ROOT/alert-signal-$alert_phase.out" \
      2> "$TMP_ROOT/alert-signal-$alert_phase.err" &
  runner_pid=$!
  set +m
  for _ in {1..100}; do
    [[ -f "$alert_pid_file" ]] && break
    sleep 0.02
  done
  [[ -f "$alert_pid_file" ]] || fail "$alert_phase alert child did not start"
  read -r alert_child_pid < "$alert_pid_file"
  kill -TERM "$runner_pid"
  set +e
  wait "$runner_pid"
  alert_signal_status=$?
  set -e
  [[ "$alert_signal_status" -eq 143 ]] \
    || fail "expected TERM status 143 during $alert_phase alert, got $alert_signal_status"
  if kill -0 "$alert_child_pid" 2>/dev/null; then
    fail "TERM left the $alert_phase alert child running"
  fi
  if [[ "$alert_phase" == 'pre' && -e "$maintenance_marker" ]]; then
    fail 'maintenance started after the pre-alert received TERM'
  fi
  if [[ "$alert_phase" == 'post' && ! -e "$maintenance_marker" ]]; then
    fail 'post-alert signal test never completed maintenance'
  fi
  if compgen -G "$HOME/.code-insights/.analysis-alert-output.*" > /dev/null; then
    fail "$alert_phase alert left a private output file behind"
  fi
done

# The wrapper forwards both supported signals even though maintenance runs as
# an asynchronous child, and preserves the conventional shell exit codes.
cat > "$TMP_ROOT/bin/maintenance-signal" <<'EOF'
#!/usr/bin/env bash
set -u
printf '%s\n' "$$" > "$SIGNAL_CHILD_PID_FILE"
trap 'exit 130' INT
trap 'exit 143' TERM
while :; do sleep 0.1; done
EOF
chmod +x "$TMP_ROOT/bin/maintenance-signal"
for signal in INT TERM; do
  signal_pid_file="$TMP_ROOT/signal-$signal.pid"
  expected_signal_status=130
  [[ "$signal" == 'INT' ]] || expected_signal_status=143
  set -m
  SIGNAL_CHILD_PID_FILE="$signal_pid_file" \
    CODE_INSIGHTS_MAINTENANCE_SCRIPT="$TMP_ROOT/bin/maintenance-signal" \
    "$RUNNER" run > "$TMP_ROOT/signal-$signal.out" 2> "$TMP_ROOT/signal-$signal.err" &
  runner_pid=$!
  set +m
  for _ in {1..100}; do
    [[ -f "$signal_pid_file" ]] && break
    sleep 0.02
  done
  [[ -f "$signal_pid_file" ]] || fail "$signal maintenance child did not start"
  read -r signal_child_pid < "$signal_pid_file"
  kill "-$signal" "$runner_pid"
  set +e
  wait "$runner_pid"
  runner_signal_status=$?
  set -e
  [[ "$runner_signal_status" -eq "$expected_signal_status" ]] \
    || fail "expected $signal status $expected_signal_status, got $runner_signal_status"
  if kill -0 "$signal_child_pid" 2>/dev/null; then
    fail "$signal left the maintenance child running"
  fi
done

printf 'maintenance alert integration tests passed\n'
