import { Hono } from 'hono';
import { getDb } from '@code-insights/cli/db/client';
import { recalculateUsageStats } from '@code-insights/cli/db/write';
import { parseIntParam } from '../utils.js';

/** Escape SQLite LIKE wildcard characters so user input is treated as literal text. */
function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, '\\$&');
}

/** ISO 8601 date/datetime — accepts YYYY-MM-DD and YYYY-MM-DDTHH:MM:SSZ-style strings. */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T[\d:.Z+\-]+)?$/;

const app = new Hono();

app.get('/', (c) => {
  const db = getDb();
  const {
    projectId,
    sourceTool,
    character,
    status,
    outcome,
    limit,
    offset,
    q,
    from,
    to,
    includeSignals,
  } = c.req.query();

  // Validate from/to are ISO 8601 date strings before passing to SQLite comparisons.
  // Invalid date strings in SQLite produce silent wrong results rather than errors.
  if (from && !ISO_DATE_RE.test(from)) {
    return c.json({ error: 'Invalid from: must be an ISO 8601 date (YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ)' }, 400);
  }
  if (to && !ISO_DATE_RE.test(to)) {
    return c.json({ error: 'Invalid to: must be an ISO 8601 date (YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ)' }, 400);
  }

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (projectId) {
    conditions.push('project_id = ?');
    params.push(projectId);
  }
  if (sourceTool) {
    conditions.push('source_tool = ?');
    params.push(sourceTool);
  }
  if (character) {
    conditions.push('session_character = ?');
    params.push(character);
  }
  if (status && status !== 'all') {
    if (status !== 'analyzed' && status !== 'unanalyzed') {
      return c.json({ error: 'Invalid status: expected analyzed or unanalyzed' }, 400);
    }
    conditions.push(`${status === 'analyzed' ? '' : 'NOT '}EXISTS (
      SELECT 1 FROM insights core
      WHERE core.session_id = sessions.id
        AND core.type IN ('summary', 'decision', 'learning', 'technique')
    )`);
  }
  if (outcome && outcome !== 'all') {
    const validOutcomes = new Set(['success', 'partial', 'blocked', 'abandoned']);
    if (!validOutcomes.has(outcome)) {
      return c.json({ error: 'Invalid outcome filter' }, 400);
    }
    conditions.push(`EXISTS (
      SELECT 1 FROM insights summary
      WHERE summary.session_id = sessions.id
        AND summary.type = 'summary'
        AND json_valid(summary.metadata)
        AND json_extract(summary.metadata, '$.outcome') = ?
    )`);
    params.push(outcome);
  }
  if (q) {
    const likeParam = `%${escapeLike(q)}%`;
    conditions.push("(custom_title LIKE ? ESCAPE '\\' OR generated_title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR project_name LIKE ? ESCAPE '\\')");
    params.push(likeParam, likeParam, likeParam, likeParam);
  }
  if (from) {
    conditions.push('started_at >= ?');
    params.push(from);
  }
  if (to) {
    conditions.push('started_at <= ?');
    params.push(to);
  }
  conditions.push('deleted_at IS NULL');
  const where = `WHERE ${conditions.join(' AND ')}`;
  const totalRow = db.prepare(`
    SELECT COUNT(*) AS count
    FROM sessions
    ${where}
  `).get(...params) as { count: number };
  const pageLimit = Math.min(parseIntParam(limit, 50), 5000);
  const pageOffset = parseIntParam(offset, 0);
  const sessions = db.prepare(`
    SELECT id, project_id, project_name, project_path, git_remote_url,
           summary, custom_title, generated_title, title_source, session_character,
           started_at, ended_at, message_count, user_message_count,
           assistant_message_count, tool_call_count, git_branch,
           claude_version, source_tool, device_id, device_hostname,
           device_platform, synced_at, total_input_tokens, total_output_tokens,
           cache_creation_tokens, cache_read_tokens, estimated_cost_usd,
           models_used, primary_model, usage_source,
           compact_count, auto_compact_count, slash_commands
    FROM sessions
    ${where}
    ORDER BY started_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageLimit, pageOffset);

  if (includeSignals !== 'true') {
    return c.json({ sessions, total: totalRow.count, limit: pageLimit, offset: pageOffset });
  }
  if (sessions.length === 0) {
    return c.json({
      sessions,
      signals: [],
      total: totalRow.count,
      limit: pageLimit,
      offset: pageOffset,
    });
  }

  const sessionIds = (sessions as Array<{ id: string }>).map((session) => session.id);
  const placeholders = sessionIds.map(() => '?').join(', ');
  const signalRows = db.prepare(`
    SELECT
      i.session_id,
      SUM(CASE WHEN i.type = 'summary' THEN 1 ELSE 0 END) AS summary_count,
      SUM(CASE WHEN i.type = 'decision' THEN 1 ELSE 0 END) AS decision_count,
      SUM(CASE WHEN i.type = 'learning' THEN 1 ELSE 0 END) AS learning_count,
      SUM(CASE WHEN i.type = 'technique' THEN 1 ELSE 0 END) AS technique_count,
      SUM(CASE WHEN i.type = 'prompt_quality' THEN 1 ELSE 0 END) AS prompt_quality_count,
      MAX(CASE
        WHEN i.type = 'summary' AND json_valid(i.metadata)
        THEN json_extract(i.metadata, '$.outcome')
        ELSE NULL
      END) AS outcome,
      MAX(CASE
        WHEN i.type = 'prompt_quality' AND json_valid(i.metadata)
        THEN COALESCE(
          json_extract(i.metadata, '$.efficiency_score'),
          json_extract(i.metadata, '$.efficiencyScore')
        )
        ELSE NULL
      END) AS prompt_quality_score,
      MAX(CASE WHEN i.type IN ('summary', 'decision', 'learning', 'technique') THEN 1 ELSE 0 END) AS is_analyzed
    FROM insights i
    WHERE i.session_id IN (${placeholders})
    GROUP BY i.session_id
  `).all(...sessionIds) as Array<{
    session_id: string;
    summary_count: number;
    decision_count: number;
    learning_count: number;
    technique_count: number;
    prompt_quality_count: number;
    outcome: string | null;
    prompt_quality_score: number | null;
    is_analyzed: number;
  }>;

  const signals = signalRows.map((row) => ({
    session_id: row.session_id,
    insight_counts: {
      summary: row.summary_count,
      decision: row.decision_count,
      learning: row.learning_count,
      technique: row.technique_count,
      prompt_quality: row.prompt_quality_count,
    },
    outcome: row.outcome,
    prompt_quality_score: row.prompt_quality_score,
    is_analyzed: row.is_analyzed === 1,
  }));

  return c.json({
    sessions,
    signals,
    total: totalRow.count,
    limit: pageLimit,
    offset: pageOffset,
  });
});

// GET /api/sessions/deleted/count — count of soft-deleted sessions for a project
// IMPORTANT: registered before /:id so "deleted" isn't matched as a session ID
app.get('/deleted/count', (c) => {
  const db = getDb();
  const { projectId } = c.req.query();
  let row: { count: number };
  if (projectId) {
    row = db.prepare(
      `SELECT COUNT(*) AS count FROM sessions WHERE deleted_at IS NOT NULL AND project_id = ?`
    ).get(projectId) as { count: number };
  } else {
    row = db.prepare(
      `SELECT COUNT(*) AS count FROM sessions WHERE deleted_at IS NOT NULL`
    ).get() as { count: number };
  }
  return c.json({ count: row.count });
});

app.get('/:id', (c) => {
  const db = getDb();
  const session = db.prepare(`
    SELECT id, project_id, project_name, project_path, git_remote_url,
           summary, custom_title, generated_title, title_source, session_character,
           started_at, ended_at, message_count, user_message_count,
           assistant_message_count, tool_call_count, git_branch,
           claude_version, source_tool, device_id, device_hostname,
           device_platform, synced_at, total_input_tokens, total_output_tokens,
           cache_creation_tokens, cache_read_tokens, estimated_cost_usd,
           models_used, primary_model, usage_source,
           compact_count, auto_compact_count, slash_commands
    FROM sessions WHERE id = ? AND deleted_at IS NULL
  `).get(c.req.param('id'));
  if (!session) return c.json({ error: 'Not found' }, 404);
  return c.json({ session });
});

app.patch('/:id', async (c) => {
  const db = getDb();
  const body = await c.req.json<{ customTitle?: string }>();
  const { customTitle } = body;
  if (customTitle === undefined) {
    return c.json({ error: 'customTitle is required' }, 400);
  }
  const result = db.prepare(
    'UPDATE sessions SET custom_title = ? WHERE id = ? AND deleted_at IS NULL'
  ).run(customTitle || null, c.req.param('id'));
  if (result.changes === 0) return c.json({ error: 'Not found' }, 404);
  return c.json({ ok: true });
});

app.delete('/:id', (c) => {
  const db = getDb();
  const softDelete = db.transaction(() => {
    const result = db.prepare(
      `UPDATE sessions SET deleted_at = datetime('now') WHERE id = ? AND deleted_at IS NULL`
    ).run(c.req.param('id'));
    if (result.changes > 0) {
      recalculateUsageStats(db);
    }
    return result;
  });
  const result = softDelete();
  if (result.changes === 0) return c.json({ error: 'Not found' }, 404);
  return c.json({ ok: true });
});

export default app;
