import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeSchema, openDatabase } from '../src/db/connection.js';
import { loadDataset, seedDatabase } from '../src/db/seed-data.js';
import { datasetSchema } from '../src/schemas/dataset.js';

describe('SQLite schema and seed', () => {
  let db: DatabaseSync;
  const data = loadDataset();

  beforeEach(() => {
    db = openDatabase(':memory:');
    initializeSchema(db);
  });
  afterEach(() => db.close());

  it('loads all five datasets and can repeat the import without duplicating rows', () => {
    const expected = { topics: 22, users: 100, circles: 40, memberships: 441, activity: 386 };
    expect(seedDatabase(db, data)).toEqual(expected);
    initializeSchema(db);
    expect(seedDatabase(db, data)).toEqual(expected);
    for (const [table, count] of Object.entries(expected)) {
      expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count).toBe(count);
    }
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
  });

  it('preserves missing fields, uncapped capacity, and distinct interest/tag values', () => {
    seedDatabase(db, data);
    expect(db.prepare('SELECT bio, job_title, profile_completeness FROM users WHERE id = 42').get())
      .toEqual({ bio: null, job_title: null, profile_completeness: 0 });
    expect(db.prepare('SELECT topic, description FROM circles WHERE id = 27').get())
      .toEqual({ topic: null, description: null });
    expect(db.prepare('SELECT max_members FROM circles WHERE id = 1').get()?.max_members).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS count FROM circle_tags WHERE circle_id = 17 AND tag = ?').get('difficult-conversations')?.count).toBe(1);
    const interests = db.prepare('SELECT topic_slug FROM user_topic_interests WHERE user_id = 15 ORDER BY topic_slug').all();
    expect(interests).toEqual([{ topic_slug: 'confidence' }, { topic_slug: 'negotiation' }]);
  });

  it('enforces foreign keys, uniqueness, and domain constraints for direct SQL writes', () => {
    seedDatabase(db, data);
    expect(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
    expect(() => db.prepare('INSERT INTO user_topic_interests VALUES (?, ?)').run(9999, 'negotiation')).toThrow();
    expect(() => db.prepare('INSERT INTO user_topic_interests VALUES (?, ?)').run(42, 'unknown')).toThrow();
    expect(() => db.prepare('INSERT INTO memberships VALUES (?, ?, ?, ?)').run(7, 4, 'member', '2026-09-21T00:00:00.000Z')).toThrow();
    expect(() => db.prepare('UPDATE circles SET slug = ? WHERE id = 2').run('the-elevation-circle')).toThrow();
    expect(() => db.prepare('UPDATE circles SET access = ? WHERE id = 1').run('private')).toThrow();
    expect(() => db.prepare('UPDATE circles SET member_count = -1 WHERE id = 1').run()).toThrow();
    expect(() => db.prepare('UPDATE activity SET author_user_id = 42 WHERE id = 1').run()).toThrow();
  });

  it('rejects invalid data before changing existing rows', () => {
    seedDatabase(db, data);
    const invalid = structuredClone(data);
    invalid.users[0]!.profile_completeness = 2;
    expect(() => seedDatabase(db, invalid)).toThrow();
    expect(db.prepare('SELECT COUNT(*) AS count FROM users').get()?.count).toBe(100);
    expect(db.prepare('SELECT first_name FROM users WHERE id = 1').get()?.first_name).toBe(data.users[0]!.first_name);
  });

  it('validates IDs, references, membership pairs, authors, timestamps, and all file shapes', () => {
    const mutations = [
      (copy: typeof data) => { copy.users.push(copy.users[0]!); },
      (copy: typeof data) => { copy.circles[0]!.topic = 'unknown'; },
      (copy: typeof data) => { copy.users[0]!.topic_interests = ['unknown']; },
      (copy: typeof data) => { copy.memberships[0]!.user_id = 9999; },
      (copy: typeof data) => { copy.memberships.push(copy.memberships[0]!); },
      (copy: typeof data) => { copy.activity[0]!.author_user_id = 42; },
      (copy: typeof data) => { copy.activity[0]!.created_at = 'yesterday'; },
      (copy: typeof data) => { copy.topics[0]!.domain = 'invalid' as 'content'; },
    ];
    for (const mutate of mutations) {
      const copy = structuredClone(data);
      mutate(copy);
      expect(datasetSchema.safeParse(copy).success).toBe(false);
    }
  });

  it('rolls back every table if a database write fails partway through reseeding', () => {
    seedDatabase(db, data);
    db.exec(`CREATE TRIGGER fail_seed BEFORE INSERT ON activity
      BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END;`);
    const changed = structuredClone(data);
    changed.users[0]!.first_name = 'Changed';
    expect(() => seedDatabase(db, changed)).toThrow('simulated storage failure');
    expect(db.prepare('SELECT first_name FROM users WHERE id = 1').get()?.first_name).toBe(data.users[0]!.first_name);
    expect(db.prepare('SELECT COUNT(*) AS count FROM activity').get()?.count).toBe(386);
    expect(db.prepare('SELECT COUNT(*) AS count FROM memberships').get()?.count).toBe(441);
  });
});
