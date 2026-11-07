# Technical Design: Collaborative Filtering Experiment

**Objective and boundary.** Evaluate whether membership co-occurrence improves
Circle retrieval over the primary content-based API. Python provides separate
training, saved-model inference, and aggregate evaluation CLIs. A TypeScript
subprocess bridge validates/export records and creates in-memory SQLite contexts
using the existing eligibility, scoring, diversity, and explanation functions.
The REST API remains independent of Python. The experiment shares the original
five datasets; it introduces no application tables or duplicate policy engine.

**Model and features.** Build a binary user?Circle matrix from unique training
memberships, counting leaders and members equally. Unobserved pairs are unknown,
not negative feedback. Sorted ID mappings prevent assumptions about consecutive
identifiers. Item similarity is cosine between Circle columns multiplied by
`overlap / (overlap + shrinkage)`; self-similarity is zero. A user's candidate
score is mean similarity across their training memberships. The documented model
uses shrinkage 3. Affinity is bounded in `[0, 1]`, not calibrated join probability.
Location has no Circle counterpart; names, company, photo, and profile completeness
are excluded. Aggregate engagement cannot identify individual interactions.
Explicit/bio/professional signals remain in the content baseline.

**Artifacts and inference.** JSON artifacts store similarities, support counts,
ID maps, histories, popularity, configuration, runtime versions, and exact
snapshot/split hashes. Atomic writes and load-time validation enforce dimensions,
finite values, formula consistency, and training provenance. Evaluation artifacts
use masked histories; full-data artifacts support demos and cannot enter held-out
evaluation. Inference receives eligible candidates from TypeScript, ranks by CF
score then Circle ID, and retains baseline ordering when history/support is absent.
Unseen Circles remain candidates with zero support. Explicit snapshot input permits
baseline fallback for unavailable or mismatched models; invalid batch artifacts
fail. Content rationales remain distinct from collaborative ordering and never
fabricate preference or demographic evidence.

**Evaluation.** Seeded, non-temporal membership reconstruction holds out one
ordinary-member pair per user for validation and one for test, retaining training
history. Both sets and their associated author/Circle posts are removed globally
before fitting and candidate retrieval. Leadership is not a target. Snapshot
capacity, access, metadata, and activity aggregates remain fixed; excluded targets
are reported rather than treated as ranking misses. The shared candidate pools
support comparison with content ranking and training-only popularity. Metrics
include Recall/NDCG@5/10, catalog and interest coverage, duplicate/dormant exposure,
fallback, and eligibility violations. Parameter selection belongs on validation;
the reported fixed configuration does not imply an exhaustive search.

**Results and limitations.** Of 81 held-out users, 74 validation and 72 test users
have eligible targets. Test Recall@5 is **0.2639 for content ranking versus 0.1806
for collaborative filtering**; NDCG@5 is 0.1622 versus 0.1004. Lower interest
coverage and higher dormant exposure provide further reasons to retain the
content-based API. Sparse, topic-biased synthetic memberships and inconsistent
historical timestamps limit inference to reconstruction, not future-join accuracy.
The four planted scenarios remain separate product regression cases.

**Production path.** Collect timestamped impressions, join requests, accepted
joins, and sustained participation with appropriate access controls. Use temporal
splits, exposure-aware evaluation, and cohort monitoring before model selection.
At larger scale, maintain sparse interaction aggregates, retrieve a bounded
candidate pool, version artifacts/features, and serve validated models without
per-request Python process creation. Deployment requires measured gains over the
content baseline while retaining availability, diversity, and explanation policy.
