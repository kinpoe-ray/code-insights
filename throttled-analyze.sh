#!/usr/bin/env bash
# Bounded, newest-first session analysis with rate-limit protection.

set -uo pipefail

DELAY=8
LOOKBACK=14
BATCH_SIZE=10
SOURCE=""
DRY_RUN=false
MAX_RETRIES=4
DB="${CODE_INSIGHTS_DB:-$HOME/.code-insights/data.db}"
LOG="${CODE_INSIGHTS_LOG:-$HOME/.code-insights/throttled-analyze.log}"
LOCK_DIR="${TMPDIR:-/tmp}/code-insights-analysis.lock"
LEGACY_POSITION=0

usage() {
  cat <<'EOF'
Usage: ./throttled-analyze.sh [options]

Options:
  --days N          Only consider sessions from the last N days (default: 14)
  --batch-size N    Analyze at most N sessions in this run (default: 10)
  --delay N         Seconds between sessions (default: 8)
  --source NAME     Limit to claude-code, codex-cli, cursor, copilot-cli, or copilot
  --dry-run         List the selected sessions without calling the LLM
  -h, --help        Show this help

Legacy positional form is still supported: INTERVAL LOOKBACK
EOF
}

is_uint() {
  [[ "$1" =~ ^[0-9]+$ ]]
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --days|--lookback)
      [[ $# -ge 2 ]] || { echo "Missing value for $1" >&2; exit 64; }
      LOOKBACK="$2"; shift 2 ;;
    --batch-size)
      [[ $# -ge 2 ]] || { echo "Missing value for $1" >&2; exit 64; }
      BATCH_SIZE="$2"; shift 2 ;;
    --delay|--interval)
      [[ $# -ge 2 ]] || { echo "Missing value for $1" >&2; exit 64; }
      DELAY="$2"; shift 2 ;;
    --source)
      [[ $# -ge 2 ]] || { echo "Missing value for $1" >&2; exit 64; }
      SOURCE="$2"; shift 2 ;;
    --dry-run)
      DRY_RUN=true; shift ;;
    -h|--help)
      usage; exit 0 ;;
    --*)
      echo "Unknown option: $1" >&2; usage >&2; exit 64 ;;
    *)
      if [[ "$LEGACY_POSITION" -eq 0 ]]; then
        DELAY="$1"
      elif [[ "$LEGACY_POSITION" -eq 1 ]]; then
        LOOKBACK="$1"
      else
        echo "Unexpected positional argument: $1" >&2; exit 64
      fi
      LEGACY_POSITION=$((LEGACY_POSITION + 1))
      shift ;;
  esac
done

is_uint "$DELAY" || { echo "--delay must be a non-negative integer" >&2; exit 64; }
is_uint "$LOOKBACK" && [[ "$LOOKBACK" -gt 0 ]] || { echo "--days must be a positive integer" >&2; exit 64; }
is_uint "$BATCH_SIZE" && [[ "$BATCH_SIZE" -gt 0 ]] || { echo "--batch-size must be a positive integer" >&2; exit 64; }
[[ -f "$DB" ]] || { echo "Database not found: $DB" >&2; exit 66; }
command -v sqlite3 >/dev/null || { echo "sqlite3 not found" >&2; exit 69; }
command -v code-insights >/dev/null || { echo "code-insights not found" >&2; exit 69; }

case "$SOURCE" in
  "") SOURCE_SQL="" ;;
  claude-code|codex-cli|cursor|copilot-cli|copilot) SOURCE_SQL="AND s.source_tool = '$SOURCE'" ;;
  *) echo "Unsupported source: $SOURCE" >&2; exit 64 ;;
esac

# A session is complete only when both model passes match its current message count.
# Empty-message sessions are excluded so metadata-only imports cannot consume credits.
QUERY="
  SELECT s.id
  FROM sessions s
  LEFT JOIN analysis_usage session_usage
    ON session_usage.session_id = s.id AND session_usage.analysis_type = 'session'
  LEFT JOIN analysis_usage pq_usage
    ON pq_usage.session_id = s.id AND pq_usage.analysis_type = 'prompt_quality'
  WHERE s.deleted_at IS NULL
    AND s.message_count >= 3
    AND julianday(s.started_at) >= julianday('now', '-${LOOKBACK} days')
    AND EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id)
    AND (
      session_usage.session_id IS NULL
      OR session_usage.session_message_count IS NOT s.message_count
      OR pq_usage.session_id IS NULL
      OR pq_usage.session_message_count IS NOT s.message_count
    )
    $SOURCE_SQL
  ORDER BY julianday(s.started_at) DESC
  LIMIT ${BATCH_SIZE};
"

if ! IDS_STR=$(sqlite3 "$DB" "$QUERY"); then
  echo "Failed to query analysis candidates" >&2
  exit 74
fi
IDS=()
while IFS= read -r line; do
  if [[ -n "$line" ]]; then
    [[ "$line" =~ ^[A-Za-z0-9:._-]+$ ]] || { echo "Unsafe session ID returned by database" >&2; exit 65; }
    IDS+=("$line")
  fi
done <<< "$IDS_STR"
TOTAL=${#IDS[@]}

echo "=== Bounded analysis | newest first | days ${LOOKBACK} | batch ${BATCH_SIZE} | delay ${DELAY}s ==="
[[ -n "$SOURCE" ]] && echo "Source: $SOURCE"
echo "Selected: $TOTAL session(s)"

if [[ "$TOTAL" -eq 0 ]]; then
  echo "No incomplete sessions match this batch."
  exit 0
fi

if [[ "$DRY_RUN" == true ]]; then
  if ! sqlite3 -header -column "$DB" "
    SELECT s.started_at, s.source_tool, s.message_count, s.id
    FROM sessions s
    WHERE s.id IN ($(printf "'%s'," "${IDS[@]}" | sed 's/,$//'))
    ORDER BY julianday(s.started_at) DESC;
  "; then
    echo "Failed to display dry-run candidates" >&2
    exit 74
  fi
  echo "Dry run: no analysis calls made."
  exit 0
fi

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  LOCK_PID=""
  [[ -f "$LOCK_DIR/pid" ]] && read -r LOCK_PID < "$LOCK_DIR/pid"
  if [[ -n "$LOCK_PID" ]] && ! kill -0 "$LOCK_PID" 2>/dev/null; then
    rm -f "$LOCK_DIR/pid"
    rmdir "$LOCK_DIR" 2>/dev/null || true
  fi
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    echo "Another analysis batch is already running: $LOCK_DIR" >&2
    exit 75
  fi
fi
printf '%s\n' "$$" > "$LOCK_DIR/pid"
cleanup() {
  OWNER_PID=""
  [[ -f "$LOCK_DIR/pid" ]] && read -r OWNER_PID < "$LOCK_DIR/pid"
  if [[ "$OWNER_PID" == "$$" ]]; then
    rm -f "$LOCK_DIR/pid"
    rmdir "$LOCK_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

OK=0
FAILED=0
RATE_LIMITED=false

for i in "${!IDS[@]}"; do
  SID="${IDS[$i]}"
  NUM=$((i + 1))
  ATTEMPT=0
  BACKOFF=15
  SUCCESS=false
  LAST_OUTPUT=""

  printf '[%d/%d] %s ... ' "$NUM" "$TOTAL" "${SID:0:28}"
  while [[ "$ATTEMPT" -lt "$MAX_RETRIES" ]]; do
    ATTEMPT=$((ATTEMPT + 1))
    LAST_OUTPUT=$(code-insights insights "$SID" 2>&1)
    EXIT_CODE=$?

    if ! COMPLETE=$(sqlite3 "$DB" "
      SELECT COUNT(DISTINCT analysis_type)
      FROM analysis_usage
      WHERE session_id = '$SID'
        AND analysis_type IN ('session', 'prompt_quality')
        AND session_message_count = (SELECT message_count FROM sessions WHERE id = '$SID');
    "); then
      LAST_OUTPUT="Failed to verify analysis completion in SQLite"
      break
    fi
    if [[ "$EXIT_CODE" -eq 0 && "$COMPLETE" -eq 2 ]]; then
      SUCCESS=true
      break
    fi

    if grep -qiE '1302|1305|429|rate.?limit|速率限制|访问量过大|overload|too many requests|capacity|throttl' <<< "$LAST_OUTPUT"; then
      if [[ "$ATTEMPT" -lt "$MAX_RETRIES" ]]; then
        printf 'rate-limited; retry in %ss ... ' "$BACKOFF"
        sleep "$BACKOFF"
        BACKOFF=$((BACKOFF * 2))
        continue
      fi
      RATE_LIMITED=true
    fi
    break
  done

  if [[ "$SUCCESS" == true ]]; then
    echo "ok"
    OK=$((OK + 1))
    printf '[%s] %s OK\n' "$(date -Iseconds)" "$SID" >> "$LOG"
  else
    echo "failed"
    FAILED=$((FAILED + 1))
    ERROR_LINE=$(printf '%s\n' "$LAST_OUTPUT" | tail -n 1)
    printf '[%s] %s FAIL %s\n' "$(date -Iseconds)" "$SID" "$ERROR_LINE" >> "$LOG"
    [[ -n "$ERROR_LINE" ]] && echo "  $ERROR_LINE"
  fi

  if [[ "$RATE_LIMITED" == true ]]; then
    echo "Stopping this batch after repeated rate limiting."
    break
  fi
  [[ "$NUM" -lt "$TOTAL" ]] && sleep "$DELAY"
done

echo "Completed: $OK succeeded, $FAILED failed, $((TOTAL - OK - FAILED)) not attempted."
[[ "$RATE_LIMITED" == true ]] && exit 2
[[ "$FAILED" -gt 0 ]] && exit 1
exit 0
