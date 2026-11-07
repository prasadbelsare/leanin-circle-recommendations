# Database design

SQLite stores the supplied snapshot in seven strict tables: topics, users, circles,
memberships, activity, user_topic_interests, and circle_tags. Original JSON files
are inputs and are never rewritten by the application.

- Topic slugs are unique natural keys shared by Circle topics and explicit user
  interests. Those references have foreign keys. Tags remain free-form text.
- Explicit interests are stored separately from user profile text. Inferred signals are
  computed at scoring time and remain distinct from stored explicit interests.
- Memberships use `(user_id, circle_id)` as a primary key. Leaders are members
  distinguished by role; multiple leaders are supported. Activity additionally
  references that composite key, enforcing the supplied snapshot's guarantee that
  authors belong to the Circle. A future membership-deletion feature would need
  to revisit this constraint to retain historical posts.
- Interest and tag join tables use composite primary keys. Repeated tags/interests
  within a record are deduplicated during import; repeated entity IDs, slugs, or
  membership pairs are rejected.
- Nullable profile fields, Circle topics/descriptions/images, and uncapped
  `max_members` are retained. Capacity and member count are separate snapshot
  fields; no constraint requires count to be below capacity, so full or
  over-capacity Circles can be represented. No eligibility filters run on import.
- CHECK constraints enforce enums, nonnegative counts, booleans, and profile
  completeness bounds. Zod validates JSON types, safe integer IDs/counts, UTC ISO
  timestamps, field shapes, uniqueness, and relationships before any replacement.
  Timestamps are stored as ISO text; dates are not ordered against other fields
  because the synthetic snapshot contains inconsistent chronology.
- Foreign keys are enabled on every application connection. Indexes support
  membership lookup by user (the primary key) and Circle/role, topic/tag lookups,
  visibility/topic candidate queries, and Circle/time engagement aggregation.
  Reverse foreign-key lookups are indexed as well. No score indexes are needed.
- Seed replaces all snapshot rows in one `BEGIN IMMEDIATE` transaction, deleting
  children before parents and inserting parents before children. Any failed write
  rolls back the entire replacement. It targets a dedicated local fixture database,
  not a database containing independently maintained user data.

The schema initializer is idempotent for a new or matching database. It is not a
migration system: future schema changes require explicit versioned migrations.
The server initializes tables but never automatically seeds or replaces records.

The synchronous built-in `node:sqlite` driver keeps setup dependency-light for this
small dataset. Node 22.14 emits an experimental-feature warning for this module.
Production traffic would require reviewing blocking database work, concurrency,
migrations, authentication, backups, and operational monitoring.
