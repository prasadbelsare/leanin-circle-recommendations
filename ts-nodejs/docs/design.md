# Technical Design: Circle Recommendation API

**Objective and architecture.** Return ranked, available Circles with concise,
member-facing explanations, including users with sparse profiles. Express exposes
`GET /users/:userId/recommendations?limit=5` and `/health`. Zod validates requests
and imported records. A service composes SQLite retrieval, eligibility, pure
TypeScript scoring, greedy selection, and template explanations. The endpoint
accepts limits 1?20, preserves selection order, and returns fewer rows when
necessary. Invalid requests, unknown users, and internal failures produce 400,
404, and sanitized 500 responses; empty pools return 200.

**Persistence.** Seven STRICT tables store `users`, `topics`, `circles`,
`memberships`, `activity`, `user_topic_interests`, and `circle_tags`. Unique slugs,
composite membership/association keys, foreign keys, and CHECK constraints enforce
identity, relationships, enums, and numeric bounds. Activity references author
membership through `(author_user_id, circle_id)`. Membership, reverse topic/tag,
access/topic, and Circle/time activity indexes support candidate and engagement
queries. Nullable profile fields and unlimited capacity remain null. Import
validates all five JSON files before an atomic replacement transaction; failures
roll back. Full/over-capacity records are representable and filtered at retrieval.

**Eligibility and scoring.** Exclude memberships of either role, unlisted Circles,
and counts at/above non-null capacity. Public approval-required and inactive
Circles remain eligible. Score caps are **60 explicit-topic, 20 bio-derived,
5 professional-context, and 15 activity points**. Topic strength is 1 for primary
matches and 0.65 for secondary tags. Each topic is credited once by source priority;
additional distinct matches receive capped bonuses. A small phrase dictionary
provides inspectable bio inference. Professional matching is conservative and
uses Circle content, not leader industry or inferred identity. Activity combines
recency decay, bounded feed/chat volume, and capped engagement with sample-size
shrinkage. Dormancy?90+ days, zero feed posts, and at most five chat messages?
subtracts **80 points** without exclusion. The injectable reference defaults to
`2026-09-21T00:00:00.000Z`, consistent with the snapshot. Weights are tunable policy
parameters, not probabilities.

**Selection and explanations.** Greedy reranking penalizes primary-topic/tag and
reliable description similarity, with corroborating focused-name evidence for
near-duplicates. Penalties are capped; shared broad topics alone do not establish
near-identity. Coverage rewards previously unrepresented explicit and strong bio
interests without fixed quotas. Unsupported context-dependent purposes lose
personalized selection credit. Healthy Circles with purpose metadata receive a **one-point purpose-clarity bonus for non-cold-start users**; missing metadata remains eligible.
Cold start favors activity, accessible formats, and known purpose without assuming
location. Explanations use the same matching/selection evidence, distinguish
primary versus secondary topics and explicit versus inferred interests, and
preserve dormancy and approval caveats. Circle-ID ties ensure determinism.

**Tradeoffs and production path.** Deterministic rules suit a small synthetic
snapshot and provide auditable member-facing reasons without outcome labels or
external inference services. The separate collaborative-filtering experiment
underperforms this baseline on the [documented test split](../../ml/docs/evaluation.md). Phrase matching misses negation; sparse metadata limits duplicate detection; greedy selection is not globally optimal. Synchronous SQLite and full-pool evaluation limit concurrency. Production requires authentication, migrations, PostgreSQL, indexed candidate retrieval, asynchronous activity aggregation, and versioned caching with membership/ capacity invalidation. Recheck availability at join time. Evaluate accepted joins, sustained participation, and retention with controlled experiments and cohort audits before adjusting policy weights or adopting learned ranking.
