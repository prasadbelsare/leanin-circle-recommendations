import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { datasetSchema, type Dataset } from '../schemas/dataset.js';

export const defaultDataDirectory = new URL('../../data/', import.meta.url);

export function loadDataset(directory: URL | string = defaultDataDirectory): Dataset {
  const files = ['topics', 'users', 'circles', 'memberships', 'activity'] as const;
  const raw = Object.fromEntries(files.map(file => {
    const path = directory instanceof URL ? new URL(`${file}.json`, directory) : resolve(directory, `${file}.json`);
    try {
      return [file, JSON.parse(readFileSync(path, 'utf8')) as unknown];
    } catch (error) {
      throw new Error(`Failed to read ${file}.json`, { cause: error });
    }
  }));
  return datasetSchema.parse(raw);
}

export function seedDatabase(db: DatabaseSync, input: unknown) {
  const data = datasetSchema.parse(input);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      DELETE FROM activity;
      DELETE FROM memberships;
      DELETE FROM circle_tags;
      DELETE FROM user_topic_interests;
      DELETE FROM circles;
      DELETE FROM users;
      DELETE FROM topics;
    `);
    const insert = (table: string, rows: Record<string, SQLInputValue>[]) => {
      const first = rows[0];
      if (!first) return;

      // Table and column names come from the fixed mappings below.
      const columns = Object.keys(first);
      const statement = db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`);
      for (const row of rows) statement.run(...columns.map(column => row[column]!));
    };
    insert('topics', data.topics);
    insert('users', data.users.map(({ topic_interests: _interests, has_photo, ...user }) => ({ ...user, has_photo: Number(has_photo) })));
    insert('circles', data.circles.map(({ tags: _tags, ...circle }) => circle));
    insert('user_topic_interests', data.users.flatMap(user => [...new Set(user.topic_interests)].map(topic_slug => ({ user_id: user.id, topic_slug }))));
    insert('circle_tags', data.circles.flatMap(circle => [...new Set(circle.tags)].map(tag => ({ circle_id: circle.id, tag }))));
    insert('memberships', data.memberships);
    insert('activity', data.activity);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return Object.fromEntries(Object.entries(data).map(([file, rows]) => [file, rows.length]));
}
