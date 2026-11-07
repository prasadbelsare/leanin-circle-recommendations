CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY CHECK (id > 0),
  slug TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  domain TEXT NOT NULL CHECK (domain = 'content')
) STRICT;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY CHECK (id > 0),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  has_photo INTEGER NOT NULL CHECK (has_photo IN (0, 1)),
  bio TEXT,
  job_title TEXT,
  company TEXT,
  industry TEXT,
  location TEXT,
  joined_at TEXT NOT NULL,
  profile_completeness REAL NOT NULL CHECK (profile_completeness BETWEEN 0 AND 1)
) STRICT;

CREATE TABLE IF NOT EXISTS user_topic_interests (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic_slug TEXT NOT NULL REFERENCES topics(slug),
  PRIMARY KEY (user_id, topic_slug)
) STRICT;

CREATE TABLE IF NOT EXISTS circles (
  id INTEGER PRIMARY KEY CHECK (id > 0),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  topic TEXT REFERENCES topics(slug),
  cover_image_url TEXT,
  format TEXT NOT NULL CHECK (format IN ('in_person', 'virtual', 'hybrid')),
  access TEXT NOT NULL CHECK (access IN ('public', 'unlisted')),
  join_policy TEXT NOT NULL CHECK (join_policy IN ('open', 'request')),
  max_members INTEGER CHECK (max_members > 0),
  member_count INTEGER NOT NULL CHECK (member_count >= 0),
  created_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  feed_posts_30d INTEGER NOT NULL CHECK (feed_posts_30d >= 0),
  chat_messages_30d INTEGER NOT NULL CHECK (chat_messages_30d >= 0)
) STRICT;

CREATE TABLE IF NOT EXISTS circle_tags (
  circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (circle_id, tag)
) STRICT;

CREATE TABLE IF NOT EXISTS memberships (
  user_id INTEGER NOT NULL REFERENCES users(id),
  circle_id INTEGER NOT NULL REFERENCES circles(id),
  role TEXT NOT NULL CHECK (role IN ('member', 'leader')),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (user_id, circle_id)
) STRICT;

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY CHECK (id > 0),
  circle_id INTEGER NOT NULL REFERENCES circles(id),
  author_user_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  reaction_count INTEGER NOT NULL CHECK (reaction_count >= 0),
  comment_count INTEGER NOT NULL CHECK (comment_count >= 0),
  save_count INTEGER NOT NULL CHECK (save_count >= 0),
  created_at TEXT NOT NULL,
  FOREIGN KEY (author_user_id, circle_id) REFERENCES memberships(user_id, circle_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_interests_topic ON user_topic_interests(topic_slug, user_id);
CREATE INDEX IF NOT EXISTS idx_circles_access_topic ON circles(access, topic);
CREATE INDEX IF NOT EXISTS idx_circles_topic ON circles(topic);
CREATE INDEX IF NOT EXISTS idx_tags_tag ON circle_tags(tag, circle_id);
CREATE INDEX IF NOT EXISTS idx_memberships_circle_role ON memberships(circle_id, role, user_id);
CREATE INDEX IF NOT EXISTS idx_activity_circle_created ON activity(circle_id, created_at);
CREATE INDEX IF NOT EXISTS idx_activity_author_circle ON activity(author_user_id, circle_id);
