#!/usr/bin/env bash

set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
SCRIPT="$ROOT/automation/code-insights-analysis-alert.mjs"
SQLITE_BIN=$(command -v sqlite3)
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/code-insights-analysis-alert-test.XXXXXX")
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

DB="$TMP_ROOT/data.db"
STATE="$TMP_ROOT/analysis-alert-state.json"
CONFIG="$TMP_ROOT/analysis-alert.json"
SEND_LOG="$TMP_ROOT/send.log"
SENDER="$TMP_ROOT/fake-tt-send.mjs"

"$SQLITE_BIN" "$DB" <<'SQL'
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
SQL

cat > "$SENDER" <<'EOF'
#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const sendLog = fileURLToPath(new URL('./send.log', import.meta.url));
const failSend = fileURLToPath(new URL('./fail-send', import.meta.url));
if (process.env.PRIVATE_MODEL_TOKEN !== undefined) {
  process.stdout.write('{"success":false,"error":"ambient secret reached sender"}\n');
  process.exitCode = 1;
  process.exit();
}
if (args[0] === '--config-paths') {
  process.stdout.write('{"success":true}\n');
} else if (args[0] === '--check') {
  process.stdout.write('{"success":true,"configured":true}\n');
} else {
  const offset = args[0] === '--dry-run' ? 1 : 0;
  if (args.length !== offset + 2 || args[offset].startsWith('--')) {
    process.stdout.write('{"success":false,"error":"invalid positional send contract"}\n');
    process.exitCode = 1;
    process.exit();
  }
  const target = args[offset];
  const message = args[offset + 1];
  if (args[0] === '--dry-run') {
    appendFileSync(
      sendLog,
      `DRY|${process.env.CODE_INSIGHTS_ALERT_EVENT_ID}|${target}|${message}\n`,
    );
    process.stdout.write('{"success":true,"dryRun":true}\n');
    process.exit();
  }
  if (existsSync(failSend)) {
    const messageHash = createHash('sha256').update(message).digest('hex');
    appendFileSync(
      sendLog,
      `ATTEMPT|${process.env.CODE_INSIGHTS_ALERT_EVENT_ID}|${messageHash}|failed\n`,
    );
    appendFileSync(
      sendLog,
      `FAIL|${process.env.CODE_INSIGHTS_ALERT_EVENT_ID}\n`,
    );
    process.stdout.write('{"success":false,"recipient":"PRIVATE_RECIPIENT","error":"PRIVATE_TOKEN"}\n');
    process.exitCode = 1;
    process.exit();
  }
  const messageHash = createHash('sha256').update(message).digest('hex');
  appendFileSync(
    sendLog,
    `ATTEMPT|${process.env.CODE_INSIGHTS_ALERT_EVENT_ID}|${messageHash}|sent\n`,
  );
  appendFileSync(
    sendLog,
    `SEND|${process.env.CODE_INSIGHTS_ALERT_EVENT_ID}|${target}|${message}\n`,
  );
  process.stdout.write('{"success":true,"messageIds":["test-message"]}\n');
}
EOF
chmod +x "$SENDER"

printf '%s\n' \
  "{\"version\":1,\"enabled\":true,\"target\":\"Test Contact\",\"senderScript\":\"$SENDER\"}" \
  > "$CONFIG"
chmod 600 "$CONFIG"

run_alert() {
  local name=$1
  shift
  PRIVATE_MODEL_TOKEN='must-not-reach-sender' node "$SCRIPT" evaluate \
    --db "$DB" \
    --sqlite-bin "$SQLITE_BIN" \
    --state "$STATE" \
    --config "$CONFIG" \
    --campaign-id "${CAMPAIGN_ID:-campaign-1}" \
    "$@" \
    > "$TMP_ROOT/$name.out"
}

"$SQLITE_BIN" "$DB" <<'SQL'
INSERT INTO analysis_campaigns
  (id, provider, model, pipeline_revision, status, total_items)
VALUES
  ('campaign-1', 'anthropic', 'glm-5.2', 'two-pass-v5', 'active', 2);
INSERT INTO analysis_campaign_items
  (campaign_id, session_id, status, error_code, safe_error)
VALUES
  ('campaign-1', 'session-failed', 'failed', 'INVALID_MODEL_OUTPUT', 'private raw detail'),
  ('campaign-1', 'session-pending', 'pending', NULL, NULL);
SQL

run_alert detected

[[ "$(grep -c '^SEND|' "$SEND_LOG")" -eq 1 ]] \
  || fail 'current campaign failure did not send exactly one notification'
grep -Fq '|Test Contact|Code Insights 自动分析失败：当前任务发现 1 条失败。' "$SEND_LOG" \
  || fail 'detected notification was not concise and factual'
grep -Fq '模型返回的结构化结果在自动重试后仍无法解析。' "$SEND_LOG" \
  || fail 'detected notification omitted the confirmed error-code cause'
if grep -Fq 'private raw detail' "$SEND_LOG"; then
  fail 'notification leaked safe_error detail'
fi
if grep -Fq '凭证' "$SEND_LOG"; then
  fail 'notification speculated about credentials'
fi

# Re-observing the same failed session in a later process does not duplicate
# the already delivered incident.
run_alert detected-again
[[ "$(grep -c '^SEND|' "$SEND_LOG")" -eq 1 ]] \
  || fail 'the same campaign failure was sent more than once'

# A retry first moves the failed item through pending/session_staged. Neither
# state is proof of recovery, even though the campaign's failed count is zero.
"$SQLITE_BIN" "$DB" "
  UPDATE analysis_campaign_items
  SET status = 'pending', error_code = NULL, safe_error = NULL
  WHERE campaign_id = 'campaign-1' AND session_id = 'session-failed';
"
run_alert retry-pending
"$SQLITE_BIN" "$DB" "
  UPDATE analysis_campaign_items
  SET status = 'session_staged'
  WHERE campaign_id = 'campaign-1' AND session_id = 'session-failed';
"
run_alert retry-staged
[[ "$(grep -c '^SEND|' "$SEND_LOG")" -eq 1 ]] \
  || fail 'pending or staged retry was falsely reported as recovered'

# Recovery is emitted only after the exact affected session succeeds, and the
# recovery event is also durable across later processes.
"$SQLITE_BIN" "$DB" "
  UPDATE analysis_campaign_items
  SET status = 'succeeded'
  WHERE campaign_id = 'campaign-1' AND session_id = 'session-failed';
"
run_alert recovered
[[ "$(grep -c '^SEND|' "$SEND_LOG")" -eq 2 ]] \
  || fail 'successful retry did not send exactly one recovery notification'
grep -Fq '|Test Contact|Code Insights 自动分析已恢复：此前失败的 1 条会话已成功完成。' "$SEND_LOG" \
  || fail 'recovery notification did not describe the verified session success'
run_alert recovered-again
[[ "$(grep -c '^SEND|' "$SEND_LOG")" -eq 2 ]] \
  || fail 'verified recovery was sent more than once'

# Historical cancelled failures are never treated as current. A healthy
# replacement campaign also does not inherit or report those old failures.
"$SQLITE_BIN" "$DB" <<'SQL'
INSERT INTO analysis_campaigns
  (id, provider, model, pipeline_revision, status, total_items)
VALUES
  ('campaign-old', 'anthropic', 'glm-5.2', 'two-pass-v3', 'cancelled', 1),
  ('campaign-2', 'anthropic', 'glm-5.2', 'two-pass-v5', 'active', 1);
INSERT INTO analysis_campaign_items
  (campaign_id, session_id, status, error_code, safe_error)
VALUES
  ('campaign-old', 'old-failure', 'failed', 'ANALYSIS_FAILED', 'historical detail'),
  ('campaign-2', 'current-pending', 'pending', NULL, NULL);
SQL
CAMPAIGN_ID=campaign-old run_alert cancelled-history
CAMPAIGN_ID=campaign-2 run_alert healthy-current
[[ "$(grep -c '^SEND|' "$SEND_LOG")" -eq 2 ]] \
  || fail 'cancelled history or healthy current campaign triggered an alert'

# Replacing a failed campaign is not itself recovery. If the replacement does
# not contain the affected session, the old incident closes silently.
"$SQLITE_BIN" "$DB" <<'SQL'
UPDATE analysis_campaigns SET status = 'completed' WHERE id = 'campaign-2';
INSERT INTO analysis_campaigns
  (id, provider, model, pipeline_revision, status, total_items)
VALUES
  ('campaign-3', 'anthropic', 'glm-5.2', 'two-pass-v5', 'active', 1);
INSERT INTO analysis_campaign_items
  (campaign_id, session_id, status, error_code, safe_error)
VALUES
  ('campaign-3', 'superseded-failure', 'failed', 'INVALID_MODEL_OUTPUT', 'detail');
SQL
CAMPAIGN_ID=campaign-3 run_alert before-replacement
[[ "$(grep -c '^SEND|' "$SEND_LOG")" -eq 3 ]] \
  || fail 'replacement scenario did not establish its original incident'
"$SQLITE_BIN" "$DB" <<'SQL'
UPDATE analysis_campaigns SET status = 'cancelled' WHERE id = 'campaign-3';
INSERT INTO analysis_campaigns
  (id, provider, model, pipeline_revision, status, total_items)
VALUES
  ('campaign-4', 'anthropic', 'glm-5.2', 'two-pass-v5', 'active', 1);
INSERT INTO analysis_campaign_items
  (campaign_id, session_id, status, error_code, safe_error)
VALUES
  ('campaign-4', 'different-session', 'pending', NULL, NULL);
SQL
CAMPAIGN_ID=campaign-4 run_alert replacement-missing-session
[[ "$(grep -c '^SEND|' "$SEND_LOG")" -eq 3 ]] \
  || fail 'campaign replacement was falsely reported as recovery'

# Delivery failure is best-effort for maintenance but not for the alert
# cursor. The same deterministic event is retried after the sender recovers,
# and private sender output is never copied into the alert process output.
"$SQLITE_BIN" "$DB" <<'SQL'
UPDATE analysis_campaigns SET status = 'completed' WHERE id = 'campaign-4';
INSERT INTO analysis_campaigns
  (id, provider, model, pipeline_revision, status, total_items)
VALUES
  ('campaign-5', 'anthropic', 'glm-5.2', 'two-pass-v5', 'active', 1);
INSERT INTO analysis_campaign_items
  (campaign_id, session_id, status, error_code, safe_error)
VALUES
  ('campaign-5', 'delivery-retry', 'failed', 'RATE_LIMIT', 'private provider body');
SQL
set +e
touch "$TMP_ROOT/fail-send"
CAMPAIGN_ID=campaign-5 run_alert sender-failed 2> "$TMP_ROOT/sender-failed.err"
sender_failure_status=$?
rm -f "$TMP_ROOT/fail-send"
set -e
[[ "$sender_failure_status" -eq 75 ]] \
  || fail "expected sender failure status 75, got $sender_failure_status"
if grep -Eq 'PRIVATE_RECIPIENT|PRIVATE_TOKEN|private provider body' \
  "$TMP_ROOT/sender-failed.out" "$TMP_ROOT/sender-failed.err"; then
  fail 'sender failure leaked private output'
fi
failed_event_id=$(awk -F'|' '$1 == "FAIL" {print $2}' "$SEND_LOG" | tail -1)
[[ -n "$failed_event_id" ]] || fail 'sender failure did not expose a test event id'
"$SQLITE_BIN" "$DB" "
  INSERT INTO analysis_campaign_items
    (campaign_id, session_id, status, error_code, safe_error)
  VALUES
    ('campaign-5', 'delivery-new-failure', 'failed', 'AUTHENTICATION', 'private auth detail');
  UPDATE analysis_campaign_items
  SET status = 'succeeded', error_code = NULL, safe_error = NULL
  WHERE campaign_id = 'campaign-5' AND session_id = 'delivery-retry';
"
CAMPAIGN_ID=campaign-5 run_alert sender-recovered
[[ "$(grep -c '^SEND|' "$SEND_LOG")" -eq 6 ]] \
  || fail 'queued failures and verified recovery were not drained in order'
retried_event_id=$(awk -F'|' -v id="$failed_event_id" \
  '$1 == "SEND" && $2 == id {print $2}' "$SEND_LOG" | tail -1)
[[ "$retried_event_id" == "$failed_event_id" ]] \
  || fail 'failed delivery changed event id before retry'
failed_message_hash=$(awk -F'|' -v id="$failed_event_id" \
  '$1 == "ATTEMPT" && $2 == id && $4 == "failed" {print $3}' "$SEND_LOG" | tail -1)
retried_message_hash=$(awk -F'|' -v id="$failed_event_id" \
  '$1 == "ATTEMPT" && $2 == id && $4 == "sent" {print $3}' "$SEND_LOG" | tail -1)
[[ "$retried_message_hash" == "$failed_message_hash" ]] \
  || fail 'new database state changed an already queued alert payload'
grep -Fq '模型服务鉴权失败。' "$SEND_LOG" \
  || fail 'a newly confirmed failure was not captured behind the queued event'
grep -Fq 'Code Insights 自动分析已恢复：此前失败的 1 条会话已成功完成。' \
  "$SEND_LOG" \
  || fail 'a delivered historical failure was not followed by verified recovery'
CAMPAIGN_ID=campaign-5 run_alert new-failure-after-delivery
[[ "$(grep -c '^SEND|' "$SEND_LOG")" -eq 6 ]] \
  || fail 'a delivered second failure was duplicated'
"$SQLITE_BIN" "$DB" "
  UPDATE analysis_campaign_items
  SET status = 'succeeded', error_code = NULL, safe_error = NULL
  WHERE campaign_id = 'campaign-5' AND session_id = 'delivery-new-failure';
"
CAMPAIGN_ID=campaign-5 run_alert recovered-after-delivery
[[ "$(grep -c '^SEND|' "$SEND_LOG")" -eq 7 ]] \
  || fail 'late delivered incidents did not retain a recovery follow-up'

# Dry-run exercises the recipient adapter without sending or advancing the
# delivery cursor. The later real send keeps the same event id.
"$SQLITE_BIN" "$DB" <<'SQL'
UPDATE analysis_campaigns SET status = 'cancelled' WHERE id = 'campaign-5';
INSERT INTO analysis_campaigns
  (id, provider, model, pipeline_revision, status, total_items)
VALUES
  ('campaign-6', 'anthropic', 'glm-5.2', 'two-pass-v5', 'active', 1);
INSERT INTO analysis_campaign_items
  (campaign_id, session_id, status, error_code, safe_error)
VALUES
  ('campaign-6', 'dry-run-failure', 'failed', 'ANALYSIS_FAILED', 'private detail');
SQL
state_before_dry_run=$(cksum < "$STATE")
CAMPAIGN_ID=campaign-6 run_alert preview --dry-run
[[ "$(cksum < "$STATE")" == "$state_before_dry_run" ]] \
  || fail 'dry-run changed the alert delivery cursor'
dry_run_event_id=$(awk -F'|' '$1 == "DRY" {print $2}' "$SEND_LOG" | tail -1)
[[ -n "$dry_run_event_id" ]] || fail 'dry-run did not exercise the sender adapter'
CAMPAIGN_ID=campaign-6 run_alert after-preview
actual_event_id=$(awk -F'|' '$1 == "SEND" {print $2}' "$SEND_LOG" | tail -1)
[[ "$actual_event_id" == "$dry_run_event_id" ]] \
  || fail 'dry-run and real delivery used different event ids'

# Cancelling an origin campaign closes its open incident silently. A later
# campaign may alert on the same session ID again.
send_count_before=$(grep -c '^SEND|' "$SEND_LOG")
"$SQLITE_BIN" "$DB" "UPDATE analysis_campaigns SET status = 'cancelled' WHERE id = 'campaign-6';"
CAMPAIGN_ID=campaign-6 run_alert cancelled-origin
[[ "$(grep -c '^SEND|' "$SEND_LOG")" -eq "$send_count_before" ]] \
  || fail 'cancelled origin campaign emitted a false recovery'
"$SQLITE_BIN" "$DB" <<'SQL'
INSERT INTO analysis_campaigns
  (id, provider, model, pipeline_revision, status, total_items)
VALUES
  ('campaign-7', 'anthropic', 'glm-5.2', 'two-pass-v5', 'active', 1);
INSERT INTO analysis_campaign_items
  (campaign_id, session_id, status, error_code, safe_error)
VALUES
  ('campaign-7', 'dry-run-failure', 'failed', 'RATE_LIMIT', 'private detail');
SQL
CAMPAIGN_ID=campaign-7 run_alert same-session-after-cancel
[[ "$(grep -c '^SEND|' "$SEND_LOG")" -eq "$((send_count_before + 1))" ]] \
  || fail 'cancelled incident permanently covered a later campaign failure'

# A resolved historical incident also cannot suppress the same session ID in a
# new current campaign.
"$SQLITE_BIN" "$DB" <<'SQL'
UPDATE analysis_campaigns SET status = 'cancelled' WHERE id = 'campaign-7';
INSERT INTO analysis_campaigns
  (id, provider, model, pipeline_revision, status, total_items)
VALUES
  ('campaign-8', 'anthropic', 'glm-5.2', 'two-pass-v5', 'active', 1);
INSERT INTO analysis_campaign_items
  (campaign_id, session_id, status, error_code, safe_error)
VALUES
  ('campaign-8', 'session-failed', 'failed', 'INVALID_MODEL_OUTPUT', 'private detail');
SQL
send_count_before=$(grep -c '^SEND|' "$SEND_LOG")
CAMPAIGN_ID=campaign-8 run_alert same-session-after-resolution
[[ "$(grep -c '^SEND|' "$SEND_LOG")" -eq "$((send_count_before + 1))" ]] \
  || fail 'resolved historical incident suppressed a new campaign failure'

# If a replacement campaign contains the same still-failing session, the old
# incident is superseded and the new current campaign gets its own alert.
"$SQLITE_BIN" "$DB" <<'SQL'
UPDATE analysis_campaigns SET status = 'completed' WHERE id = 'campaign-8';
INSERT INTO analysis_campaigns
  (id, provider, model, pipeline_revision, status, total_items)
VALUES
  ('campaign-9', 'anthropic', 'glm-5.2', 'two-pass-v5', 'active', 1);
INSERT INTO analysis_campaign_items
  (campaign_id, session_id, status, error_code, safe_error)
VALUES
  ('campaign-9', 'replacement-repeat', 'failed', 'ANALYSIS_FAILED', 'private detail');
SQL
CAMPAIGN_ID=campaign-9 run_alert before-same-session-replacement
"$SQLITE_BIN" "$DB" <<'SQL'
UPDATE analysis_campaigns SET status = 'cancelled' WHERE id = 'campaign-9';
INSERT INTO analysis_campaigns
  (id, provider, model, pipeline_revision, status, total_items)
VALUES
  ('campaign-10', 'anthropic', 'glm-5.2', 'two-pass-v5', 'active', 1);
INSERT INTO analysis_campaign_items
  (campaign_id, session_id, status, error_code, safe_error)
VALUES
  ('campaign-10', 'replacement-repeat', 'failed', 'AUTHENTICATION', 'private detail');
SQL
send_count_before=$(grep -c '^SEND|' "$SEND_LOG")
CAMPAIGN_ID=campaign-10 run_alert same-session-replacement
[[ "$(grep -c '^SEND|' "$SEND_LOG")" -eq "$((send_count_before + 1))" ]] \
  || fail 'open historical incident suppressed the replacement campaign failure'

# Reset/deletion closes only the tracked missing campaign. The same session can
# still produce a new alert in a future current campaign.
"$SQLITE_BIN" "$DB" <<'SQL'
UPDATE analysis_campaigns SET status = 'completed' WHERE id = 'campaign-10';
INSERT INTO analysis_campaigns
  (id, provider, model, pipeline_revision, status, total_items)
VALUES
  ('campaign-11', 'anthropic', 'glm-5.2', 'two-pass-v5', 'active', 1);
INSERT INTO analysis_campaign_items
  (campaign_id, session_id, status, error_code, safe_error)
VALUES
  ('campaign-11', 'reset-repeat', 'failed', 'ANALYSIS_FAILED', 'private detail');
SQL
CAMPAIGN_ID=campaign-11 run_alert before-reset
"$SQLITE_BIN" "$DB" "
  DELETE FROM analysis_campaign_items WHERE campaign_id = 'campaign-11';
  DELETE FROM analysis_campaigns WHERE id = 'campaign-11';
"
send_count_before=$(grep -c '^SEND|' "$SEND_LOG")
CAMPAIGN_ID=campaign-11 run_alert missing-after-reset
[[ "$(grep -c '^SEND|' "$SEND_LOG")" -eq "$send_count_before" ]] \
  || fail 'missing tracked campaign emitted an alert'
"$SQLITE_BIN" "$DB" <<'SQL'
INSERT INTO analysis_campaigns
  (id, provider, model, pipeline_revision, status, total_items)
VALUES
  ('campaign-12', 'anthropic', 'glm-5.2', 'two-pass-v5', 'active', 1);
INSERT INTO analysis_campaign_items
  (campaign_id, session_id, status, error_code, safe_error)
VALUES
  ('campaign-12', 'reset-repeat', 'failed', 'RATE_LIMIT', 'private detail');
SQL
CAMPAIGN_ID=campaign-12 run_alert same-session-after-reset
[[ "$(grep -c '^SEND|' "$SEND_LOG")" -eq "$((send_count_before + 1))" ]] \
  || fail 'missing historical campaign permanently covered a future failure'

# A retry that fails again for a different confirmed reason creates one fresh
# factual alert. Repeating the same new reason remains deduplicated.
send_count_before=$(grep -c '^SEND|' "$SEND_LOG")
auth_cause_count_before=$(grep -c '模型服务鉴权失败。' "$SEND_LOG")
"$SQLITE_BIN" "$DB" "
  UPDATE analysis_campaign_items
  SET status = 'pending', error_code = NULL, safe_error = NULL
  WHERE campaign_id = 'campaign-12' AND session_id = 'reset-repeat';
"
CAMPAIGN_ID=campaign-12 run_alert changed-reason-pending
[[ "$(grep -c '^SEND|' "$SEND_LOG")" -eq "$send_count_before" ]] \
  || fail 'pending retry was falsely reported as a new failure reason'
"$SQLITE_BIN" "$DB" "
  UPDATE analysis_campaign_items
  SET status = 'failed', error_code = 'AUTHENTICATION', safe_error = 'private detail'
  WHERE campaign_id = 'campaign-12' AND session_id = 'reset-repeat';
"
CAMPAIGN_ID=campaign-12 run_alert changed-reason-failed
[[ "$(grep -c '^SEND|' "$SEND_LOG")" -eq "$((send_count_before + 1))" ]] \
  || fail 'a changed confirmed failure reason did not create one fresh alert'
[[ "$(grep -c '模型服务鉴权失败。' "$SEND_LOG")" -eq "$((auth_cause_count_before + 1))" ]] \
  || fail 'the changed failure alert kept the stale cause'
CAMPAIGN_ID=campaign-12 run_alert changed-reason-again
[[ "$(grep -c '^SEND|' "$SEND_LOG")" -eq "$((send_count_before + 1))" ]] \
  || fail 'the changed confirmed failure reason was sent more than once'
"$SQLITE_BIN" "$DB" "
  UPDATE analysis_campaign_items
  SET status = 'succeeded', error_code = NULL, safe_error = NULL
  WHERE campaign_id = 'campaign-12' AND session_id = 'reset-repeat';
"
CAMPAIGN_ID=campaign-12 run_alert changed-reason-recovered
[[ "$(grep -c '^SEND|' "$SEND_LOG")" -eq "$((send_count_before + 2))" ]] \
  || fail 'the changed failure incident did not recover exactly once'

# A queued failure is revalidated against its own origin campaign. Cancelling
# that origin while a new campaign is current discards only the stale event.
"$SQLITE_BIN" "$DB" <<'SQL'
UPDATE analysis_campaigns SET status = 'completed' WHERE id = 'campaign-12';
INSERT INTO analysis_campaigns
  (id, provider, model, pipeline_revision, status, total_items)
VALUES
  ('campaign-13', 'anthropic', 'glm-5.2', 'two-pass-v5', 'active', 1);
INSERT INTO analysis_campaign_items
  (campaign_id, session_id, status, error_code, safe_error)
VALUES
  ('campaign-13', 'cancelled-queued', 'failed', 'RATE_LIMIT', 'private detail');
SQL
set +e
touch "$TMP_ROOT/fail-send"
CAMPAIGN_ID=campaign-13 run_alert queue-before-cancel 2> "$TMP_ROOT/queue-before-cancel.err"
queue_before_cancel_status=$?
rm -f "$TMP_ROOT/fail-send"
set -e
[[ "$queue_before_cancel_status" -eq 75 ]] \
  || fail 'cancelled-origin setup did not leave a queued event'
"$SQLITE_BIN" "$DB" <<'SQL'
UPDATE analysis_campaigns SET status = 'cancelled' WHERE id = 'campaign-13';
INSERT INTO analysis_campaigns
  (id, provider, model, pipeline_revision, status, total_items)
VALUES
  ('campaign-14', 'anthropic', 'glm-5.2', 'two-pass-v5', 'active', 1);
INSERT INTO analysis_campaign_items
  (campaign_id, session_id, status, error_code, safe_error)
VALUES
  ('campaign-14', 'current-after-cancel', 'failed', 'AUTHENTICATION', 'private detail');
SQL
send_count_before=$(grep -c '^SEND|' "$SEND_LOG")
rate_cause_count_before=$(grep -c '模型服务触发限流。' "$SEND_LOG")
CAMPAIGN_ID=campaign-14 run_alert current-after-cancelled-outbox
[[ "$(grep -c '^SEND|' "$SEND_LOG")" -eq "$((send_count_before + 1))" ]] \
  || fail 'cancelled old outbox blocked the new current failure'
[[ "$(grep -c '模型服务触发限流。' "$SEND_LOG")" -eq "$rate_cause_count_before" ]] \
  || fail 'queued failure was sent after its origin campaign was cancelled'

# Deleting the queued event's origin (for example after reset) is handled the
# same way and cannot suppress the next current campaign.
"$SQLITE_BIN" "$DB" <<'SQL'
UPDATE analysis_campaigns SET status = 'completed' WHERE id = 'campaign-14';
INSERT INTO analysis_campaigns
  (id, provider, model, pipeline_revision, status, total_items)
VALUES
  ('campaign-15', 'anthropic', 'glm-5.2', 'two-pass-v5', 'active', 1);
INSERT INTO analysis_campaign_items
  (campaign_id, session_id, status, error_code, safe_error)
VALUES
  ('campaign-15', 'deleted-queued', 'failed', 'RATE_LIMIT', 'private detail');
SQL
set +e
touch "$TMP_ROOT/fail-send"
CAMPAIGN_ID=campaign-15 run_alert queue-before-delete 2> "$TMP_ROOT/queue-before-delete.err"
queue_before_delete_status=$?
rm -f "$TMP_ROOT/fail-send"
set -e
[[ "$queue_before_delete_status" -eq 75 ]] \
  || fail 'deleted-origin setup did not leave a queued event'
"$SQLITE_BIN" "$DB" <<'SQL'
DELETE FROM analysis_campaign_items WHERE campaign_id = 'campaign-15';
DELETE FROM analysis_campaigns WHERE id = 'campaign-15';
INSERT INTO analysis_campaigns
  (id, provider, model, pipeline_revision, status, total_items)
VALUES
  ('campaign-16', 'anthropic', 'glm-5.2', 'two-pass-v5', 'active', 1);
INSERT INTO analysis_campaign_items
  (campaign_id, session_id, status, error_code, safe_error)
VALUES
  ('campaign-16', 'current-after-delete', 'failed', 'AUTHENTICATION', 'private detail');
SQL
send_count_before=$(grep -c '^SEND|' "$SEND_LOG")
rate_cause_count_before=$(grep -c '模型服务触发限流。' "$SEND_LOG")
CAMPAIGN_ID=campaign-16 run_alert current-after-deleted-outbox
[[ "$(grep -c '^SEND|' "$SEND_LOG")" -eq "$((send_count_before + 1))" ]] \
  || fail 'deleted old outbox blocked the new current failure'
[[ "$(grep -c '模型服务触发限流。' "$SEND_LOG")" -eq "$rate_cause_count_before" ]] \
  || fail 'queued failure was sent after its origin campaign was deleted'

# A queued recovery is only sent while the exact session is still succeeded.
# If it fails again before transport recovers, the stale recovery is discarded.
"$SQLITE_BIN" "$DB" <<'SQL'
UPDATE analysis_campaigns SET status = 'completed' WHERE id = 'campaign-16';
INSERT INTO analysis_campaigns
  (id, provider, model, pipeline_revision, status, total_items)
VALUES
  ('campaign-17', 'anthropic', 'glm-5.2', 'two-pass-v5', 'active', 1);
INSERT INTO analysis_campaign_items
  (campaign_id, session_id, status, error_code, safe_error)
VALUES
  ('campaign-17', 'stale-recovery', 'failed', 'RATE_LIMIT', 'private detail');
SQL
CAMPAIGN_ID=campaign-17 run_alert stale-recovery-detected
"$SQLITE_BIN" "$DB" "
  UPDATE analysis_campaign_items
  SET status = 'succeeded', error_code = NULL, safe_error = NULL
  WHERE campaign_id = 'campaign-17' AND session_id = 'stale-recovery';
"
set +e
touch "$TMP_ROOT/fail-send"
CAMPAIGN_ID=campaign-17 run_alert stale-recovery-queued 2> "$TMP_ROOT/stale-recovery-queued.err"
stale_recovery_queue_status=$?
rm -f "$TMP_ROOT/fail-send"
set -e
[[ "$stale_recovery_queue_status" -eq 75 ]] \
  || fail 'stale-recovery setup did not leave a queued recovery'
"$SQLITE_BIN" "$DB" "
  UPDATE analysis_campaign_items
  SET status = 'failed', error_code = 'RATE_LIMIT', safe_error = 'private detail'
  WHERE campaign_id = 'campaign-17' AND session_id = 'stale-recovery';
"
send_count_before=$(grep -c '^SEND|' "$SEND_LOG")
recovery_count_before=$(grep -c 'Code Insights 自动分析已恢复' "$SEND_LOG")
CAMPAIGN_ID=campaign-17 run_alert stale-recovery-rejected
[[ "$(grep -c '^SEND|' "$SEND_LOG")" -eq "$send_count_before" ]] \
  || fail 'stale queued recovery was sent after the session failed again'
[[ "$(grep -c 'Code Insights 自动分析已恢复' "$SEND_LOG")" -eq "$recovery_count_before" ]] \
  || fail 'stale recovery text escaped revalidation'
"$SQLITE_BIN" "$DB" "
  UPDATE analysis_campaign_items
  SET status = 'succeeded', error_code = NULL, safe_error = NULL
  WHERE campaign_id = 'campaign-17' AND session_id = 'stale-recovery';
"
CAMPAIGN_ID=campaign-17 run_alert stale-recovery-eventual-success
[[ "$(grep -c '^SEND|' "$SEND_LOG")" -eq "$((send_count_before + 1))" ]] \
  || fail 'discarding stale recovery lost the later verified recovery'

# Success in a replacement campaign is not proof that the original campaign's
# incident recovered; the historical incident closes silently.
"$SQLITE_BIN" "$DB" <<'SQL'
UPDATE analysis_campaigns SET status = 'completed' WHERE id = 'campaign-17';
INSERT INTO analysis_campaigns
  (id, provider, model, pipeline_revision, status, total_items)
VALUES
  ('campaign-18', 'anthropic', 'glm-5.2', 'two-pass-v5', 'active', 1);
INSERT INTO analysis_campaign_items
  (campaign_id, session_id, status, error_code, safe_error)
VALUES
  ('campaign-18', 'replacement-success', 'failed', 'RATE_LIMIT', 'private detail');
SQL
CAMPAIGN_ID=campaign-18 run_alert before-replacement-success
"$SQLITE_BIN" "$DB" <<'SQL'
UPDATE analysis_campaigns SET status = 'completed' WHERE id = 'campaign-18';
INSERT INTO analysis_campaigns
  (id, provider, model, pipeline_revision, status, total_items)
VALUES
  ('campaign-19', 'anthropic', 'glm-5.2', 'two-pass-v5', 'active', 1);
INSERT INTO analysis_campaign_items
  (campaign_id, session_id, status, error_code, safe_error)
VALUES
  ('campaign-19', 'replacement-success', 'succeeded', NULL, NULL);
SQL
send_count_before=$(grep -c '^SEND|' "$SEND_LOG")
CAMPAIGN_ID=campaign-19 run_alert replacement-success-not-recovery
[[ "$(grep -c '^SEND|' "$SEND_LOG")" -eq "$send_count_before" ]] \
  || fail 'a replacement campaign falsely recovered the original incident'

# If A's failed notification is queued, A succeeds/completes, and B becomes
# current before transport recovers, A's immutable failure is still followed
# by A's verified recovery while B is handled independently.
"$SQLITE_BIN" "$DB" <<'SQL'
UPDATE analysis_campaigns SET status = 'completed' WHERE id = 'campaign-19';
INSERT INTO analysis_campaigns
  (id, provider, model, pipeline_revision, status, total_items)
VALUES
  ('campaign-20', 'anthropic', 'glm-5.2', 'two-pass-v5', 'active', 1);
INSERT INTO analysis_campaign_items
  (campaign_id, session_id, status, error_code, safe_error)
VALUES
  ('campaign-20', 'recovered-before-new-current', 'failed', 'RATE_LIMIT', 'private detail');
SQL
set +e
touch "$TMP_ROOT/fail-send"
CAMPAIGN_ID=campaign-20 run_alert queued-before-new-current \
  2> "$TMP_ROOT/queued-before-new-current.err"
queued_before_new_current_status=$?
rm -f "$TMP_ROOT/fail-send"
set -e
[[ "$queued_before_new_current_status" -eq 75 ]] \
  || fail 'new-current setup did not leave A failure queued'
"$SQLITE_BIN" "$DB" <<'SQL'
UPDATE analysis_campaign_items
SET status = 'succeeded', error_code = NULL, safe_error = NULL
WHERE campaign_id = 'campaign-20'
  AND session_id = 'recovered-before-new-current';
UPDATE analysis_campaigns SET status = 'completed' WHERE id = 'campaign-20';
INSERT INTO analysis_campaigns
  (id, provider, model, pipeline_revision, status, total_items)
VALUES
  ('campaign-21', 'anthropic', 'glm-5.2', 'two-pass-v5', 'active', 1);
INSERT INTO analysis_campaign_items
  (campaign_id, session_id, status, error_code, safe_error)
VALUES
  ('campaign-21', 'new-current-failure', 'failed', 'AUTHENTICATION', 'private detail');
SQL
send_count_before=$(grep -c '^SEND|' "$SEND_LOG")
recovery_count_before=$(grep -c 'Code Insights 自动分析已恢复' "$SEND_LOG")
CAMPAIGN_ID=campaign-21 run_alert recovered-A-with-current-B
[[ "$(grep -c '^SEND|' "$SEND_LOG")" -eq "$((send_count_before + 3))" ]] \
  || fail 'A failure/recovery or independent B failure was lost'
[[ "$(grep -c 'Code Insights 自动分析已恢复' "$SEND_LOG")" -eq "$((recovery_count_before + 1))" ]] \
  || fail 'completed A never corrected its queued failure after B became current'

# The same reconciliation applies when A's failure was already delivered before
# it succeeded. A must not wait for a long-running B to finish before recovery.
"$SQLITE_BIN" "$DB" <<'SQL'
UPDATE analysis_campaigns SET status = 'completed' WHERE id = 'campaign-21';
INSERT INTO analysis_campaigns
  (id, provider, model, pipeline_revision, status, total_items)
VALUES
  ('campaign-22', 'anthropic', 'glm-5.2', 'two-pass-v5', 'active', 1);
INSERT INTO analysis_campaign_items
  (campaign_id, session_id, status, error_code, safe_error)
VALUES
  ('campaign-22', 'delivered-before-new-current', 'failed', 'RATE_LIMIT', 'private detail');
SQL
CAMPAIGN_ID=campaign-22 run_alert delivered-A-before-current-B
"$SQLITE_BIN" "$DB" <<'SQL'
UPDATE analysis_campaign_items
SET status = 'succeeded', error_code = NULL, safe_error = NULL
WHERE campaign_id = 'campaign-22'
  AND session_id = 'delivered-before-new-current';
UPDATE analysis_campaigns SET status = 'completed' WHERE id = 'campaign-22';
INSERT INTO analysis_campaigns
  (id, provider, model, pipeline_revision, status, total_items)
VALUES
  ('campaign-23', 'anthropic', 'glm-5.2', 'two-pass-v5', 'active', 1);
INSERT INTO analysis_campaign_items
  (campaign_id, session_id, status, error_code, safe_error)
VALUES
  ('campaign-23', 'long-running-current', 'pending', NULL, NULL);
SQL
send_count_before=$(grep -c '^SEND|' "$SEND_LOG")
recovery_count_before=$(grep -c 'Code Insights 自动分析已恢复' "$SEND_LOG")
CAMPAIGN_ID=campaign-23 run_alert delivered-A-recovered-during-current-B
[[ "$(grep -c '^SEND|' "$SEND_LOG")" -eq "$((send_count_before + 1))" ]] \
  || fail 'delivered A recovery waited for current B to finish'
[[ "$(grep -c 'Code Insights 自动分析已恢复' "$SEND_LOG")" -eq "$((recovery_count_before + 1))" ]] \
  || fail 'delivered A recovery was not reconciled against its own campaign'

# A full outbox must attempt its head instead of failing before transport can
# make progress. The sender is intentionally unavailable so the persisted
# 100-event fixture remains bounded for this regression.
FULL_STATE="$TMP_ROOT/full-analysis-alert-state.json"
"$SQLITE_BIN" "$DB" <<'SQL'
UPDATE analysis_campaigns SET status = 'completed' WHERE id = 'campaign-23';
INSERT INTO analysis_campaigns
  (id, provider, model, pipeline_revision, status, total_items)
VALUES
  ('campaign-full', 'anthropic', 'glm-5.2', 'two-pass-v5', 'active', 1);
INSERT INTO analysis_campaign_items
  (campaign_id, session_id, status, error_code, safe_error)
VALUES
  ('campaign-full', 'new-while-full', 'failed', 'AUTHENTICATION', 'private detail');
SQL
node -e '
  const crypto = require("node:crypto");
  const fs = require("node:fs");
  const target = process.argv[1];
  const outbox = Array.from({ length: 100 }, (_, index) => {
    const sequence = index + 1;
    return {
      eventId: crypto.createHash("sha256").update(`full-${sequence}`).digest("hex"),
      phase: "detected",
      sequence,
      campaignId: "campaign-full",
      failures: [{ sessionId: `queued-${sequence}`, errorCode: "RATE_LIMIT" }],
      message: `queued failure ${sequence}`,
    };
  });
  fs.writeFileSync(target, `${JSON.stringify({
    version: 1,
    nextSequence: 101,
    incidents: [],
    outbox,
  })}\n`, { mode: 0o600 });
' "$FULL_STATE"
chmod 600 "$FULL_STATE"
full_fail_count_before=$(grep -c '^FAIL|' "$SEND_LOG")
set +e
touch "$TMP_ROOT/fail-send"
node "$SCRIPT" evaluate \
  --db "$DB" \
  --sqlite-bin "$SQLITE_BIN" \
  --state "$FULL_STATE" \
  --config "$CONFIG" \
  --campaign-id campaign-full \
  > "$TMP_ROOT/full-outbox.out" 2> "$TMP_ROOT/full-outbox.err"
full_outbox_status=$?
rm -f "$TMP_ROOT/fail-send"
set -e
[[ "$full_outbox_status" -eq 75 ]] \
  || fail "expected transport status 75 for a full outbox, got $full_outbox_status"
[[ "$(grep -c '^FAIL|' "$SEND_LOG")" -eq "$((full_fail_count_before + 1))" ]] \
  || fail 'full outbox did not attempt its existing head'
if grep -Fq 'Alert outbox is full.' "$TMP_ROOT/full-outbox.err"; then
  fail 'full outbox remained permanently blocked before delivery'
fi

# A stale lock whose PID has been reused is reclaimed only when the recorded
# process start identity no longer matches the live process.
mkdir -m 700 "$STATE.lock"
printf '%s\n' \
  "{\"version\":1,\"pid\":$$,\"processStartedAt\":\"not-the-live-process\",\"token\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"createdAt\":1}" \
  > "$STATE.lock/owner.json"
chmod 600 "$STATE.lock/owner.json"
CAMPAIGN_ID=campaign-12 run_alert stale-reused-pid-lock
[[ ! -e "$STATE.lock" ]] \
  || fail 'a reused live PID kept an unrelated stale alert lock forever'

# The executable sender boundary rejects a symlink instead of following a
# replaceable path with the alert process environment.
ln -s "$SENDER" "$TMP_ROOT/sender-link.mjs"
SYMLINK_CONFIG="$TMP_ROOT/analysis-alert-symlink-sender.json"
printf '%s\n' \
  "{\"version\":1,\"enabled\":true,\"target\":\"Test Contact\",\"senderScript\":\"$TMP_ROOT/sender-link.mjs\"}" \
  > "$SYMLINK_CONFIG"
chmod 600 "$SYMLINK_CONFIG"
set +e
PRIVATE_MODEL_TOKEN='must-not-reach-sender' node "$SCRIPT" evaluate \
  --db "$DB" \
  --sqlite-bin "$SQLITE_BIN" \
  --state "$STATE" \
  --config "$SYMLINK_CONFIG" \
  --campaign-id campaign-12 \
  > "$TMP_ROOT/sender-symlink.out" 2> "$TMP_ROOT/sender-symlink.err"
sender_symlink_status=$?
set -e
[[ "$sender_symlink_status" -eq 78 ]] \
  || fail "expected sender symlink rejection status 78, got $sender_symlink_status"

# A regular sender inside a group/other-writable directory is also rejected.
mkdir "$TMP_ROOT/unsafe-sender-parent"
chmod 777 "$TMP_ROOT/unsafe-sender-parent"
cp "$SENDER" "$TMP_ROOT/unsafe-sender-parent/fake-tt-send.mjs"
chmod 755 "$TMP_ROOT/unsafe-sender-parent/fake-tt-send.mjs"
UNSAFE_PARENT_CONFIG="$TMP_ROOT/analysis-alert-unsafe-parent.json"
printf '%s\n' \
  "{\"version\":1,\"enabled\":true,\"target\":\"Test Contact\",\"senderScript\":\"$TMP_ROOT/unsafe-sender-parent/fake-tt-send.mjs\"}" \
  > "$UNSAFE_PARENT_CONFIG"
chmod 600 "$UNSAFE_PARENT_CONFIG"
set +e
node "$SCRIPT" evaluate \
  --db "$DB" \
  --sqlite-bin "$SQLITE_BIN" \
  --state "$STATE" \
  --config "$UNSAFE_PARENT_CONFIG" \
  --campaign-id campaign-12 \
  > "$TMP_ROOT/sender-unsafe-parent.out" 2> "$TMP_ROOT/sender-unsafe-parent.err"
sender_unsafe_parent_status=$?
set -e
[[ "$sender_unsafe_parent_status" -eq 78 ]] \
  || fail "expected unsafe sender parent rejection status 78, got $sender_unsafe_parent_status"

printf 'analysis alert tests passed\n'
