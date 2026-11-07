import type { DatabaseSync } from 'node:sqlite';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { initializeSchema, openDatabase } from '../src/db/connection.js';
import { loadDataset, seedDatabase } from '../src/db/seed-data.js';
import { getScoredCircles } from '../src/recommendations/service.js';
import { SNAPSHOT_REFERENCE_DATE } from '../src/recommendations/scoring.js';

describe('new users, Circles, and taxonomy topics', () => {
  let db: DatabaseSync;
  const original = loadDataset();
  const userId = Math.max(...original.users.map(row => row.id)) + 1000;
  const firstCircleId = Math.max(...original.circles.map(row => row.id)) + 1000;
  const topicId = Math.max(...original.topics.map(row => row.id)) + 1000;
  const topic = 'decision-making';
  const circleIds = Array.from({ length: 6 }, (_, index) => firstCircleId + index);

  beforeEach(() => {
    db = openDatabase(':memory:'); initializeSchema(db);
    const data = structuredClone(original);
    data.topics.push({ id: topicId, slug: topic, label: 'Decision making', domain: 'content' });
    data.users.push({
      id: userId, first_name: 'New', last_name: 'Member', has_photo: false,
      bio: null, job_title: null, industry: null, company: null, location: null,
      joined_at: SNAPSHOT_REFERENCE_DATE, profile_completeness: 0, topic_interests: [topic],
    });
    const leaderId = original.users[0]!.id;
    for (const [index, id] of circleIds.entries()) {
      data.circles.push({
        id, name: `Decision making community ${index}`, slug: `decision-making-community-${index}`,
        topic: index === 1 ? null : topic, tags: index === 1 ? [topic] : [],
        description: 'A community focused on decision making.', cover_image_url: null,
        format: 'virtual', access: index === 3 ? 'unlisted' : 'public', join_policy: 'open',
        max_members: index === 2 ? 1 : null, member_count: index === 4 ? 2 : 1,
        created_at: '2026-01-01T00:00:00.000Z',
        last_activity_at: index === 5 ? '2026-01-01T00:00:00.000Z' : SNAPSHOT_REFERENCE_DATE,
        feed_posts_30d: index === 5 ? 0 : 20, chat_messages_30d: index === 5 ? 0 : 200,
      });
      data.memberships.push({ user_id: leaderId, circle_id: id, role: 'leader', joined_at: SNAPSHOT_REFERENCE_DATE });
    }
    data.memberships.push({ user_id: userId, circle_id: circleIds[4]!, role: 'leader', joined_at: SNAPSHOT_REFERENCE_DATE });
    seedDatabase(db, data);
  });
  afterEach(() => db.close());

  it('recommends new topic matches through the existing API and excludes new ineligible Circles', async () => {
    const response = await request(createApp(db)).get(`/users/${userId}/recommendations?limit=20`);
    expect(response.status).toBe(200);
    const rows = response.body.recommendations as { circle_id: number; primary_topic: string | null; explanation: string }[];
    expect(response.body.metadata.user_id).toBe(userId);
    expect(rows[0]).toMatchObject({ circle_id: circleIds[0], primary_topic: topic });
    expect(rows[0]!.explanation).toBe('Explore your interest in decision making with this Circle.');
    expect(rows.some(row => row.circle_id === circleIds[1])).toBe(true);
    expect(rows.some(row => circleIds.slice(2, 5).includes(row.circle_id))).toBe(false);
    const scored = getScoredCircles(db, userId);
    const active = scored.find(row => row.circle.id === circleIds[0])!;
    const secondary = scored.find(row => row.circle.id === circleIds[1])!;
    const dormant = scored.find(row => row.circle.id === circleIds[5])!;
    expect(active.relevanceScore).toBe(60);
    expect(secondary.relevanceScore).toBe(39);
    expect(dormant.inactivityPenalty).toBe(80);
    expect(active.totalScore).toBeGreaterThan(dormant.totalScore);
  });

  it('recognizes a new taxonomy phrase in a new user’s bio without a new alias or ID rule', async () => {
    db.prepare('DELETE FROM user_topic_interests WHERE user_id = ?').run(userId);
    db.prepare('UPDATE users SET bio = ? WHERE id = ?').run('I want to explore decision making.', userId);
    const response = await request(createApp(db)).get(`/users/${userId}/recommendations?limit=1`);
    expect(response.status).toBe(200);
    expect(response.body.recommendations[0].circle_id).toBe(circleIds[0]);
    expect(response.body.recommendations[0].explanation).toBe('Its focus on decision making reflects an interest suggested by your bio.');
  });

  it('handles the same newly added user as a cold start without inventing interests', async () => {
    db.prepare('DELETE FROM user_topic_interests WHERE user_id = ?').run(userId);
    const response = await request(createApp(db)).get(`/users/${userId}/recommendations?limit=3`);
    expect(response.status).toBe(200);
    for (const row of response.body.recommendations as { explanation: string }[]) {
      expect(row.explanation).not.toMatch(/your interest|your bio|nearby|your professional/);
    }
  });
});
