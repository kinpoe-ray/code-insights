#!/usr/bin/env bash
# throttled-analyze.sh — 逐个分析会话,带节流和限流自动重试
# 用途:绕过智谱 BigModel 的并发/RPM 限制(code-insights 官方无节流机制)
#
# 策略:
#   1. 从 SQLite 取所有未分析会话 id
#   2. 逐个调用 code-insights insights <id>(串行,不并发)
#   3. 每个会话之间固定 sleep(默认 8 秒,给智谱喘息)
#   4. 输出含"1302"(账户限流)时,指数退避重试该会话(最多 4 次)
#   5. 输出含"1305"(平台过载)时,同样退避重试
#   6. 其他错误(如编码 500)跳过,记录到失败列表
#
# 用法: ./throttled-analyze.sh [间隔秒数] [lookback天数]
#   默认: 间隔 8 秒,lookback 14 天

set -o pipefail

INTERVAL="${1:-8}"
LOOKBACK="${2:-14}"
DB="$HOME/.code-insights/data.db"
LOG="$HOME/.code-insights/throttled-analyze.log"

echo "=== 节流批量分析 | 间隔 ${INTERVAL}s | lookback ${LOOKBACK}d ==="
echo "日志: $LOG"

# 取未分析会话 id(近 LOOKBACK 天,排除已有 insights 的)
# 用 cutoff 日期避免边界问题
CUTOFF=$(date -v-${LOOKBACK}d +%Y-%m-%d 2>/dev/null || date -d "-${LOOKBACK} days" +%Y-%m-%d 2>/dev/null)
IDS_STR=$(sqlite3 "$DB" "
  SELECT s.id FROM sessions s
  LEFT JOIN insights i ON i.session_id = s.id
  WHERE s.started_at >= '${CUTOFF}'
    AND i.id IS NULL
  ORDER BY s.started_at DESC;
" 2>/dev/null)

# bash 3.2 (macOS) 兼容:用 read -a 读换行分隔的列表
IDS=()
while IFS= read -r line; do
  [ -n "$line" ] && IDS+=("$line")
done <<< "$IDS_STR"

TOTAL=${#IDS[@]}
echo "待分析: $TOTAL 个会话"
echo ""

if [ "$TOTAL" -eq 0 ]; then
  echo "✅ 没有未分析会话,全部已完成"
  exit 0
fi

OK=0
FAILED_LIST=()

for i in "${!IDS[@]}"; do
  SID="${IDS[$i]}"
  NUM=$((i + 1))
  SHORT="${SID:0:16}"
  echo -n "[$NUM/$TOTAL] $SHORT ... "

  ATTEMPT=0
  MAX_RETRY=4
  BACKOFF=15
  SUCCESS=""

  while [ "$ATTEMPT" -lt "$MAX_RETRY" ]; do
    ATTEMPT=$((ATTEMPT + 1))
    # 跑分析,合并 stdout+stderr 用于检测限流
    OUTPUT=$(code-insights insights "$SID" 2>&1)
    EC=$?

    if echo "$OUTPUT" | grep -q "Session analyzed"; then
      SUCCESS="ok"
      break
    fi

    if echo "$OUTPUT" | grep -qE "1302|1305|速率限制|rate limit"; then
      # 限流:退避后重试
      echo -n "限流,${BACKOFF}s后重试(attempt $ATTEMPT/$MAX_RETRY)... "
      sleep "$BACKOFF"
      BACKOFF=$((BACKOFF * 2))  # 指数退避: 15→30→60→120
      continue
    fi

    # 其他错误(编码 500 等):不重试,跳过
    SUCCESS="other-error"
    ERRMSG=$(echo "$OUTPUT" | grep -oE "\[[0-9]+\]\[[^]]*\]" | head -1)
    break
  done

  if [ "$SUCCESS" = "ok" ]; then
    echo "✓"
    OK=$((OK + 1))
    echo "[$NUM/$TOTAL] $SID OK" >> "$LOG"
  else
    echo "✗ ${ERRMSG:-失败}"
    FAILED_LIST+=("$SHORT:${ERRMSG:-unknown}")
    echo "[$NUM/$TOTAL] $SID FAIL ${ERRMSG:-}" >> "$LOG"
  fi

  # 会话间固定间隔(最后一个不用等)
  if [ "$NUM" -lt "$TOTAL" ]; then
    sleep "$INTERVAL"
  fi
done

echo ""
echo "════════════════════════════════════════"
echo "完成: $OK/$TOTAL 成功"
if [ "${#FAILED_LIST[@]}" -gt 0 ]; then
  echo "失败:"
  for f in "${FAILED_LIST[@]}"; do echo "  - $f"; done
fi
echo "════════════════════════════════════════"
