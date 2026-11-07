# Seed Dataset

Fully synthetic snapshot for Circle recommendation. The original JSON files are
shared inputs for the API and the optional ML experiment. Paths below are relative
to `ts-nodejs/`.

| File | Records | Contents |
| --- | ---: | --- |
| `data/topics.json` | 22 | Canonical content-topic taxonomy |
| `data/users.json` | 100 | Member profiles and explicit topic interests |
| `data/circles.json` | 40 | Circle metadata, capacity, and activity aggregates |
| `data/memberships.json` | 441 | User?Circle relationships and roles |
| `data/activity.json` | 386 | Feed posts and aggregate engagement counts |

## Fields and relationships

- **Topics:** positive integer `id`, unique `slug`, display `label`, and
  `domain: "content"`. Slugs connect user interests and Circle primary topics.
- **Users:** `id`, names, `has_photo`, nullable `bio`, `job_title`, `company`,
  `industry`, and `location`; `joined_at`, `profile_completeness` in `[0, 1]`,
  and `topic_interests` as a possibly empty array of topic slugs.
- **Circles:** `id`, `name`, unique `slug`, nullable `description`, `topic`, and
  `cover_image_url`; free-form `tags`; `format` (`in_person`, `virtual`, `hybrid`),
  `access` (`public`, `unlisted`), and `join_policy` (`open`, `request`).
  `member_count` is current snapshot size; null `max_members` means unlimited.
  `created_at`, `last_activity_at`, `feed_posts_30d`, and `chat_messages_30d`
  describe creation and activity.
- **Memberships:** `user_id` references users; `circle_id` references Circles.
  Each pair is unique, with `role` (`member`, `leader`) and `joined_at`.
  Leaders also belong to the Circle; a Circle can have multiple leaders.
- **Activity:** `id`, `circle_id`, `author_user_id`, `body`, `reaction_count`,
  `comment_count`, `save_count`, and `created_at`. Each author belongs to the
  referenced Circle. Engagement counts do not identify reacting users.

## Evaluation records

| Scenario | User | Seeded characteristics |
| --- | ---: | --- |
| Cold start | 42 | No memberships, stated interests, or usable profile signals |
| Direct matches | 7 | Leadership/public-speaking interests; eligible Circles #5 and #6 |
| Redundancy | 15 | Negotiation/confidence interests; near-identical Circles #10, #11, #12 |
| Availability/activity | 23 | Promotion interest; full #20, unlisted/dormant #21, healthy #22 |

Public dormant Circle #32 permits inactivity testing independently of visibility.
Circle #27 lacks a primary topic, tags, and description and remains a fallback
candidate. The dataset has no Circle location or user-attributed reaction events.

## Snapshot semantics

The generator's fixed reference is `2026-09-21T00:00:00.000Z`. Activity aggregates
are snapshot values, not windows recomputed against the wall clock. Some timestamps
are historically inconsistent; import validates timestamps and references without
requiring chronological ordering between entities. Original files remain inputs;
application import never rewrites them.

`generate.mjs` is the supplied deterministic generator. Regeneration replaces the
five JSON files; the normal application setup uses `npm run seed` to import them
without regeneration. Database mapping and constraints are documented in
[database.md](../docs/database.md).
