/**
 * GET /api/analysis/queue
 *
 * Returns current analysis_queue status for dashboard polling.
 * Dashboard polls at 5s intervals when pending > 0 or processing > 0,
 * and stops polling when both reach 0.
 */

import { Hono } from 'hono';
import {
  enqueueBatch,
  getQueueStatus,
  QueueBatchValidationError,
} from '@code-insights/cli/db/queue';

export interface AnalysisQueueRouterOptions {
  wake: () => void;
}

export function createAnalysisQueueRouter({
  wake,
}: AnalysisQueueRouterOptions): Hono {
  const app = new Hono();

  // GET /api/analysis/queue
  // Returns counts by status and details for active/pending/failed items.
  // Returns 200 with empty items[] when queue is empty.
  app.get('/', (c) => {
    const status = getQueueStatus();
    return c.json(status);
  });

  app.post('/', async (c) => {
    const body = await c.req.json<unknown>();
    if (
      !body
      || typeof body !== 'object'
      || Array.isArray(body)
      || Object.keys(body).length !== 1
      || !Object.prototype.hasOwnProperty.call(body, 'sessionIds')
    ) {
      return c.json({ error: 'Expected a sessionIds-only batch request' }, 400);
    }

    const sessionIds = (body as { sessionIds?: unknown }).sessionIds;
    if (
      !Array.isArray(sessionIds)
      || sessionIds.length < 1
      || sessionIds.length > 500
      || sessionIds.some((sessionId) => (
        typeof sessionId !== 'string' || sessionId.trim().length === 0
      ))
    ) {
      return c.json({
        error: 'sessionIds must contain between 1 and 500 non-empty strings',
      }, 400);
    }

    try {
      const batch = enqueueBatch(sessionIds, 'provider');
      wake();
      return c.json({ batch }, 202);
    } catch (error) {
      if (
        error instanceof QueueBatchValidationError
        && error.invalidSessionIds.length > 0
      ) {
        return c.json({
          error: 'Sessions are missing or deleted',
          sessionIds: error.invalidSessionIds,
        }, 404);
      }
      throw error;
    }
  });

  return app;
}

const app = createAnalysisQueueRouter({ wake: () => {} });

export default app;
