import express from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { createRecommendationsRouter } from './routes/recommendations.js';
import { errorHandler } from './middleware/error-handler.js';

export function createApp(db: DatabaseSync) {
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (_request, response) => {
    try {
      db.prepare('SELECT 1').get();
      response.json({ status: 'ok', database: 'ok' });
    } catch {
      response.status(503).json({ status: 'error', database: 'unavailable' });
    }
  });

  app.use(createRecommendationsRouter(db));
  app.use(errorHandler);

  return app;
}
