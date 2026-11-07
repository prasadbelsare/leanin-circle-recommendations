import type { DatabaseSync } from 'node:sqlite';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { initializeSchema, openDatabase } from '../src/db/connection.js';
import { loadDataset, seedDatabase } from '../src/db/seed-data.js';
import { getExplainedCircles, getScoredCircles } from '../src/recommendations/service.js';

const data = loadDataset();

interface Recommendation {
  rank: number;
  circle_id: number;
  name: string;
  description?: string;
  primary_topic: string | null;
  format: string;
  join_policy: string;
  explanation: string;
}

describe('GET /users/:userId/recommendations', () => {
  let db: DatabaseSync;
  let closed: boolean;
  beforeEach(() => {
    db = openDatabase(':memory:'); initializeSchema(db); seedDatabase(db, data);
    closed = false;
  });
  afterEach(() => { if (!closed) db.close(); });

  it('defaults to five recommendations and returns the requested public fields', async () => {
    const response = await request(createApp(db)).get('/users/7/recommendations');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/json/);
    expect(response.body.metadata).toEqual({ user_id: 7, requested_limit: 5, count: 5 });
    expect(response.body.recommendations.map((row: Recommendation) => row.circle_id)).toEqual([35, 6, 34, 1, 5]);
    expect(response.body.recommendations[0]).toEqual({
      rank: 1, circle_id: 35, name: 'Board-Ready Women',
      description: data.circles.find(circle => circle.id === 35)!.description,
      primary_topic: 'leadership-skills', format: 'in_person', join_policy: 'open',
      explanation: 'Explore your interest in leadership skills with this Circle.',
    });
    expect(response.body).not.toHaveProperty('matchingEvidence');
    expect(response.body.recommendations[0]).not.toHaveProperty('selection');
    expect(response.body.recommendations[0]).not.toHaveProperty('totalScore');
  });

  it.each([1, 3, 5, 10, 20])('honors limit %i, preserving service order and explanations', async limit => {
    const expected = getExplainedCircles(db, 42, limit);
    const response = await request(createApp(db)).get(`/users/42/recommendations?limit=${limit}`);
    expect(response.status).toBe(200);
    expect(response.body.metadata).toEqual({ user_id: 42, requested_limit: limit, count: expected.length });
    expect(response.body.recommendations.map((row: Recommendation) => row.circle_id)).toEqual(expected.map(row => row.circle.id));
    expect(response.body.recommendations.map((row: Recommendation) => row.explanation)).toEqual(expected.map(row => row.explanation));
    expect(response.body.recommendations.map((row: Recommendation) => row.rank)).toEqual(expected.map((_, index) => index + 1));
  });

  it('returns fewer results than requested instead of filling with ineligible candidates', async () => {
    db.prepare("UPDATE circles SET access = 'unlisted' WHERE id NOT IN (5, 6)").run();
    const response = await request(createApp(db)).get('/users/42/recommendations?limit=20');
    expect(response.status).toBe(200);
    expect(response.body.metadata).toEqual({ user_id: 42, requested_limit: 20, count: 2 });
    expect(response.body.recommendations.map((row: Recommendation) => row.circle_id).sort((a: number, b: number) => a - b)).toEqual([5, 6]);
  });

  it('returns 200 and an empty list for an existing user without eligible Circles', async () => {
    db.prepare("UPDATE circles SET access = 'unlisted'").run();
    const response = await request(createApp(db)).get('/users/7/recommendations');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ metadata: { user_id: 7, requested_limit: 5, count: 0 }, recommendations: [] });
  });

  it.each(['0', '-1', '1.5', '7x', 'abc', 'NaN', 'Infinity', '1e1', '0x7', '07', '+7', '%207', '9007199254740992', '7%20OR%201=1'])('rejects invalid user ID %s with 400', async id => {
    const response = await request(createApp(db)).get(`/users/${id}/recommendations`);
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: { code: 'INVALID_REQUEST', message: 'Invalid request parameters.' } });
  });

  it.each(['', '0', '-1', '21', '1.5', 'abc', 'NaN', 'Infinity', '1e1', '0x5', '05', '%205', '%2B5', '9007199254740992'])('rejects invalid limit %s with 400', async limit => {
    const response = await request(createApp(db)).get(`/users/7/recommendations?limit=${limit}`);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_REQUEST');
  });

  it.each(['limit=1&limit=3', 'limit[]=1', 'limit[x]=1', 'limit=5&debug=true'])('rejects ambiguous or unsupported query parameters: %s', async query => {
    const response = await request(createApp(db)).get(`/users/7/recommendations?${query}`);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_REQUEST');
  });

  it('returns 404 for an unknown valid user ID, even with no candidates', async () => {
    db.prepare("UPDATE circles SET access = 'unlisted'").run();
    const response = await request(createApp(db)).get('/users/9999/recommendations');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: { code: 'USER_NOT_FOUND', message: 'User not found.' } });
  });

  it.each([1, 7, 15, 23, 42])('never returns full, unlisted, or joined Circles for user %i', async userId => {
    const before = getScoredCircles(db, userId);
    const response = await request(createApp(db)).get(`/users/${userId}/recommendations?limit=20`);
    expect(response.status).toBe(200);
    const joined = new Set(data.memberships.filter(m => m.user_id === userId).map(m => m.circle_id));
    for (const row of response.body.recommendations as Recommendation[]) {
      const circle = data.circles.find(circle => circle.id === row.circle_id)!;
      expect(circle.access).toBe('public');
      expect(circle.max_members === null || circle.member_count < circle.max_members).toBe(true);
      expect(joined.has(circle.id)).toBe(false);
      expect(row.primary_topic).toBe(circle.topic);
      expect(row.join_policy).toBe(circle.join_policy);
      expect(row.description).toBe(circle.description ?? undefined);
    }
    expect(getScoredCircles(db, userId)).toEqual(before);
  });

  it('returns approval requirements accurately for user #23’s leading match', async () => {
    const response = await request(createApp(db)).get('/users/23/recommendations');
    expect(response.body.recommendations[0]).toMatchObject({ circle_id: 22, join_policy: 'request' });
    expect(response.body.recommendations[0].explanation).toContain('membership requires approval');
    expect(response.body.recommendations.some((row: Recommendation) => [20, 21, 23].includes(row.circle_id))).toBe(false);
  });

  it('omits unavailable descriptions, keeps null primary topics, and uses truthful generic wording', async () => {
    db.prepare("UPDATE circles SET access = 'unlisted' WHERE id != 27").run();
    const response = await request(createApp(db)).get('/users/42/recommendations');
    expect(response.body.metadata.count).toBe(1);
    const row = response.body.recommendations[0];
    expect(row).not.toHaveProperty('description');
    expect(row.primary_topic).toBeNull();
    expect(row.explanation).toBe('Explore a virtual Circle with recent group activity; membership requires approval.');
  });

  it('keeps eligible dormant Circles available without changing their penalty or calling them active', async () => {
    db.prepare("UPDATE circles SET access = 'unlisted' WHERE id != 32").run();
    const response = await request(createApp(db)).get('/users/42/recommendations');
    expect(response.status).toBe(200);
    expect(response.body.recommendations[0].circle_id).toBe(32);
    expect(response.body.recommendations[0].explanation).toContain('recent activity is limited');
    expect(getScoredCircles(db, 42)[0]!.inactivityPenalty).toBe(80);
  });

  it('returns deterministic responses without modifying existing reranking results', async () => {
    const before = getExplainedCircles(db, 7);
    const app = createApp(db);
    const first = await request(app).get('/users/7/recommendations');
    const second = await request(app).get('/users/7/recommendations');
    expect(second.body).toEqual(first.body);
    expect(getExplainedCircles(db, 7)).toEqual(before);
  });

  it('returns generic JSON for unexpected server errors without exposing internal details', async () => {
    const app = createApp(db);
    db.close(); closed = true;
    const response = await request(app).get('/users/7/recommendations');
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Unable to load recommendations.' } });
    expect(response.text).not.toMatch(/sqlite|stack|database|SELECT|[A-Z]:\\/i);
  });

  it('handles malformed URL encoding as an invalid request rather than exposing a stack', async () => {
    const response = await request(createApp(db)).get('/users/%E0%A4%A/recommendations');
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_REQUEST');
  });

  it('treats internal dataset validation failures as 500, not a client validation error', async () => {
    db.prepare('UPDATE circles SET cover_image_url = ? WHERE id = 35').run('invalid-url');
    const response = await request(createApp(db)).get('/users/7/recommendations');
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Unable to load recommendations.' } });
    expect(response.text).not.toMatch(/Zod|cover_image_url|invalid-url/);
  });
});
