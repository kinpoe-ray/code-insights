import { Hono } from 'hono';
import { getDb } from '@code-insights/cli/db/client';
import {
  sanitizePromptQualityMessageReferences,
  sanitizeSessionMessageReferences,
} from '@code-insights/cli/analysis/message-references';
import type {
  AnalysisResponse,
  PromptQualityResponse,
} from '@code-insights/cli/analysis/prompt-types';
import { randomUUID } from 'crypto';
import { parseIntParam } from '../utils.js';
import { loadSessionMessages } from './route-helpers.js';

/** Escape SQLite LIKE wildcard characters so user input is treated as literal text. */
function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, '\\$&');
}

const app = new Hono();

const VALID_TYPES = ['summary', 'decision', 'learning', 'technique', 'prompt_quality'] as const;

app.get('/', (c) => {
  const db = getDb();
  const { projectId, sessionId, type, limit, offset, q } = c.req.query();

  const conditions: string[] = ['s.deleted_at IS NULL'];
  const params: (string | number)[] = [];

  if (projectId) {
    conditions.push('i.project_id = ?');
    params.push(projectId);
  }
  if (sessionId) {
    conditions.push('i.session_id = ?');
    params.push(sessionId);
  }
  if (type) {
    conditions.push('i.type = ?');
    params.push(type);
  }
  if (q) {
    const likeParam = `%${escapeLike(q)}%`;
    conditions.push("(i.title LIKE ? ESCAPE '\\' OR i.content LIKE ? ESCAPE '\\' OR i.summary LIKE ? ESCAPE '\\')");
    params.push(likeParam, likeParam, likeParam);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const insights = db.prepare(`
    SELECT i.id, i.session_id, i.project_id, i.project_name, i.type, i.title, i.content,
           i.summary, i.bullets, i.confidence, i.source, i.metadata, i.timestamp,
           i.created_at, i.scope, i.analysis_version, i.linked_insight_ids
    FROM insights i
    JOIN sessions s ON i.session_id = s.id
    ${where}
    ORDER BY i.timestamp DESC
    LIMIT ? OFFSET ?
  `).all(...params, parseIntParam(limit, 5000), parseIntParam(offset, 0));

  return c.json({ insights });
});

app.post('/', async (c) => {
  const db = getDb();
  const body = await c.req.json<{
    sessionId: string;
    projectId: string;
    projectName?: string;   // optional — defaults to ''
    type: string;
    title: string;
    content: string;
    summary?: string;       // optional — defaults to ''
    bullets?: string[];
    confidence?: number;    // optional — defaults to 0
    metadata?: Record<string, unknown>;
  }>();

  // Validate required string fields
  const required = ['sessionId', 'projectId', 'type', 'title', 'content'] as const;
  for (const field of required) {
    if (!body[field] || typeof body[field] !== 'string') {
      return c.json({ error: `Missing or invalid field: ${field}` }, 400);
    }
  }

  // Validate type is one of the known insight types
  if (!VALID_TYPES.includes(body.type as typeof VALID_TYPES[number])) {
    return c.json({ error: `type must be one of: ${VALID_TYPES.join(', ')}` }, 400);
  }

  // Validate confidence is a finite number if provided
  if (body.confidence !== undefined && (typeof body.confidence !== 'number' || !Number.isFinite(body.confidence))) {
    return c.json({ error: 'confidence must be a finite number' }, 400);
  }

  const id = randomUUID();
  const now = new Date().toISOString();

  try {
    const persist = db.transaction((): { error?: string } => {
      const sessionProject = db.prepare(`
        SELECT project_id, project_name
        FROM sessions
        WHERE id = ? AND deleted_at IS NULL
      `).get(body.sessionId) as {
        project_id: string;
        project_name: string;
      } | undefined;
      if (!sessionProject) return { error: 'Invalid sessionId' };
      if (sessionProject.project_id !== body.projectId) {
        return { error: 'projectId does not match the session project' };
      }

      let metadata = body.metadata;
      if (body.type === 'decision' || body.type === 'learning') {
        const rawMetadata = (
          metadata !== null
          && typeof metadata === 'object'
          && !Array.isArray(metadata)
        ) ? metadata : {};
        const sanitized = sanitizeSessionMessageReferences({
          summary: { title: '', content: '', bullets: [] },
          decisions: body.type === 'decision' ? [{
            title: body.title,
            reasoning: body.content,
            evidence: rawMetadata.evidence as string[] | undefined,
          }] : [],
          learnings: body.type === 'learning' ? [{
            title: body.title,
            takeaway: body.content,
            evidence: rawMetadata.evidence as string[] | undefined,
          }] : [],
        } satisfies AnalysisResponse, loadSessionMessages(db, body.sessionId));

        const sanitizedInsight = body.type === 'decision'
          ? sanitized.decisions[0]
          : sanitized.learnings[0];
        if (!sanitizedInsight) {
          return {
            error: `${body.type} requires at least one valid evidence reference`,
          };
        }
        metadata = {
          ...rawMetadata,
          evidence: sanitizedInsight.evidence,
        };
      }
      if (body.type === 'prompt_quality' && metadata !== undefined && metadata !== null) {
        if (typeof metadata !== 'object' || Array.isArray(metadata)) {
          return { error: 'prompt_quality metadata must be an object' };
        }
        metadata = {
          ...sanitizePromptQualityMessageReferences(
            metadata as unknown as PromptQualityResponse,
            loadSessionMessages(db, body.sessionId),
          ),
        };
      }

      db.prepare(`
        INSERT INTO insights (
          id, session_id, project_id, project_name, type, title, content,
          summary, bullets, confidence, source, metadata, timestamp, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'llm', ?, ?, ?)
      `).run(
        id,
        body.sessionId,
        body.projectId,
        sessionProject.project_name,
        body.type,
        body.title,
        body.content,
        body.summary ?? '',
        body.bullets ? JSON.stringify(body.bullets) : null,
        body.confidence ?? 0,
        metadata ? JSON.stringify(metadata) : null,
        now,
        now,
      );
      return {};
    });
    const result = persist();
    if (result.error) return c.json({ error: result.error }, 400);
  } catch (err) {
    if (err instanceof Error && err.message.includes('FOREIGN KEY constraint failed')) {
      return c.json({ error: 'Invalid sessionId or projectId' }, 400);
    }
    throw err;
  }

  return c.json({ id }, 201);
});

app.delete('/:id', (c) => {
  const db = getDb();
  const result = db.prepare('DELETE FROM insights WHERE id = ?').run(c.req.param('id'));
  if (result.changes === 0) return c.json({ error: 'Not found' }, 404);
  return c.json({ ok: true });
});

export default app;
