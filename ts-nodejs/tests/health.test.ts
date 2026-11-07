import type { DatabaseSync } from 'node:sqlite';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { initializeSchema, openDatabase } from '../src/db/connection.js';

describe('GET /health', () => {
  let db: DatabaseSync;
  let closed: boolean;
  beforeEach(() => {
    db = openDatabase(':memory:');
    initializeSchema(db);
    closed = false;
  });
  afterEach(() => { if (!closed) db.close(); });

  it('returns 200 when SQLite responds, without requiring seed data', async () => {
    const response = await request(createApp(db)).get('/health');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/json/);
    expect(response.body).toEqual({ status: 'ok', database: 'ok' });
  });

  it('returns 503 without leaking database errors when SQLite is unavailable', async () => {
    const app = createApp(db);
    db.close();
    closed = true;
    const response = await request(app).get('/health');
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: 'error', database: 'unavailable' });
  });
});
