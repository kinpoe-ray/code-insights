#!/usr/bin/env bash
# Run maintenance under its existing LLM lock, then deliver best-effort alerts
# only after that lock has been released.

set -uo pipefail
umask 077

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
MAINTENANCE_SCRIPT="${CODE_INSIGHTS_MAINTENANCE_SCRIPT:-$ROOT/automation/code-insights-maintenance.sh}"
CONFIG_DIR="${CODE_INSIGHTS_CONFIG_DIR:-$HOME/.code-insights}"
DB="${CODE_INSIGHTS_DB:-$CONFIG_DIR/data.db}"
SQLITE_BIN="${CODE_INSIGHTS_SQLITE_BIN:-$(command -v sqlite3 2>/dev/null || true)}"
NODE_BIN="${CODE_INSIGHTS_NODE_BIN:-$(command -v node 2>/dev/null || true)}"
ALERT_SCRIPT="${CODE_INSIGHTS_ALERT_SCRIPT:-$ROOT/automation/code-insights-analysis-alert.mjs}"
ALERT_CONFIG="${CODE_INSIGHTS_ALERT_CONFIG:-$CONFIG_DIR/analysis-alert.json}"
ALERT_STATE="${CODE_INSIGHTS_ALERT_STATE:-$CONFIG_DIR/analysis-alert-state.json}"
ALERT_DRY_RUN="${CODE_INSIGHTS_ALERT_DRY_RUN:-0}"

child_pid=""
child_output_file=""

cleanup_child_output() {
  if [[ -n "$child_output_file" ]]; then
    rm -f -- "$child_output_file"
    child_output_file=""
  fi
}

forward_signal() {
  local signal=$1 exit_code=$2
  if [[ -n "$child_pid" ]] && kill -0 "$child_pid" 2>/dev/null; then
    kill "-$signal" -- "-$child_pid" 2>/dev/null \
      || kill "-$signal" "$child_pid" 2>/dev/null \
      || true
    wait "$child_pid" 2>/dev/null || true
  fi
  cleanup_child_output
  exit "$exit_code"
}

trap 'forward_signal INT 130' INT
trap 'forward_signal TERM 143' TERM

alerts_are_configured() {
  [[ -f "$ALERT_CONFIG" ]]
}

current_campaign_id() {
  [[ -n "$SQLITE_BIN" && -x "$SQLITE_BIN" && -f "$DB" ]] || return 1
  local campaign_id
  campaign_id=$("$SQLITE_BIN" "$DB" "
    SELECT id
    FROM analysis_campaigns
    WHERE status IN ('active', 'paused')
    ORDER BY rowid DESC
    LIMIT 2;
  " 2>/dev/null) || return 1
  [[ "$campaign_id" != *$'\n'* ]] || return 1
  [[ -z "$campaign_id" || "$campaign_id" =~ ^[A-Za-z0-9_-]{1,128}$ ]] || return 1
  printf '%s' "$campaign_id"
}

tracked_campaign_id() {
  [[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || return 1
  [[ -e "$ALERT_STATE" ]] || return 0
  "$NODE_BIN" -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const target = process.argv[1];
    const parent = fs.lstatSync(path.dirname(target));
    if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0) process.exit(1);
    if (typeof process.getuid === "function" && parent.uid !== process.getuid()) process.exit(1);
    const descriptor = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    let state;
    try {
      const info = fs.fstatSync(descriptor);
      if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0) process.exit(1);
      if (typeof process.getuid === "function" && info.uid !== process.getuid()) process.exit(1);
      state = JSON.parse(fs.readFileSync(descriptor, "utf8"));
    } finally {
      fs.closeSync(descriptor);
    }
    if (state?.version !== 1 || !Array.isArray(state.incidents)) process.exit(1);
    const queued = Array.isArray(state.outbox) ? state.outbox[0] : null;
    const queuedCampaignId = queued?.campaignId;
    const open = state.incidents
      .filter(incident => incident?.status === "open")
      .sort((left, right) => Number(right.sequence) - Number(left.sequence));
    const campaignId = queuedCampaignId ?? open[0]?.originCampaignId ?? "";
    if (campaignId && !/^[A-Za-z0-9_-]{1,128}$/.test(campaignId)) process.exit(1);
    process.stdout.write(campaignId);
  ' "$ALERT_STATE" 2>/dev/null
}

run_alert() {
  local campaign_id=$1 output status
  [[ -n "$campaign_id" ]] || return 0
  if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" || ! -f "$ALERT_SCRIPT" ]]; then
    printf '[Code Insights] Analysis alert is unavailable; maintenance result is unchanged.\n' >&2
    return 0
  fi

  local args=(
    "$ALERT_SCRIPT" evaluate
    --db "$DB"
    --sqlite-bin "$SQLITE_BIN"
    --state "$ALERT_STATE"
    --config "$ALERT_CONFIG"
    --campaign-id "$campaign_id"
  )
  if [[ "$ALERT_DRY_RUN" == '1' ]]; then
    args+=(--dry-run)
  fi

  if ! child_output_file=$(mktemp "$CONFIG_DIR/.analysis-alert-output.XXXXXX"); then
    printf '[Code Insights] Analysis alert delivery failed safely; maintenance result is unchanged.\n' >&2
    child_output_file=""
    return 0
  fi
  if ! chmod 600 "$child_output_file"; then
    cleanup_child_output
    printf '[Code Insights] Analysis alert delivery failed safely; maintenance result is unchanged.\n' >&2
    return 0
  fi
  set -m
  "$NODE_BIN" "${args[@]}" > "$child_output_file" 2>&1 &
  child_pid=$!
  set +m
  wait "$child_pid"
  status=$?
  child_pid=""
  output=$(< "$child_output_file")
  cleanup_child_output
  if [[ "$status" -ne 0 ]]; then
    printf '[Code Insights] Analysis alert delivery failed safely; maintenance result is unchanged.\n' >&2
    return 0
  fi
  if grep -Fq '"action":"sent"' <<< "$output"; then
    printf '[Code Insights] Analysis alert sent.\n'
  elif grep -Fq '"action":"previewed"' <<< "$output"; then
    printf '[Code Insights] Analysis alert dry-run completed; delivery state was unchanged.\n'
  fi
}

if ! alerts_are_configured; then
  exec "$MAINTENANCE_SCRIPT" "$@"
fi
if [[ "$ALERT_DRY_RUN" != '0' && "$ALERT_DRY_RUN" != '1' ]]; then
  printf '[Code Insights] Invalid CODE_INSIGHTS_ALERT_DRY_RUN; expected 0 or 1.\n' >&2
  exec "$MAINTENANCE_SCRIPT" "$@"
fi

campaign_id=""
campaign_lookup_failed=0
if ! campaign_id=$(current_campaign_id); then
  printf '[Code Insights] Could not identify the current analysis campaign; alerts were skipped.\n' >&2
  campaign_lookup_failed=1
fi
if [[ -z "$campaign_id" && "$campaign_lookup_failed" -eq 0 ]] \
  && ! campaign_id=$(tracked_campaign_id); then
  printf '[Code Insights] Could not read the private alert cursor; tracked recovery was skipped.\n' >&2
  campaign_id=""
fi
run_alert "$campaign_id"

# With job control disabled, Bash starts asynchronous commands with SIGINT
# ignored. Enable it so the child can receive the signal forwarded by our trap.
set -m
"$MAINTENANCE_SCRIPT" "$@" &
child_pid=$!
set +m
wait "$child_pid"
maintenance_status=$?
child_pid=""

run_alert "$campaign_id"
exit "$maintenance_status"
