#!/usr/bin/env bash
# Daily, strictly serial maintenance: sync -> bounded analysis -> weekly reflect.

set -uo pipefail
umask 077

ORIGINAL_ARGS=("$@")

if [[ "${1:-run}" != "run" ]]; then
  printf 'Usage: %s run\n' "$0" >&2
  exit 64
fi

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
CONFIG_DIR="${CODE_INSIGHTS_CONFIG_DIR:-$HOME/.code-insights}"
DB="${CODE_INSIGHTS_DB:-$CONFIG_DIR/data.db}"
ANALYZE_SCRIPT="${CODE_INSIGHTS_ANALYZE_SCRIPT:-$ROOT/throttled-analyze.sh}"
SQLITE_BIN="${CODE_INSIGHTS_SQLITE_BIN:-$(command -v sqlite3 2>/dev/null || true)}"
CURL_BIN="${CODE_INSIGHTS_CURL_BIN:-$(command -v curl 2>/dev/null || true)}"
CODE_INSIGHTS_BIN="${CODE_INSIGHTS_BIN:-$(command -v code-insights 2>/dev/null || true)}"
LOOKBACK_DAYS="${CODE_INSIGHTS_LOOKBACK_DAYS:-36500}"
BATCH_SIZE="${CODE_INSIGHTS_BATCH_SIZE:-5}"
MAX_BATCHES="${CODE_INSIGHTS_MAX_BATCHES:-10}"
DELAY="${CODE_INSIGHTS_DELAY:-10}"
QUEUE_LIMIT="${CODE_INSIGHTS_QUEUE_LIMIT:-5}"
WINDOW_END="${CODE_INSIGHTS_WINDOW_END:-}"
DEADLINE_EPOCH="${CODE_INSIGHTS_DEADLINE_EPOCH:-}"
FAIL_LOG="${CODE_INSIGHTS_FAIL_LOG:-$CONFIG_DIR/throttled-analyze.failures}"
LOG_DIR="${CODE_INSIGHTS_LOG_DIR:-$CONFIG_DIR/logs}"
RUN_LOG="$LOG_DIR/maintenance-$(date '+%Y%m%dT%H%M%S').log"
DASHBOARD_PORT=7890
DASHBOARD_URL='http://127.0.0.1:7890'
DASHBOARD_CAN_START_LOCAL=1

DASHBOARD_PID=""
PAUSE_FILE="$CONFIG_DIR/maintenance.paused"

if [[ -e "$PAUSE_FILE" ]]; then
  printf '[Code Insights] Maintenance is paused; no work was started.\n'
  exit 0
fi

log() {
  printf '[%s] %s\n' "$(date -Iseconds)" "$*" | tee -a "$RUN_LOG"
}

stop_dashboard() {
  if [[ -n "$DASHBOARD_PID" ]] && kill -0 "$DASHBOARD_PID" 2>/dev/null; then
    kill "$DASHBOARD_PID" 2>/dev/null || true
    wait "$DASHBOARD_PID" 2>/dev/null || true
  fi
  DASHBOARD_PID=""
}

cleanup() {
  stop_dashboard
}

exit_for_signal() {
  exit "$1"
}

trap cleanup EXIT
trap 'exit_for_signal 130' INT
trap 'exit_for_signal 143' TERM

is_uint() {
  [[ "$1" =~ ^[0-9]+$ ]]
}

maintenance_window_has_ended() {
  [[ -n "$WINDOW_END" ]] || return 1
  local current_time
  current_time=$(date '+%H:%M')
  [[ "$current_time" == "$WINDOW_END" || "$current_time" > "$WINDOW_END" ]]
}

maintenance_stop_requested() {
  [[ -e "$PAUSE_FILE" ]] && return 0
  maintenance_window_has_ended
}

log_maintenance_stop() {
  if [[ -e "$PAUSE_FILE" ]]; then
    log 'Maintenance was paused; remaining work will resume later.'
  else
    log "Maintenance window ended at $WINDOW_END; remaining work will resume on the next schedule."
  fi
}

initialize_deadline() {
  [[ -n "$WINDOW_END" ]] || return 0
  if [[ -z "$DEADLINE_EPOCH" ]]; then
    local today candidate
    today=$(date '+%Y-%m-%d') || return 1
    if candidate=$(date -j -f '%Y-%m-%d %H:%M' "$today $WINDOW_END" '+%s' 2>/dev/null); then
      DEADLINE_EPOCH=$candidate
    elif candidate=$(date -d "$today $WINDOW_END" '+%s' 2>/dev/null); then
      DEADLINE_EPOCH=$candidate
    else
      log "Could not calculate today's maintenance deadline for $WINDOW_END."
      return 1
    fi
  fi
  export CODE_INSIGHTS_DEADLINE_EPOCH="$DEADLINE_EPOCH"
}

read_configured_dashboard_port() {
  local config_file="$CONFIG_DIR/config.json"
  local candidate=""
  local authority=""

  if [[ -n "${CODE_INSIGHTS_DASHBOARD_URL:-}" ]]; then
    DASHBOARD_URL="${CODE_INSIGHTS_DASHBOARD_URL%/}"
    DASHBOARD_CAN_START_LOCAL=0
    case "$DASHBOARD_URL" in
      http://*)
        candidate=80
        authority=${DASHBOARD_URL#http://}
        ;;
      https://*)
        candidate=443
        authority=${DASHBOARD_URL#https://}
        ;;
      *)
        log "Invalid CODE_INSIGHTS_DASHBOARD_URL: $DASHBOARD_URL"
        return 64
        ;;
    esac
    authority=${authority%%/*}
    if [[ "$authority" =~ ^\[[^]]+\]:([0-9]+)$ ]]; then
      candidate=${BASH_REMATCH[1]}
    elif [[ "$authority" =~ :([0-9]+)$ ]]; then
      candidate=${BASH_REMATCH[1]}
    elif [[ "$authority" == *:* ]]; then
      log "Invalid CODE_INSIGHTS_DASHBOARD_URL port: $DASHBOARD_URL"
      return 64
    fi
    if ! is_uint "$candidate" || [[ "$candidate" -lt 1 || "$candidate" -gt 65535 ]]; then
      log "Invalid CODE_INSIGHTS_DASHBOARD_URL port: $DASHBOARD_URL"
      return 64
    fi
    if [[ "$DASHBOARD_URL" =~ ^http://(127\.0\.0\.1|localhost)(:[0-9]+)?$ ]] \
      || [[ "$DASHBOARD_URL" =~ ^http://\[::1\](:[0-9]+)?$ ]]; then
      DASHBOARD_CAN_START_LOCAL=1
    fi
    DASHBOARD_PORT="$candidate"
    return 0
  fi

  if [[ -f "$config_file" ]]; then
    if command -v plutil >/dev/null 2>&1; then
      candidate=$(plutil -extract dashboard.port raw "$config_file" 2>/dev/null || true)
    fi
    if [[ -z "$candidate" ]] && command -v node >/dev/null 2>&1; then
      candidate=$(node -e '
        try {
          const value = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))?.dashboard?.port;
          if (value !== undefined) process.stdout.write(String(value));
        } catch {}
      ' "$config_file" 2>/dev/null || true)
    fi
  fi

  if [[ -n "$candidate" ]]; then
    if ! is_uint "$candidate" || [[ "$candidate" -lt 1 || "$candidate" -gt 65535 ]]; then
      log "Invalid dashboard port in $config_file: $candidate"
      return 64
    fi
    DASHBOARD_PORT="$candidate"
  fi
  DASHBOARD_URL="http://127.0.0.1:$DASHBOARD_PORT"
}

validate_environment() {
  is_uint "$LOOKBACK_DAYS" && [[ "$LOOKBACK_DAYS" -gt 0 ]] || { log 'Invalid CODE_INSIGHTS_LOOKBACK_DAYS'; return 64; }
  is_uint "$BATCH_SIZE" && [[ "$BATCH_SIZE" -gt 0 ]] || { log 'Invalid CODE_INSIGHTS_BATCH_SIZE'; return 64; }
  is_uint "$MAX_BATCHES" && [[ "$MAX_BATCHES" -gt 0 ]] || { log 'Invalid CODE_INSIGHTS_MAX_BATCHES'; return 64; }
  is_uint "$DELAY" || { log 'Invalid CODE_INSIGHTS_DELAY'; return 64; }
  is_uint "$QUEUE_LIMIT" && [[ "$QUEUE_LIMIT" -gt 0 ]] || { log 'Invalid CODE_INSIGHTS_QUEUE_LIMIT'; return 64; }
  [[ -z "$WINDOW_END" || "$WINDOW_END" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] \
    || { log 'Invalid CODE_INSIGHTS_WINDOW_END (expected HH:MM)'; return 64; }
  [[ -z "$DEADLINE_EPOCH" ]] || { is_uint "$DEADLINE_EPOCH" && [[ "$DEADLINE_EPOCH" -gt 0 ]]; } \
    || { log 'Invalid CODE_INSIGHTS_DEADLINE_EPOCH'; return 64; }
  [[ -n "$CODE_INSIGHTS_BIN" && -x "$CODE_INSIGHTS_BIN" ]] || { log 'code-insights executable not found'; return 69; }
  [[ -n "$SQLITE_BIN" && -x "$SQLITE_BIN" ]] || { log 'sqlite3 executable not found'; return 69; }
  [[ -n "$CURL_BIN" && -x "$CURL_BIN" ]] || { log 'curl executable not found'; return 69; }
  [[ -x "$ANALYZE_SCRIPT" ]] || { log "Analysis script is not executable: $ANALYZE_SCRIPT"; return 69; }
  [[ -f "$DB" ]] || { log "Database not found: $DB"; return 66; }
  read_configured_dashboard_port || return $?
}

run_pending_queue() {
  log "Processing up to $QUEUE_LIMIT durable hook queue item(s), newest first."
  local output status
  output=$(NO_COLOR=1 "$CODE_INSIGHTS_BIN" queue process -q --limit "$QUEUE_LIMIT" --delay "$DELAY" 2>&1)
  status=$?
  [[ -z "$output" ]] || printf '%s\n' "$output" | tee -a "$RUN_LOG"
  if [[ "$status" -eq 75 ]]; then
    log 'Queue processing was deferred because another LLM process holds the lock.'
  elif [[ "$status" -ne 0 ]]; then
    log "Queue processing failed with status $status; continuing with bounded database analysis."
  fi
  return "$status"
}

run_history_refresh() {
  local output status
  local args=(reanalyze run --batch-size "$BATCH_SIZE" --retry-failed --json)
  if [[ -n "$DEADLINE_EPOCH" ]]; then
    args+=(--deadline-epoch "$DEADLINE_EPOCH")
  fi

  log "Advancing the durable history reanalysis campaign by up to $BATCH_SIZE session(s)."
  output=$(NO_COLOR=1 "$CODE_INSIGHTS_BIN" "${args[@]}" 2>&1)
  status=$?
  [[ -z "$output" ]] || printf '%s\n' "$output" | tee -a "$RUN_LOG"
  if [[ "$status" -ne 0 ]]; then
    log "Durable history reanalysis failed with status $status; legacy analysis was not started."
    return "$status"
  fi
  if grep -Fq '"active":true' <<< "$output"; then
    HISTORY_REFRESH_WAS_ACTIVE=1
    return 0
  fi
  if grep -Fq '"active":false' <<< "$output"; then
    HISTORY_REFRESH_WAS_ACTIVE=0
    return 0
  fi
  log 'Could not determine durable history reanalysis state; legacy analysis was not started.'
  return 1
}

run_sync() {
  log 'Syncing all supported conversation sources.'
  local output status
  output=$(NO_COLOR=1 "$CODE_INSIGHTS_BIN" sync 2>&1)
  status=$?
  printf '%s\n' "$output" | tee -a "$RUN_LOG"
  if [[ "$status" -ne 0 ]] || grep -Eq 'Errors:[[:space:]]*[1-9][0-9]*' <<< "$output"; then
    log 'Sync completed with errors; continuing with safely imported sessions.'
    return 1
  fi
  return 0
}

run_analysis_batch() {
  local output status
  output=$(NO_COLOR=1 "$ANALYZE_SCRIPT" \
    --days "$LOOKBACK_DAYS" \
    --batch-size "$BATCH_SIZE" \
    --delay "$DELAY" \
    "$@" 2>&1)
  status=$?
  printf '%s\n' "$output" | tee -a "$RUN_LOG"
  ANALYSIS_OUTPUT="$output"
  return "$status"
}

drain_analysis() {
  local had_failures=0
  local status batch

  # Retry a bounded set quarantined by an earlier day. Failures created during
  # this run are intentionally deferred until tomorrow.
  if [[ -s "$FAIL_LOG" ]]; then
    if maintenance_window_has_ended; then
      log "Maintenance window ended at $WINDOW_END; remaining analysis will resume on the next schedule."
      return 3
    fi
    log "Retrying up to $BATCH_SIZE previously quarantined session(s)."
    run_analysis_batch --retry-failed
    status=$?
    if [[ "$status" -eq 3 ]]; then
      log_maintenance_stop
      return 3
    elif [[ "$status" -eq 2 ]]; then
      log 'Rate limit reached while retrying; stopping until the next schedule.'
      return 2
    elif [[ "$status" -ne 0 ]]; then
      had_failures=1
    fi
  fi

  for ((batch = 1; batch <= MAX_BATCHES; batch++)); do
    if maintenance_window_has_ended; then
      log "Maintenance window ended at $WINDOW_END; remaining analysis will resume on the next schedule."
      return 3
    fi
    log "Analysis batch $batch/$MAX_BATCHES (newest sessions first)."
    run_analysis_batch
    status=$?

    if [[ "$status" -eq 3 ]]; then
      log_maintenance_stop
      return 3
    elif [[ "$status" -eq 2 ]]; then
      log 'Rate limit reached; stopping until the next schedule.'
      return 2
    elif [[ "$status" -ne 0 ]]; then
      had_failures=1
    fi

    if grep -Eq '^Selected:[[:space:]]+0 session' <<< "$ANALYSIS_OUTPUT"; then
      log 'No incomplete sessions remain outside quarantine.'
      return "$had_failures"
    fi
    if ! grep -Eq '^Selected:[[:space:]]+[0-9]+ session' <<< "$ANALYSIS_OUTPUT"; then
      log 'Could not determine batch selection count.'
      return 1
    fi
  done

  log "Reached the daily cap of $((BATCH_SIZE * MAX_BATCHES)) sessions; remaining work will resume tomorrow."
  return "$had_failures"
}

calendar_values() {
  if [[ -n "${CODE_INSIGHTS_REFLECT_WEEK:-}" && -n "${CODE_INSIGHTS_CURRENT_WEEK_START:-}" ]]; then
    REFLECT_WEEK="$CODE_INSIGHTS_REFLECT_WEEK"
    CURRENT_WEEK_START="$CODE_INSIGHTS_CURRENT_WEEK_START"
  # The server interprets YYYY-WNN boundaries as UTC Monday-to-Monday, so the
  # scheduler must use UTC too (especially during early Monday hours in Asia).
  elif date -u -v-1d '+%Y-%m-%d' >/dev/null 2>&1; then
    local weekday offset
    weekday=$(date -u '+%u')
    offset=$((weekday - 1))
    CURRENT_WEEK_START=$(date -u -v-"${offset}"d '+%Y-%m-%d')
    REFLECT_WEEK=$(date -u -v-7d '+%G-W%V')
  else
    CURRENT_WEEK_START=$(date -u -d 'monday this week' '+%Y-%m-%d')
    REFLECT_WEEK=$(date -u -d '7 days ago' '+%G-W%V')
  fi

  [[ "$REFLECT_WEEK" =~ ^[0-9]{4}-W[0-9]{2}$ ]] || return 1
  [[ "$CURRENT_WEEK_START" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || return 1
}

dashboard_is_healthy() {
  "$CURL_BIN" --fail --silent --show-error --max-time 2 \
    "${DASHBOARD_URL%/}/api/health" >/dev/null 2>&1
}

ensure_dashboard() {
  if dashboard_is_healthy; then
    return 0
  fi

  if [[ "$DASHBOARD_CAN_START_LOCAL" -ne 1 ]]; then
    log 'Explicit dashboard URL is unavailable; cannot start a local replacement.'
    return 1
  fi

  log 'Starting a temporary dashboard server for reflection.'
  NO_COLOR=1 "$CODE_INSIGHTS_BIN" dashboard --no-open --no-sync --port "$DASHBOARD_PORT" >> "$RUN_LOG" 2>&1 &
  DASHBOARD_PID=$!

  local attempt
  for ((attempt = 1; attempt <= 30; attempt++)); do
    if dashboard_is_healthy; then
      return 0
    fi
    if ! kill -0 "$DASHBOARD_PID" 2>/dev/null; then
      break
    fi
    sleep 1
  done

  log 'Dashboard did not become healthy within 30 seconds.'
  return 1
}

refresh_previous_week() {
  if ! calendar_values; then
    log 'Could not calculate the previous ISO week.'
    return 1
  fi

  local facet_count snapshot_session_count snapshot_content_stale output status refreshed_count
  facet_count=$("$SQLITE_BIN" "$DB" "
    SELECT COUNT(*)
    FROM session_facets sf
    JOIN sessions s ON s.id = sf.session_id
    WHERE s.deleted_at IS NULL
      AND datetime(s.started_at) >= datetime('$CURRENT_WEEK_START', '-7 days')
      AND datetime(s.started_at) < datetime('$CURRENT_WEEK_START');
  ") || return 1
  snapshot_session_count=$("$SQLITE_BIN" "$DB" "
    SELECT session_count
    FROM reflect_snapshots
    WHERE period = '$REFLECT_WEEK' AND project_id = '__all__';
  ") || return 1
  snapshot_content_stale=$("$SQLITE_BIN" "$DB" "
    SELECT CASE
      WHEN datetime(MAX(sf.extracted_at)) > datetime((
        SELECT generated_at
        FROM reflect_snapshots
        WHERE period = '$REFLECT_WEEK' AND project_id = '__all__'
      )) THEN 1
      ELSE 0
    END
    FROM session_facets sf
    JOIN sessions s ON s.id = sf.session_id
    WHERE s.deleted_at IS NULL
      AND datetime(s.started_at) >= datetime('$CURRENT_WEEK_START', '-7 days')
      AND datetime(s.started_at) < datetime('$CURRENT_WEEK_START');
  ") || return 1

  [[ "$facet_count" =~ ^[0-9]+$ ]] || { log 'Invalid weekly facet count from database.'; return 1; }
  [[ -z "$snapshot_session_count" || "$snapshot_session_count" =~ ^[0-9]+$ ]] || { log 'Invalid snapshot session count from database.'; return 1; }
  [[ "$snapshot_content_stale" =~ ^[01]$ ]] || { log 'Invalid snapshot freshness result from database.'; return 1; }

  if [[ "$facet_count" -lt 8 ]]; then
    log "Skipping $REFLECT_WEEK reflection: $facet_count analyzed session(s), minimum is 8."
    return 0
  fi
  if [[ "$snapshot_session_count" == "$facet_count" && "$snapshot_content_stale" -eq 0 ]]; then
    log "Reflection for $REFLECT_WEEK is already current ($facet_count facets)."
    return 0
  fi

  if maintenance_stop_requested; then
    log_maintenance_stop
    return 3
  fi
  ensure_dashboard || return 1
  if maintenance_stop_requested; then
    log_maintenance_stop
    stop_dashboard
    return 3
  fi
  log "Refreshing reflection for $REFLECT_WEEK (${snapshot_session_count:-none} -> $facet_count analyzed sessions)."
  output=$(NO_COLOR=1 "$CODE_INSIGHTS_BIN" reflect --week "$REFLECT_WEEK" 2>&1)
  status=$?
  printf '%s\n' "$output" | tee -a "$RUN_LOG"
  [[ "$status" -eq 0 ]] || return "$status"

  refreshed_count=$("$SQLITE_BIN" "$DB" "
    SELECT session_count
    FROM reflect_snapshots
    WHERE period = '$REFLECT_WEEK' AND project_id = '__all__';
  ") || return 1
  if [[ "$refreshed_count" != "$facet_count" ]]; then
    log "Reflection postcondition failed: expected $facet_count facets, found ${refreshed_count:-none}."
    return 1
  fi

  log "Reflection for $REFLECT_WEEK is current."
  stop_dashboard
  return 0
}

mkdir -p "$LOG_DIR"
find "$LOG_DIR" -type f -name 'maintenance-*.log' -mtime +30 -delete 2>/dev/null || true

validate_environment || exit $?
initialize_deadline || exit $?
if [[ "${CODE_INSIGHTS_LOCK_HELD:-}" != "1" ]]; then
  exec "$CODE_INSIGHTS_BIN" lock-run /bin/bash "$0" "${ORIGINAL_ARGS[@]}"
fi
if maintenance_window_has_ended; then
  log "Maintenance window ended at $WINDOW_END; no work was started."
  exit 0
fi

log 'Code Insights maintenance started.'
overall_status=0
run_sync || overall_status=1
if maintenance_stop_requested; then
  log_maintenance_stop
  exit 0
fi
run_pending_queue || overall_status=1
if maintenance_stop_requested; then
  log_maintenance_stop
  exit 0
fi

HISTORY_REFRESH_WAS_ACTIVE=0
run_history_refresh
history_refresh_status=$?
if [[ "$history_refresh_status" -ne 0 ]]; then
  exit "$history_refresh_status"
fi
if [[ "$HISTORY_REFRESH_WAS_ACTIVE" -eq 1 ]]; then
  log 'Durable history reanalysis remains active; legacy analysis and reflection were skipped.'
  exit 0
fi

drain_analysis
analysis_status=$?
if [[ "$analysis_status" -eq 2 ]]; then
  exit 2
elif [[ "$analysis_status" -eq 3 ]]; then
  exit 0
elif [[ "$analysis_status" -ne 0 ]]; then
  overall_status=1
fi

if maintenance_stop_requested; then
  log_maintenance_stop
  exit 0
fi
refresh_previous_week
reflect_status=$?
if [[ "$reflect_status" -eq 3 ]]; then
  exit 0
elif [[ "$reflect_status" -ne 0 ]]; then
  overall_status=1
fi
log "Code Insights maintenance finished with status $overall_status."
exit "$overall_status"
