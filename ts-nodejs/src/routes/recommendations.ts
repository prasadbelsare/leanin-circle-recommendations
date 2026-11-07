import { Router } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { getExplainedCircles } from '../recommendations/service.js';
import { recommendationParamsSchema, recommendationQuerySchema } from '../schemas/requests.js';

export function createRecommendationsRouter(db: DatabaseSync) {
  const router = Router();
  router.get('/users/:userId/recommendations', (request, response, next) => {
    const params = recommendationParamsSchema.safeParse(request.params);
    const query = recommendationQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      response.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Invalid request parameters.' } });
      return;
    }
    try {
      const rows = getExplainedCircles(db, params.data.userId, query.data.limit);
      response.json({
        metadata: { user_id: params.data.userId, requested_limit: query.data.limit, count: rows.length },
        recommendations: rows.map(row => ({
          rank: row.selection.rank,
          circle_id: row.circle.id,
          name: row.circle.name,
          ...(row.circle.description !== null ? { description: row.circle.description } : {}),
          primary_topic: row.circle.topic,
          format: row.circle.format,
          join_policy: row.circle.join_policy,
          explanation: row.explanation,
        })),
      });
    } catch (error) {
      next(error);
    }
  });
  return router;
}
