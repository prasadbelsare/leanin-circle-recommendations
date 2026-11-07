import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { circleSchema } from '../schemas/dataset.js';

export type EligibleCircle = z.infer<typeof circleSchema>;

export class UserNotFoundError extends Error {
  constructor(userId: number) {
    super(`User ${userId} does not exist`);
    this.name = 'UserNotFoundError';
  }
}

/** Candidates are returned in ID order; ranking happens later. */
export function getEligibleCircles(db: DatabaseSync, userId: number): EligibleCircle[] {
  z.number().int().positive().parse(userId);
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) {
    throw new UserNotFoundError(userId);
  }

  const rows = db.prepare(`
    SELECT c.*, (
      SELECT json_group_array(tag)
      FROM (
        SELECT tag FROM circle_tags WHERE circle_id = c.id ORDER BY tag
      )
    ) AS tags
    FROM circles AS c
    WHERE c.access = 'public'
      AND (c.max_members IS NULL OR c.member_count < c.max_members)
      AND NOT EXISTS (
        SELECT 1 FROM memberships AS m
        WHERE m.user_id = ? AND m.circle_id = c.id
      )
    ORDER BY c.id
  `).all(userId);

  return rows.map(row => circleSchema.parse({
    ...row,
    tags: typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags,
  }));
}
