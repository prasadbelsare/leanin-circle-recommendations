# Relevance and activity scoring

`getScoredCircles(db, userId, options?)` composes eligibility filtering with base
scoring. It returns every eligible candidate, ordered by descending total score
and ascending Circle ID for ties. There are no limits, duplicate suppression,
diversity adjustments, or explanation sentences.

`signals.ts` and `scoring.ts` are pure TypeScript modules. The SQLite adapter in
`db/scoring-data.ts` loads profile fields, explicit interests, taxonomy, and feed
engagement; `service.ts` connects those inputs to eligibility and scoring.

## Relevance formula

Match known topics against the Circle's primary topic (strength 1) or normalized
tags (strength 0.65). Normalization lowercases and replaces punctuation/hyphens
with spaces. Primary topic takes precedence over a tag.

Signals retain independent source evidence and initial confidence values:

- Explicit selected topics: 1.0.
- Bio phrases: 0.9.
- Conservative job-title mappings: 0.6.
- Direct industry match against Circle tags, name, or description: 0.5.

Multiply match strength by source confidence. Credit each topic once using the
strongest source: explicit, then bio, then job title. All inferred signals,
including unmatched signals, remain available for coverage selection.
Industry and job evidence share the professional bucket's five-point cap.

For each bucket, sort strengths descending: `s1, s2, ...`.

`alignment = min(1, s1 + 0.25 * sum(s2, ...))`

`relevanceScore = 60 * explicitAlignment + 20 * bioAlignment + 5 * professionalAlignment`

A single explicit primary match scores 60, an explicit tag match 39, and a bio
primary match 18. Repeated tags, aliases, selected topics, or sources cannot
multiply a topic's credit. Distinct matches receive a capped bonus; once a bucket
is saturated, further matches cannot raise it.

## Inference dictionary and limits

Bio matching uses complete normalized phrases with word boundaries. Every exact
taxonomy spelling (slug with hyphens replaced by spaces) is recognized, plus
these aliases, maintained in `BIO_ALIASES`:

| Topic | Additional phrases |
| --- | --- |
| Career breaks | career break; returning to work; return after leave |
| Leadership skills | leadership toolkit; first leadership role; women leaders |
| Managing a team | first time manager; leading a team |
| Negotiation | comp conversation; pay equity; salary negotiation |
| Getting promoted | promotion; promotion paths; ready for the next level |
| Public speaking | presenting; speaking in public |
| Visibility/recognition | executive presence |
| Sponsorship/mentorship | mentoring; mentorship; sponsorship |
| Imposter syndrome | imposter feelings; impostor syndrome |
| Stress/burnout | burnout |

Exact normalized job mappings: Engineering Manager → managing a team/giving
feedback; Sales Manager and Finance Manager → managing a team; Nonprofit Director,
Strategy Lead, and Founder → leadership. Product Manager and Community Manager do
not automatically imply people management.

Industry contributes only when the Circle itself mentions it. Aliases: Technology
→ technology/tech/software; Healthcare → healthcare/health care; Finance → finance/
financial; Education → education/educators; Nonprofit → nonprofit/non profit.
Other nonempty industries use their literal normalized wording. There is no
leader-industry comparison, company matching, identity inference, or ID-specific logic.

This is a transparent phrase heuristic, not semantic understanding. It does not
resolve negation, sarcasm, or nuanced goals. Confidence values are policy choices,
not learned probabilities. Evidence records matched phrases so explanations
can distinguish inference from selected interests.

## Activity formula and snapshot time

Default reference: **2026-09-21T00:00:00.000Z**, matching the generator's snapshot
date. Callers may inject `referenceDate` as a Date or ISO string; scoring never
reads the wall clock. A deployment must refresh aggregates: `feed_posts_30d` and
`chat_messages_30d` describe the supplied snapshot, not a rolling window recomputed
when the reference date changes.

- `age` = days since Circle last activity, clamped to zero for future timestamps.
  Circle aggregates remain authoritative for recency/dormancy; known feed versus
  aggregate timestamp inconsistencies are not repaired.
- `R = 2^(-age / 30)` (30-day recency half-life).
- `F = min(1, ln(1 + feed_posts_30d) / ln(21))`.
- `C = min(1, ln(1 + chat_messages_30d) / ln(201))`.
- Select posts for this Circle within the inclusive interval
  `[reference - 30 days, reference]`. Ignore older and future posts.
- Each selected post contributes
  `e = min(1, (reactions + 2 * comments + 3 * saves) / 100)`.
- `E = sum(e) / (selectedPostCount + 3)`, shrinking sparse samples toward zero.
  No selected posts means zero engagement; `E` remains below 1.

`activityScore = activityWeight * (5R + 4F + 4C + 2E) / 15`

Default activity weight is 15, so activity contributes at most 15 points. Posts
are not added to the aggregate count. Engagement and popularity are bounded.

Clearly dormant means `age >= 90`, `feed_posts_30d == 0`, and
`chat_messages_30d <= 5`. Apply an 80-point deduction, keeping the Circle in the
results. Chat-active Circles without feed posts are not automatically dormant.

`totalScore = relevanceScore + activityScore - inactivityPenalty`

Scores are rounded to four decimals; negative totals are valid and are not
probabilities. Exported defaults support per-call overrides for weights,
strength/bonus settings, half-life, saturation, engagement caps, dormancy
thresholds, and penalty. Evidence includes the applied configuration and date.

## Validation

Tests cover source precedence, caps, repeated tags, professional signals, missing
fields, cold start, eligibility preservation, time windows, threshold boundaries,
tie-breaking, reproducibility, and seeded users 7, 4, 42, and 23. The healthy versus
dormant comparison makes #21 public only inside an isolated database. Public
inactive #32 separately verifies its substantial penalty.

Selection consumes the preserved evidence for greedy interest coverage and
diversity penalties; see [diversity.md](diversity.md). Base scores remain separate
from selection-time adjustments.
