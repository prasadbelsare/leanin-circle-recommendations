# Collaborative Filtering Evaluation

## Configuration and protocol

The comparison uses item-item cosine similarity with overlap shrinkage **3** and
split seed **20260921**. The dataset contains 100 users, 40 Circles, 441 membership
pairs, 22 topics, and 386 posts. The fixed activity reference is
`2026-09-21T00:00:00.000Z`. The evaluation artifact contains **279 training pairs**;
162 pairs are held out globally.

Each qualifying user contributes one validation and one test membership. At least
one training membership remains; leadership roles are not targets. Nineteen users
have insufficient history. Both holdout sets and associated author/Circle posts
are absent from fitting and from the TypeScript evaluation databases. Access,
capacity, member counts, profile fields, and activity aggregates remain snapshot
context. All three methods use identical eligible candidate pools.

| Split | Held-out users | Ineligible targets | Evaluated users |
| --- | ---: | ---: | ---: |
| Validation | 81 | 7 | 74 |
| Test | 81 | 9 | 72 |

The planted users 7, 15, 23, and 42 fall in the insufficient-history cohort.
Their product scenarios are covered by the API tests rather than these metrics.

## Retrieval metrics

| Split | Method | Recall@5 | NDCG@5 | Recall@10 | NDCG@10 |
| --- | --- | ---: | ---: | ---: | ---: |
| Validation | Content-based | 0.2703 | 0.1818 | 0.4189 | 0.2277 |
| Validation | Training popularity | 0.3514 | 0.2151 | 0.5270 | 0.2703 |
| Validation | Collaborative filtering | 0.1622 | 0.1048 | 0.3243 | 0.1570 |
| Test | Content-based | 0.2639 | 0.1622 | 0.4028 | 0.2051 |
| Test | Training popularity | 0.1944 | 0.1429 | 0.3889 | 0.2041 |
| Test | Collaborative filtering | 0.1806 | 0.1004 | 0.3056 | 0.1389 |

Recall is the mean hit rate for one eligible held-out target per user. NDCG
uses the target's rank, with zero when absent from the requested list. Missing
memberships are unlabeled; these values do not estimate dislike or rejection.

## Test-set quality at five recommendations

| Method | Explicit coverage | Bio coverage | Catalog coverage | Dormant exposure |
| --- | ---: | ---: | ---: | ---: |
| Content-based | 1.0000 | 0.9464 | 0.9167 | 0.0000 |
| Training popularity | 0.4371 | 0.6071 | 0.2222 | 0.0000 |
| Collaborative filtering | 0.4057 | 0.5179 | 0.9722 | 0.0278 |

Interest coverage averages the fraction of matchable supported topics represented
in each list, over 53 users with explicit evidence and 28 with bio evidence.
Catalog coverage divides distinct recommendations by the 36-Circle union of
eligible candidates. Dormant exposure divides recommendations carrying the
inactivity penalty by all returned recommendations. All three methods have zero
eligibility violations and repeated IDs in both splits at limits 5 and 10.

## Interpretation

The content-based recommender has stronger test retrieval metrics and preserves
more explicit/bio coverage than raw collaborative filtering. Popularity has the
highest validation retrieval metrics but substantially narrower catalog coverage;
its test metrics do not outperform the content baseline. The variation illustrates
sensitivity to the small synthetic split. Collaborative filtering remains an
experiment outside the serving path; no hybrid-ranking gain is established.

The generator samples topic-biased memberships with additional randomness, and
some membership timestamps predate accounts or Circles. Historical profile states,
past availability, exposure logs, and future membership outcomes are unavailable.
This protocol measures **synthetic membership reconstruction**, not prospective
join prediction or production impact. Broader parameter searches and temporal
outcome evaluation require additional evidence.

## Reproduction and provenance

[README.md](../README.md) defines export, split, training, and evaluation commands.
The configuration is fixed; the reports do not establish optimal shrinkage or a
validation-selected winner. Raw artifacts and reports are generated under
`ml/.local/` and excluded from Git.

| Input | SHA-256 |
| --- | --- |
| Snapshot | `2fe0c0239181f71cf8c75a49ae04a1c9c1953c3797aeb25cc4eea9a26f4159c4` |
| Split manifest | `e9209e94f22ede5ee1708fec8507bf40e449fcf7b48853539b567f4e5ca823a5` |
| Validation report | `0ee94bc80bf30ae53b83caac09d30591cfc8183cf96d37e96117c95279c640af` |
| Test report | `5b8034b1ea96039281ccbb393be4f1ca159f7450df81c2c600a50819722e625d` |

Runtime: Python 3.11.0, NumPy 1.26.4, SciPy 1.13.1, scikit-learn 1.5.2.
