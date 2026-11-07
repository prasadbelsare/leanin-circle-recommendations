import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeSchema, openDatabase } from '../src/db/connection.js';
import { loadDataset, seedDatabase } from '../src/db/seed-data.js';
import { getEligibleCircles, UserNotFoundError, type EligibleCircle } from '../src/recommendations/eligibility.js';
import type { Dataset } from '../src/schemas/dataset.js';

const data = loadDataset();
let db: DatabaseSync;

beforeEach(() => {
  db = openDatabase(':memory:');
  initializeSchema(db);
});
afterEach(() => db.close());

const candidateIds = (userId: number) => getEligibleCircles(db, userId).map(circle => circle.id);

describe('eligibility with seeded data', () => {
  beforeEach(() => { seedDatabase(db, data); });

  it('excludes joined, full, and unlisted Circles for every seeded user', () => {
    for (const user of data.users) {
      const joined = new Set(data.memberships.filter(m => m.user_id === user.id).map(m => m.circle_id));
      const expected = data.circles.filter(circle =>
        circle.access === 'public'
        && (circle.max_members === null || circle.member_count < circle.max_members)
        && !joined.has(circle.id)
      ).map(circle => circle.id).sort((a, b) => a - b);
      expect(candidateIds(user.id)).toEqual(expected);
    }
  });

  it('keeps public inactive Circle #32 eligible for cold-start user #42', () => {
    const circle = getEligibleCircles(db, 42).find(candidate => candidate.id === 32);
    expect(circle).toMatchObject({ access: 'public', feed_posts_30d: 0, last_activity_at: '2026-01-29T00:00:00.000Z' });
  });

  it('excludes #20 and #21 for user #23 while retaining #22', () => {
    const ids = candidateIds(23);
    expect(ids).not.toContain(20);
    expect(ids).not.toContain(21);
    expect(ids).toContain(22);
  });

  it('returns complete Circle records including normalized tags and nullable fields', () => {
    const circles = getEligibleCircles(db, 42);
    for (const circle of circles) {
      const original = data.circles.find(row => row.id === circle.id)!;
      expect(circle).toEqual({ ...original, tags: [...new Set(original.tags)].sort() });
    }
    expect(circles.find(circle => circle.id === 27)).toMatchObject({ topic: null, description: null, tags: [] });
  });
});

describe('eligibility edge cases with isolated fixtures', () => {
  function circle(id: number, overrides: Partial<EligibleCircle> = {}): EligibleCircle {
    return {
      ...data.circles[0]!,
      id,
      name: `Fixture ${id}`,
      slug: `fixture-${id}`,
      topic: null,
      tags: [],
      access: 'public',
      max_members: null,
      member_count: 0,
      ...overrides,
    };
  }

  function seedFixture(circles: EligibleCircle[], memberships: Dataset['memberships'] = []) {
    seedDatabase(db, {
      topics: [],
      users: [
        { ...data.users.find(user => user.id === 42)!, id: 1 },
        { ...data.users.find(user => user.id === 42)!, id: 2 },
      ],
      circles,
      memberships,
      activity: [],
    });
  }

  it('excludes both member and leader memberships, but not another user’s membership', () => {
    const joined_at = '2026-09-21T00:00:00.000Z';
    seedFixture([circle(1), circle(2), circle(3)], [
      { user_id: 1, circle_id: 1, role: 'member', joined_at },
      { user_id: 1, circle_id: 2, role: 'leader', joined_at },
      { user_id: 2, circle_id: 3, role: 'member', joined_at },
    ]);
    expect(candidateIds(1)).toEqual([3]);
  });

  it('excludes exactly full and over-capacity Circles, keeping available and uncapped ones', () => {
    seedFixture([
      circle(1, { max_members: 2, member_count: 2 }),
      circle(2, { max_members: 2, member_count: 3 }),
      circle(3, { max_members: 2, member_count: 1 }),
      circle(4, { max_members: null, member_count: 100_000 }),
    ]);
    expect(candidateIds(1)).toEqual([3, 4]);
  });

  it('keeps public request-to-join Circles and excludes unlisted Circles under either join policy', () => {
    seedFixture([
      circle(1, { join_policy: 'request' }),
      circle(2, { access: 'unlisted', join_policy: 'open' }),
      circle(3, { access: 'unlisted', join_policy: 'request' }),
      circle(4, { join_policy: 'open' }),
    ]);
    expect(candidateIds(1)).toEqual([1, 4]);
  });

  it('does not filter inactive Circles or personalize candidates using profile fields', () => {
    seedFixture([
      circle(1, { last_activity_at: '2020-01-01T00:00:00.000Z', feed_posts_30d: 0, chat_messages_30d: 0 }),
      circle(2),
    ]);
    const before = getEligibleCircles(db, 1);
    db.prepare('UPDATE users SET job_title = ?, bio = ?, industry = ? WHERE id = 1')
      .run('Engineering Manager', 'Interested in negotiation', 'Technology');
    db.prepare('INSERT INTO topics VALUES (?, ?, ?, ?)').run(1, 'negotiation', 'Negotiation', 'content');
    db.prepare('INSERT INTO user_topic_interests VALUES (?, ?)').run(1, 'negotiation');
    expect(getEligibleCircles(db, 1)).toEqual(before);
    expect(candidateIds(1)).toEqual([1, 2]);
  });

  it('returns an empty list when all Circles are ineligible or none exist', () => {
    seedFixture([circle(1, { access: 'unlisted' })]);
    expect(getEligibleCircles(db, 1)).toEqual([]);
    seedFixture([]);
    expect(getEligibleCircles(db, 1)).toEqual([]);
  });

  it('rejects invalid user IDs and distinguishes unknown users from empty results', () => {
    seedFixture([]);
    for (const id of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => getEligibleCircles(db, id)).toThrow();
    }
    expect(() => getEligibleCircles(db, 9999)).toThrow(UserNotFoundError);
  });
});
