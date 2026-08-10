import { Hono } from 'hono';
import { getDb } from '@code-insights/cli/db/client';

const app = new Hono();

const VALID_RANGES = ['7d', '30d', '90d', 'all'] as const;
type Range = typeof VALID_RANGES[number];

const RANGE_DAYS: Record<Exclude<Range, 'all'>, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
};

const DAY_MS = 86_400_000;
const CORE_INSIGHT_TYPES = ['summary', 'decision', 'learning', 'technique'] as const;

interface SummaryRow {
  session_count: number;
  active_projects: number;
  total_messages: number | null;
  total_tool_calls: number | null;
  total_duration_min: number | null;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  cache_creation_tokens: number | null;
  cache_read_tokens: number | null;
  estimated_cost_usd: number | null;
  usage_covered_sessions: number;
  model_covered_sessions: number;
  latest_session_at: string | null;
  earliest_session_at: string | null;
  latest_sync_at: string | null;
}

interface InsightSummaryRow {
  total_insights: number;
  analyzed_sessions: number;
  latest_analysis_at: string | null;
  summary_count: number;
  decision_count: number;
  learning_count: number;
  prompt_quality_count: number;
}

interface DailySessionRow {
  date: string;
  session_count: number;
  message_count: number;
}

interface DailyInsightRow {
  date: string;
  insight_count: number;
}

interface ProjectSessionRow {
  project_id: string;
  project_name: string;
  project_path: string;
  session_count: number;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  cache_creation_tokens: number | null;
  cache_read_tokens: number | null;
  estimated_cost_usd: number | null;
  usage_covered_sessions: number;
}

interface ProjectInsightRow {
  project_id: string;
  summary_count: number;
  decision_count: number;
  learning_count: number;
  prompt_quality_count: number;
}

function parseTimezoneOffset(raw: string | undefined): number | null {
  if (raw === undefined) return 0;
  if (!/^-?\d+$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < -840 || value > 840) return null;
  return value;
}

/**
 * Return the UTC instant for the first local midnight in a calendar-day range.
 * JavaScript's timezone offset is UTC - local time, so converting the shifted
 * local midnight back to UTC requires adding the offset.
 */
function getWindowStart(range: Range, now: Date, timezoneOffset: number): string | null {
  if (range === 'all') return null;
  const shiftedNow = new Date(now.getTime() - timezoneOffset * 60_000);
  shiftedNow.setUTCHours(0, 0, 0, 0);
  const firstLocalMidnight = shiftedNow.getTime() - (RANGE_DAYS[range] - 1) * DAY_MS;
  return new Date(firstLocalMidnight + timezoneOffset * 60_000).toISOString();
}

function toLocalDateKey(timestamp: Date, timezoneOffset: number): string {
  return new Date(timestamp.getTime() - timezoneOffset * 60_000)
    .toISOString()
    .slice(0, 10);
}

function buildScopedWhere(windowStart: string | null, source?: string) {
  const conditions = ['s.deleted_at IS NULL'];
  const params: string[] = [];
  if (windowStart) {
    conditions.push('s.started_at >= ?');
    params.push(windowStart);
  }
  if (source) {
    conditions.push('s.source_tool = ?');
    params.push(source);
  }
  return { where: `WHERE ${conditions.join(' AND ')}`, params };
}

function localDateModifier(timezoneOffset: number): string {
  const localMinutes = -timezoneOffset;
  return `${localMinutes >= 0 ? '+' : ''}${localMinutes} minutes`;
}

// Dashboard overview stats for a given time range (e.g. ?range=7d|30d|90d|all)
app.get('/dashboard', (c) => {
  const db = getDb();
  const { range = '7d' } = c.req.query();

  if (!VALID_RANGES.includes(range as Range)) {
    return c.json({ error: `Invalid range. Must be one of: ${VALID_RANGES.join(', ')}` }, 400);
  }

  let periodStart: string | null = null;
  const now = new Date();
  if (range === '7d') {
    periodStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  } else if (range === '30d') {
    periodStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  } else if (range === '90d') {
    periodStart = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();
  }

  const where = periodStart
    ? 'WHERE started_at >= ? AND deleted_at IS NULL'
    : 'WHERE deleted_at IS NULL';
  const params = periodStart ? [periodStart] : [];

  const stats = db.prepare(`
    SELECT
      COUNT(*) AS session_count,
      COUNT(DISTINCT project_id) AS active_projects,
      SUM(message_count) AS total_messages,
      SUM(tool_call_count) AS total_tool_calls,
      CAST(COALESCE(SUM(
        CASE WHEN ended_at IS NOT NULL AND started_at IS NOT NULL
          THEN MAX(0, (julianday(ended_at) - julianday(started_at)) * 1440)
          ELSE 0
        END
      ), 0) AS INTEGER) AS total_duration_min,
      SUM(total_input_tokens) AS total_input_tokens,
      SUM(total_output_tokens) AS total_output_tokens,
      SUM(cache_creation_tokens) AS cache_creation_tokens,
      SUM(cache_read_tokens) AS cache_read_tokens,
      SUM(estimated_cost_usd) AS estimated_cost_usd
    FROM sessions ${where}
  `).get(...params);

  return c.json({ range, stats });
});

/**
 * Compact, grain-safe analytics payload used by the dashboard and Analytics page.
 * Every metric is scoped by the session's start time. Insights are attributed to
 * their session date, not the later time an analysis/backfill happened.
 */
app.get('/overview', (c) => {
  const db = getDb();
  const { range = '7d', source, timezoneOffset: rawTimezoneOffset } = c.req.query();

  if (!VALID_RANGES.includes(range as Range)) {
    return c.json({ error: `Invalid range. Must be one of: ${VALID_RANGES.join(', ')}` }, 400);
  }
  const timezoneOffset = parseTimezoneOffset(rawTimezoneOffset);
  if (timezoneOffset === null) {
    return c.json({ error: 'Invalid timezoneOffset. Expected an integer from -840 to 840.' }, 400);
  }

  const typedRange = range as Range;
  const generatedAt = new Date();
  const windowStart = getWindowStart(typedRange, generatedAt, timezoneOffset);
  const { where, params } = buildScopedWhere(windowStart, source || undefined);
  const dateModifier = localDateModifier(timezoneOffset);
  const activityGrain = typedRange === 'all' ? 'month' : 'day';
  const activityBucketExpression = activityGrain === 'month'
    ? "strftime('%Y-%m-01', s.started_at, ?)"
    : 'date(s.started_at, ?)';

  const summary = db.prepare(`
    SELECT
      COUNT(*) AS session_count,
      COUNT(DISTINCT s.project_id) AS active_projects,
      COALESCE(SUM(s.message_count), 0) AS total_messages,
      COALESCE(SUM(s.tool_call_count), 0) AS total_tool_calls,
      CAST(COALESCE(SUM(
        MAX(0, (julianday(s.ended_at) - julianday(s.started_at)) * 1440)
      ), 0) AS INTEGER) AS total_duration_min,
      COALESCE(SUM(s.total_input_tokens), 0) AS total_input_tokens,
      COALESCE(SUM(s.total_output_tokens), 0) AS total_output_tokens,
      COALESCE(SUM(s.cache_creation_tokens), 0) AS cache_creation_tokens,
      COALESCE(SUM(s.cache_read_tokens), 0) AS cache_read_tokens,
      COALESCE(SUM(s.estimated_cost_usd), 0) AS estimated_cost_usd,
      SUM(CASE WHEN s.usage_source IS NOT NULL THEN 1 ELSE 0 END) AS usage_covered_sessions,
      SUM(CASE WHEN s.primary_model IS NOT NULL AND s.primary_model <> '' THEN 1 ELSE 0 END) AS model_covered_sessions,
      MAX(s.started_at) AS latest_session_at,
      MIN(s.started_at) AS earliest_session_at,
      MAX(s.synced_at) AS latest_sync_at
    FROM sessions s
    ${where}
  `).get(...params) as SummaryRow;

  const insightSummary = db.prepare(`
    SELECT
      COUNT(i.id) AS total_insights,
      COUNT(DISTINCT CASE WHEN i.type IN (${CORE_INSIGHT_TYPES.map(() => '?').join(', ')}) THEN s.id END) AS analyzed_sessions,
      MAX(i.created_at) AS latest_analysis_at,
      SUM(CASE WHEN i.type = 'summary' THEN 1 ELSE 0 END) AS summary_count,
      SUM(CASE WHEN i.type = 'decision' THEN 1 ELSE 0 END) AS decision_count,
      SUM(CASE WHEN i.type IN ('learning', 'technique') THEN 1 ELSE 0 END) AS learning_count,
      SUM(CASE WHEN i.type = 'prompt_quality' THEN 1 ELSE 0 END) AS prompt_quality_count
    FROM sessions s
    LEFT JOIN insights i ON i.session_id = s.id
    ${where}
  `).get(...CORE_INSIGHT_TYPES, ...params) as InsightSummaryRow;

  const dailySessions = db.prepare(`
    SELECT
      ${activityBucketExpression} AS date,
      COUNT(*) AS session_count,
      COALESCE(SUM(s.message_count), 0) AS message_count
    FROM sessions s
    ${where}
    GROUP BY ${activityBucketExpression}
    ORDER BY date ASC
  `).all(dateModifier, ...params, dateModifier) as DailySessionRow[];

  const dailyInsights = db.prepare(`
    SELECT
      ${activityBucketExpression} AS date,
      COUNT(i.id) AS insight_count
    FROM sessions s
    LEFT JOIN insights i ON i.session_id = s.id
    ${where}
    GROUP BY ${activityBucketExpression}
    ORDER BY date ASC
  `).all(dateModifier, ...params, dateModifier) as DailyInsightRow[];

  const projectSessions = db.prepare(`
    SELECT
      s.project_id,
      s.project_name,
      s.project_path,
      COUNT(*) AS session_count,
      COALESCE(SUM(s.total_input_tokens), 0) AS total_input_tokens,
      COALESCE(SUM(s.total_output_tokens), 0) AS total_output_tokens,
      COALESCE(SUM(s.cache_creation_tokens), 0) AS cache_creation_tokens,
      COALESCE(SUM(s.cache_read_tokens), 0) AS cache_read_tokens,
      COALESCE(SUM(s.estimated_cost_usd), 0) AS estimated_cost_usd,
      SUM(CASE WHEN s.usage_source IS NOT NULL THEN 1 ELSE 0 END) AS usage_covered_sessions
    FROM sessions s
    ${where}
    GROUP BY s.project_id, s.project_name, s.project_path
    ORDER BY session_count DESC, s.project_name ASC
  `).all(...params) as ProjectSessionRow[];

  const projectInsights = db.prepare(`
    SELECT
      s.project_id,
      SUM(CASE WHEN i.type = 'summary' THEN 1 ELSE 0 END) AS summary_count,
      SUM(CASE WHEN i.type = 'decision' THEN 1 ELSE 0 END) AS decision_count,
      SUM(CASE WHEN i.type IN ('learning', 'technique') THEN 1 ELSE 0 END) AS learning_count,
      SUM(CASE WHEN i.type = 'prompt_quality' THEN 1 ELSE 0 END) AS prompt_quality_count
    FROM sessions s
    LEFT JOIN insights i ON i.session_id = s.id
    ${where}
    GROUP BY s.project_id
  `).all(...params) as ProjectInsightRow[];

  const modelDistribution = db.prepare(`
    SELECT s.primary_model AS model, COUNT(*) AS session_count
    FROM sessions s
    ${where} AND s.primary_model IS NOT NULL AND s.primary_model <> ''
    GROUP BY s.primary_model
    ORDER BY session_count DESC, s.primary_model ASC
  `).all(...params) as Array<{ model: string; session_count: number }>;

  const unanalyzedRows = db.prepare(`
    SELECT s.id
    FROM sessions s
    ${where}
      AND NOT EXISTS (
        SELECT 1 FROM insights i
        WHERE i.session_id = s.id
          AND i.type IN (${CORE_INSIGHT_TYPES.map(() => '?').join(', ')})
      )
    ORDER BY s.started_at DESC
  `).all(...params, ...CORE_INSIGHT_TYPES) as Array<{ id: string }>;

  const dailyMap = new Map<string, { date: string; session_count: number; message_count: number; insight_count: number }>();
  for (const row of dailySessions) {
    dailyMap.set(row.date, { ...row, insight_count: 0 });
  }
  for (const row of dailyInsights) {
    const existing = dailyMap.get(row.date);
    if (existing) existing.insight_count = row.insight_count;
    else dailyMap.set(row.date, { date: row.date, session_count: 0, message_count: 0, insight_count: row.insight_count });
  }

  if (typedRange !== 'all') {
    const days = RANGE_DAYS[typedRange];
    const shiftedToday = new Date(generatedAt.getTime() - timezoneOffset * 60_000);
    shiftedToday.setUTCHours(0, 0, 0, 0);
    for (let index = days - 1; index >= 0; index--) {
      const date = toLocalDateKey(new Date(shiftedToday.getTime() - index * DAY_MS + timezoneOffset * 60_000), timezoneOffset);
      if (!dailyMap.has(date)) {
        dailyMap.set(date, { date, session_count: 0, message_count: 0, insight_count: 0 });
      }
    }
  } else if (summary.earliest_session_at) {
    const shiftedEarliest = new Date(
      new Date(summary.earliest_session_at).getTime() - timezoneOffset * 60_000,
    );
    const shiftedLatest = new Date(generatedAt.getTime() - timezoneOffset * 60_000);
    const cursor = new Date(Date.UTC(
      shiftedEarliest.getUTCFullYear(),
      shiftedEarliest.getUTCMonth(),
      1,
    ));
    const lastMonth = Date.UTC(
      shiftedLatest.getUTCFullYear(),
      shiftedLatest.getUTCMonth(),
      1,
    );
    while (cursor.getTime() <= lastMonth) {
      const date = cursor.toISOString().slice(0, 10);
      if (!dailyMap.has(date)) {
        dailyMap.set(date, { date, session_count: 0, message_count: 0, insight_count: 0 });
      }
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
  }

  const projectInsightMap = new Map(projectInsights.map((row) => [row.project_id, row]));
  const projects = projectSessions.map((project) => {
    const counts = projectInsightMap.get(project.project_id);
    return {
      ...project,
      summary_count: counts?.summary_count ?? 0,
      decision_count: counts?.decision_count ?? 0,
      learning_count: counts?.learning_count ?? 0,
      prompt_quality_count: counts?.prompt_quality_count ?? 0,
    };
  });

  return c.json({
    range: typedRange,
    source: source || 'all',
    generated_at: generatedAt.toISOString(),
    timezone_offset: timezoneOffset,
    activity_grain: activityGrain,
    window_start: windowStart ?? summary.earliest_session_at,
    window_end: generatedAt.toISOString(),
    summary: {
      session_count: summary.session_count,
      insight_count: insightSummary.total_insights,
      active_projects: summary.active_projects,
      total_messages: summary.total_messages ?? 0,
      total_tool_calls: summary.total_tool_calls ?? 0,
      total_duration_min: summary.total_duration_min ?? 0,
      total_input_tokens: summary.total_input_tokens ?? 0,
      total_output_tokens: summary.total_output_tokens ?? 0,
      cache_creation_tokens: summary.cache_creation_tokens ?? 0,
      cache_read_tokens: summary.cache_read_tokens ?? 0,
      estimated_cost_usd: summary.estimated_cost_usd ?? 0,
    },
    coverage: {
      analyzed_sessions: insightSummary.analyzed_sessions,
      usage_covered_sessions: summary.usage_covered_sessions ?? 0,
      model_covered_sessions: summary.model_covered_sessions ?? 0,
      latest_session_at: summary.latest_session_at,
      latest_sync_at: summary.latest_sync_at,
      latest_analysis_at: insightSummary.latest_analysis_at,
    },
    insight_types: {
      summary: insightSummary.summary_count ?? 0,
      decision: insightSummary.decision_count ?? 0,
      learning: insightSummary.learning_count ?? 0,
      prompt_quality: insightSummary.prompt_quality_count ?? 0,
    },
    daily: Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date)),
    projects,
    models: modelDistribution,
    unanalyzed_session_ids: unanalyzedRows.map((row) => row.id),
  });
});

// Global cumulative usage stats
app.get('/usage', (c) => {
  const db = getDb();
  const stats = db.prepare(`
    SELECT total_input_tokens, total_output_tokens, cache_creation_tokens,
           cache_read_tokens, estimated_cost_usd, sessions_with_usage, last_updated_at
    FROM usage_stats WHERE id = 1
  `).get();
  return c.json({ stats: stats ?? null });
});

export default app;
