import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { getDb } from '@code-insights/cli/db/client';
import { jsonrepair } from 'jsonrepair';
import { createLLMClient } from '../llm/client.js';
import { acquireServerLlmLock, llmBusyPayload } from '../llm/llm-lock.js';
import { requireLLM } from './route-helpers.js';
import { extractJsonPayload } from '../llm/response-parsers.js';
import {
  FRICTION_WINS_SYSTEM_PROMPT,
  generateFrictionWinsPrompt,
  RULES_SKILLS_SYSTEM_PROMPT,
  generateRulesSkillsPrompt,
  WORKING_STYLE_SYSTEM_PROMPT,
  generateWorkingStylePrompt,
} from '../llm/reflect-prompts.js';
import { buildWhereClause, buildPeriodFilter, parseIsoWeek, formatIsoWeek, getAggregatedData } from './shared-aggregation.js';
import type { ReflectSection } from '@code-insights/cli/types';
import { loadConfiguredAnalysisLanguage } from '@code-insights/cli/analysis/analysis-language';

const app = new Hono();

const MIN_FACETS_FOR_REFLECT = 8;

const ALL_SECTIONS: ReflectSection[] = ['friction-wins', 'rules-skills', 'working-style'];

// Parse LLM JSON response wrapped in <json>...</json> tags with jsonrepair fallback.
function parseLLMJson<T>(response: string): T | null {
  const payload = extractJsonPayload(response);
  if (!payload) return null;
  try {
    return JSON.parse(payload) as T;
  } catch {
    try {
      return JSON.parse(jsonrepair(payload)) as T;
    } catch {
      return null;
    }
  }
}

// Use an explicitly selected source when present. Otherwise detect the dominant
// tool only within the same period/project scope used for this reflection.
function detectTargetTool(
  db: ReturnType<typeof getDb>,
  where: string,
  params: (string | number)[],
  source?: string,
): string {
  if (source) return source;
  const row = db.prepare(
    `SELECT s.source_tool, COUNT(*) as count
     FROM sessions s
     ${where}
     GROUP BY s.source_tool
     ORDER BY count DESC, s.source_tool ASC
     LIMIT 1`
  ).get(...params) as { source_tool: string; count: number } | undefined;
  return row?.source_tool || 'claude-code';
}

// POST /api/reflect/generate
// Body: { sections?: ReflectSection[], period?: string, project?: string, source?: string }
// SSE endpoint: aggregates facets in code, then calls synthesis prompts for each section.
// Streams progress events so the UI can show phase-by-phase progress.
app.post('/generate', requireLLM(), async (c) => {

  const body = await c.req.json<{
    sections?: ReflectSection[];
    period?: string;
    project?: string;
    source?: string;
  }>();

  const sections = body.sections && body.sections.length > 0 ? body.sections : ALL_SECTIONS;
  const period = body.period || '30d';

  const db = getDb();
  const { where, params } = buildWhereClause(period, body.project, body.source);

  return streamSSE(c, async (stream) => {
    const abortSignal = c.req.raw.signal;
    const lock = acquireServerLlmLock(c);
    if (!lock) {
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify(llmBusyPayload()),
      });
      return;
    }

    try {
      await stream.writeSSE({
        event: 'progress',
        data: JSON.stringify({ phase: 'aggregating', message: 'Aggregating facets...' }),
      });

      const aggregated = getAggregatedData(db, where, params, body.project, body.source);

      if (aggregated.totalSessions === 0) {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ error: 'No sessions with facets found. Run analysis first.' }),
        });
        return;
      }

      if (aggregated.totalSessions < MIN_FACETS_FOR_REFLECT) {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({
            error: `Need at least ${MIN_FACETS_FOR_REFLECT} analyzed sessions for meaningful pattern synthesis. Currently have ${aggregated.totalSessions}. Run session analysis on more sessions first.`,
            code: 'INSUFFICIENT_FACETS',
            current: aggregated.totalSessions,
            required: MIN_FACETS_FOR_REFLECT,
          }),
        });
        return;
      }

      const client = createLLMClient();
      const results: Record<string, unknown> = {};
      const targetTool = detectTargetTool(db, where, params, body.source);
      const languageContext = {
        preference: loadConfiguredAnalysisLanguage(),
        messages: db.prepare(`
          SELECT m.type, m.content
          FROM sessions s
          JOIN messages m ON m.session_id = s.id
          ${where} AND m.type = 'user'
          ORDER BY s.started_at DESC, m.timestamp ASC, m.id ASC
          LIMIT 500
        `).all(...params) as Array<{ type: string; content: string }>,
      };

      for (const section of sections) {
        if (abortSignal.aborted) break;

        await stream.writeSSE({
          event: 'progress',
          data: JSON.stringify({ phase: 'synthesizing', section, message: `Generating ${section}...` }),
        });

        if (section === 'friction-wins') {
          const prompt = generateFrictionWinsPrompt({
            frictionCategories: aggregated.frictionCategories,
            effectivePatterns: aggregated.effectivePatterns,
            totalSessions: aggregated.totalSessions,
            period,
            pqSignals: (aggregated.pqDeficits.length || aggregated.pqStrengths.length)
              ? { deficits: aggregated.pqDeficits, strengths: aggregated.pqStrengths }
              : undefined,
          }, languageContext);
          const response = await client.chat([
            { role: 'system', content: FRICTION_WINS_SYSTEM_PROMPT },
            { role: 'user', content: prompt },
          ], { signal: abortSignal });
          const parsed = parseLLMJson(response.content);
          results['friction-wins'] = {
            section: 'friction-wins',
            ...(parsed ?? {}),
            frictionCategories: aggregated.frictionCategories,
            effectivePatterns: aggregated.effectivePatterns,
            pqDeficits: aggregated.pqDeficits,
            pqStrengths: aggregated.pqStrengths,
            generatedAt: new Date().toISOString(),
          };
        } else if (section === 'rules-skills') {
          // Only include patterns with sufficient occurrence counts for actionable artifacts
          const recurringFriction = aggregated.frictionCategories.filter(fc => fc.count >= 3);
          const recurringPatterns = aggregated.effectivePatterns.filter(ep => ep.frequency >= 2);
          const prompt = generateRulesSkillsPrompt({
            recurringFriction,
            effectivePatterns: recurringPatterns,
            targetTool,
          }, languageContext);
          const response = await client.chat([
            { role: 'system', content: RULES_SKILLS_SYSTEM_PROMPT },
            { role: 'user', content: prompt },
          ], { signal: abortSignal });
          const parsed = parseLLMJson(response.content);
          results['rules-skills'] = {
            section: 'rules-skills',
            ...(parsed ?? {}),
            targetTool,
            generatedAt: new Date().toISOString(),
          };
        } else if (section === 'working-style') {
          const prompt = generateWorkingStylePrompt({
            workflowDistribution: aggregated.workflowDistribution,
            outcomeDistribution: aggregated.outcomeDistribution,
            characterDistribution: aggregated.characterDistribution,
            totalSessions: aggregated.totalSessions,
            period,
            frictionFrequency: aggregated.frictionTotal,
          }, languageContext);
          const response = await client.chat([
            { role: 'system', content: WORKING_STYLE_SYSTEM_PROMPT },
            { role: 'user', content: prompt },
          ], { signal: abortSignal });
          const parsed = parseLLMJson(response.content);
          // Sanitize tagline: must be a string ≤40 chars. Non-string LLM outputs
          // (object, array, number) are normalized to undefined so they don't
          // corrupt the snapshot blob stored in SQLite.
          const rawTagline = parsed && (parsed as Record<string, unknown>)['tagline'];
          const tagline = typeof rawTagline === 'string'
            ? rawTagline.slice(0, 40)
            : undefined;
          const rawSubtitle = parsed && (parsed as Record<string, unknown>)['tagline_subtitle'];
          const tagline_subtitle = typeof rawSubtitle === 'string'
            ? rawSubtitle.slice(0, 80)
            : undefined;
          results['working-style'] = {
            section: 'working-style',
            ...(parsed ?? {}),
            tagline,
            tagline_subtitle,
            workflowDistribution: aggregated.workflowDistribution,
            outcomeDistribution: aggregated.outcomeDistribution,
            characterDistribution: aggregated.characterDistribution,
            generatedAt: new Date().toISOString(),
          };
        }
      }

      // Only save snapshot if the request was not aborted mid-generation.
      // Saving partial results would cause stale/incomplete data to auto-load on next visit.
      if (!c.req.raw.signal.aborted) {
        // For ISO week periods, use the exact week boundaries as window metadata.
        // This ensures the snapshot metadata accurately reflects the week it covers.
        const isoWeekBounds = parseIsoWeek(period);
        const windowStart = isoWeekBounds
          ? isoWeekBounds.start.toISOString()
          : buildPeriodFilter(period);
        const windowEnd = isoWeekBounds
          ? isoWeekBounds.end.toISOString()
          : new Date().toISOString();
        const projectKey = body.project || '__all__';
        const sourceScope = body.source || '__all__';

        db.prepare(`
          INSERT INTO reflect_snapshots (
            period, project_id, source_scope, results_json, generated_at,
            window_start, window_end, session_count, facet_count
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(period, project_id, source_scope) DO UPDATE SET
            results_json = excluded.results_json,
            generated_at = excluded.generated_at,
            window_start = excluded.window_start,
            window_end = excluded.window_end,
            session_count = excluded.session_count,
            facet_count = excluded.facet_count
        `).run(
          period,
          projectKey,
          sourceScope,
          JSON.stringify(results),
          new Date().toISOString(),
          windowStart,
          windowEnd,
          aggregated.totalSessions,
          aggregated.frictionTotal
        );
      }

      await stream.writeSSE({
        event: 'complete',
        data: JSON.stringify({ results }),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify({ error: message }),
      }).catch(() => {});
    } finally {
      lock.release();
    }
  });
});

// GET /api/reflect/results
// Returns raw aggregated facet data without LLM synthesis (fast, no cost).
// The full synthesized view requires POST /api/reflect/generate.
app.get('/results', (c) => {
  const db = getDb();
  const period = c.req.query('period') || '30d';
  const project = c.req.query('project');
  const source = c.req.query('source');

  const { where, params } = buildWhereClause(period, project, source);
  const aggregated = getAggregatedData(db, where, params, project, source);

  return c.json(aggregated);
});

// GET /api/reflect/weeks
// Returns all ISO weeks from the earliest session through the current week, with snapshot status.
// Used by the WeekSelector component to show which weeks have reflections.
// Week list is data-driven (not capped at 8) so users with long history can navigate all weeks.
app.get('/weeks', (c) => {
  const db = getDb();
  const project = c.req.query('project');
  const source = c.req.query('source');

  const scopeConditions: string[] = [];
  const scopeParams: string[] = [];
  if (project) {
    scopeConditions.push('s.project_id = ?');
    scopeParams.push(project);
  }
  if (source) {
    scopeConditions.push('s.source_tool = ?');
    scopeParams.push(source);
  }
  const scopeCondition = scopeConditions.length > 0
    ? `AND ${scopeConditions.join(' AND ')}`
    : '';

  // Find the earliest session to determine the full week range.
  // If no sessions exist, return empty array.
  const earliestRow = db.prepare(`
    SELECT MIN(started_at) as earliest
    FROM sessions s
    WHERE s.deleted_at IS NULL
      ${scopeCondition}
  `).get(...scopeParams) as { earliest: string | null } | undefined;

  if (!earliestRow?.earliest) {
    return c.json({ weeks: [] });
  }

  // Compute the UTC midnight of the Monday of the current ISO week.
  // Truncating to midnight ensures the while-loop comparison is stable
  // regardless of the time-of-day component in started_at values.
  const now = new Date();
  const nowDay = now.getUTCDay(); // 0=Sun
  const daysToMonday = nowDay === 0 ? 6 : nowDay - 1;
  const thisMondayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - daysToMonday * 86400000;

  // Compute the UTC midnight of the Monday of the earliest session's ISO week.
  const earliestDate = new Date(earliestRow.earliest);
  const earliestDay = earliestDate.getUTCDay();
  const daysToEarliestMonday = earliestDay === 0 ? 6 : earliestDay - 1;
  const earliestMondayMs = Date.UTC(earliestDate.getUTCFullYear(), earliestDate.getUTCMonth(), earliestDate.getUTCDate()) - daysToEarliestMonday * 86400000;

  // Generate all weeks from earliest through current (most recent first).
  // Cap at 520 weeks (~10 years) to stay under SQLite's 999 bind-variable limit
  // for the snapshot IN (...) query (each week uses 1 placeholder + 1 for project_id).
  const MAX_WEEKS = 520;
  type WeekEntry = { week: string; start: string; end: string };
  const weekEntries: WeekEntry[] = [];
  let weekMondayMs = thisMondayMs;
  while (weekMondayMs >= earliestMondayMs && weekEntries.length < MAX_WEEKS) {
    const weekMonday = new Date(weekMondayMs);
    const week = formatIsoWeek(weekMonday);
    const bounds = parseIsoWeek(week)!;
    weekEntries.push({ week, start: bounds.start.toISOString(), end: bounds.end.toISOString() });
    weekMondayMs -= 7 * 86400000;
  }

  const projectKey = project || '__all__';
  const sourceScope = source || '__all__';

  // Query 1: session counts per ISO week using GROUP BY.
  // Shift back three days before advancing to Thursday so Friday-Sunday stay in their
  // current ISO week. Advancing directly to Thursday would move them into the next week.
  // The final '-3 days' converts the selected Thursday to that ISO week's Monday.
  // Returns one row per week that has sessions — O(sessions), not O(weeks).
  const rangeStart = weekEntries[weekEntries.length - 1].start;
  const rangeEnd = weekEntries[0].end;

  const sessionCountRaw = db.prepare(`
    SELECT
      date(s.started_at, '-3 days', 'weekday 4', '-3 days') as week_monday,
      COUNT(*) as cnt
    FROM sessions s
    WHERE s.deleted_at IS NULL
      AND s.started_at >= ?
      AND s.started_at < ?
      ${scopeCondition}
    GROUP BY week_monday
  `).all(
    rangeStart,
    rangeEnd,
    ...scopeParams
  ) as Array<{ week_monday: string; cnt: number }>;

  // Build a map from ISO week string -> session count.
  // week_monday is a YYYY-MM-DD string (SQLite date()); parse it and derive the ISO week string.
  const sessionCountMap = new Map<string, number>();
  for (const row of sessionCountRaw) {
    const monday = new Date(row.week_monday + 'T00:00:00Z');
    const weekStr = formatIsoWeek(monday);
    // Accumulate in case formatIsoWeek maps two slightly-different Mondays to the same week
    sessionCountMap.set(weekStr, (sessionCountMap.get(weekStr) ?? 0) + row.cnt);
  }

  // Query 2: all snapshots for these weeks in one query
  const weekPlaceholders = weekEntries.map(() => '?').join(', ');
  const snapshotRows = db.prepare(`
    SELECT period, generated_at
    FROM reflect_snapshots
    WHERE period IN (${weekPlaceholders})
      AND project_id = ?
      AND source_scope = ?
  `).all(
    ...weekEntries.map(e => e.week),
    projectKey,
    sourceScope,
  ) as Array<{ period: string; generated_at: string }>;

  const snapshotMap = new Map(snapshotRows.map(r => [r.period, r.generated_at]));

  const weeks = weekEntries.map((entry) => ({
    week: entry.week,
    sessionCount: sessionCountMap.get(entry.week) ?? 0,
    hasSnapshot: snapshotMap.has(entry.week),
    generatedAt: snapshotMap.get(entry.week) ?? null,
  }));

  return c.json({ weeks });
});

// GET /api/reflect/snapshot
// Returns cached reflect results for a given period/project combo.
app.get('/snapshot', (c) => {
  const db = getDb();
  const period = c.req.query('period') || '30d';
  const project = c.req.query('project') || '__all__';
  const sourceScope = c.req.query('source') || '__all__';

  const row = db.prepare(
    `SELECT * FROM reflect_snapshots WHERE period = ? AND project_id = ? AND source_scope = ?`
  ).get(period, project, sourceScope) as {
    period: string;
    project_id: string;
    source_scope: string;
    results_json: string;
    generated_at: string;
    window_start: string | null;
    window_end: string;
    session_count: number;
    facet_count: number;
  } | undefined;

  if (!row) {
    return c.json({ snapshot: null });
  }

  let results: unknown;
  try {
    results = JSON.parse(row.results_json);
  } catch {
    // Corrupted snapshot data — treat as if no snapshot exists
    return c.json({ snapshot: null });
  }

  return c.json({
    snapshot: {
      period: row.period,
      projectId: row.project_id,
      sourceScope: row.source_scope,
      results,
      generatedAt: row.generated_at,
      windowStart: row.window_start,
      windowEnd: row.window_end,
      sessionCount: row.session_count,
      facetCount: row.facet_count,
    },
  });
});

export default app;
