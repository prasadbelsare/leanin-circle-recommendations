import { z } from 'zod';

const id = z.number().int().positive();
const count = z.number().int().nonnegative();
const text = z.string().trim().min(1);
const timestamp = z.iso.datetime();
const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const topicSchema = z.strictObject({
  id, slug, label: text, domain: z.literal('content'),
});

export const userSchema = z.strictObject({
  id,
  first_name: text,
  last_name: text,
  has_photo: z.boolean(),
  bio: z.string().nullable(),
  job_title: z.string().nullable(),
  company: z.string().nullable(),
  industry: z.string().nullable(),
  location: z.string().nullable(),
  joined_at: timestamp,
  topic_interests: z.array(slug),
  profile_completeness: z.number().min(0).max(1),
});

export const circleSchema = z.strictObject({
  id,
  name: text,
  slug,
  description: z.string().nullable(),
  topic: slug.nullable(),
  tags: z.array(text),
  cover_image_url: z.url().nullable(),
  format: z.enum(['in_person', 'virtual', 'hybrid']),
  access: z.enum(['public', 'unlisted']),
  join_policy: z.enum(['open', 'request']),
  max_members: id.nullable(),
  member_count: count,
  created_at: timestamp,
  last_activity_at: timestamp,
  feed_posts_30d: count,
  chat_messages_30d: count,
});

export const membershipSchema = z.strictObject({
  user_id: id,
  circle_id: id,
  role: z.enum(['member', 'leader']),
  joined_at: timestamp,
});

export const activitySchema = z.strictObject({
  id,
  circle_id: id,
  author_user_id: id,
  body: text,
  reaction_count: count,
  comment_count: count,
  save_count: count,
  created_at: timestamp,
});

export const datasetSchema = z.strictObject({
  topics: z.array(topicSchema),
  users: z.array(userSchema),
  circles: z.array(circleSchema),
  memberships: z.array(membershipSchema),
  activity: z.array(activitySchema),
}).superRefine((data, context) => {
  const issue = (path: (string | number)[], message: string) =>
    context.addIssue({ code: 'custom', path, message });
  const unique = (values: (string | number)[], file: string, field: string) => {
    const seen = new Set<string | number>();
    values.forEach((value, index) => {
      if (seen.has(value)) issue([file, index, field], `Duplicate ${field}: ${value}`);
      seen.add(value);
    });
  };
  for (const file of ['topics', 'users', 'circles', 'activity'] as const) {
    unique(data[file].map(row => row.id), file, 'id');
  }
  unique(data.topics.map(row => row.slug), 'topics', 'slug');
  unique(data.circles.map(row => row.slug), 'circles', 'slug');
  unique(data.memberships.map(row => `${row.user_id}:${row.circle_id}`), 'memberships', 'user_id/circle_id');

  const users = new Set(data.users.map(row => row.id));
  const circles = new Set(data.circles.map(row => row.id));
  const topics = new Set(data.topics.map(row => row.slug));
  const memberships = new Set(data.memberships.map(row => `${row.user_id}:${row.circle_id}`));

  data.users.forEach((row, index) => row.topic_interests.forEach((topic, topicIndex) => {
    if (!topics.has(topic)) issue(['users', index, 'topic_interests', topicIndex], `Unknown topic: ${topic}`);
  }));
  data.circles.forEach((row, index) => {
    if (row.topic !== null && !topics.has(row.topic)) issue(['circles', index, 'topic'], `Unknown topic: ${row.topic}`);
  });
  data.memberships.forEach((row, index) => {
    if (!users.has(row.user_id)) issue(['memberships', index, 'user_id'], `Unknown user: ${row.user_id}`);
    if (!circles.has(row.circle_id)) issue(['memberships', index, 'circle_id'], `Unknown Circle: ${row.circle_id}`);
  });
  data.activity.forEach((row, index) => {
    if (!circles.has(row.circle_id)) issue(['activity', index, 'circle_id'], `Unknown Circle: ${row.circle_id}`);
    if (!users.has(row.author_user_id)) issue(['activity', index, 'author_user_id'], `Unknown user: ${row.author_user_id}`);
    if (!memberships.has(`${row.author_user_id}:${row.circle_id}`)) {
      issue(['activity', index, 'author_user_id'], 'Post author must be a member of its Circle');
    }
  });
});

export type Dataset = z.infer<typeof datasetSchema>;
