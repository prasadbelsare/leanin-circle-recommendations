import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { activitySchema, userSchema } from '../schemas/dataset.js';

export function loadScoringData(db: DatabaseSync, userId: number) {
  const profileSchema = userSchema.pick({ bio: true, job_title: true, industry: true, topic_interests: true });
  const user = db.prepare('SELECT bio, job_title, industry FROM users WHERE id = ?').get(userId);
  const interests = db.prepare('SELECT topic_slug FROM user_topic_interests WHERE user_id = ? ORDER BY topic_slug').all(userId);
  const profile = profileSchema.parse({ ...user, topic_interests: interests.map(row => row.topic_slug) });
  const taxonomy = z.array(z.string()).parse(db.prepare('SELECT slug FROM topics ORDER BY slug').all().map(row => row.slug));
  const posts = z.array(activitySchema.pick({
    circle_id: true, created_at: true, reaction_count: true, comment_count: true, save_count: true,
  })).parse(db.prepare(`
    SELECT circle_id, created_at, reaction_count, comment_count, save_count
    FROM activity ORDER BY id
  `).all());
  return { profile, taxonomy, posts };
}
