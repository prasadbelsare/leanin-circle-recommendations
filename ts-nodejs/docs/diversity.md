# Diversity-aware selection

`rerankCircles(scored, limit = 5, options = {})` is a pure function over
scored eligible candidates. `getDiversifiedCircles(db, userId, limit, options)`
composes it with the existing service. It accepts separate `options.scoring` and
`options.diversity` settings. The module consumes eligible scored candidates and returns selection evidence
without modifying base scores or generating explanation text.

## Greedy selection formula

At every position, evaluate each remaining candidate against the selected set:

Let `M` be maximum similarity to a selected Circle (zero for an empty list), `S`
the sum of those similarities, and `N` the number of near-duplicate comparisons:

`rawPenalty = 32 * (M + 0.5 * (S - M)) + 20 * N`

`similarityPenalty = min(rawPenalty, 0.60 * max(0, originalTotalScore - purposeMismatchPenalty))`

`selectionScore = originalTotalScore - similarityPenalty - purposeMismatchPenalty + coverageBonus + accessibilityBonus + purposeClarityBonus`

Choose the highest selection score, with ascending Circle ID as the only tie
breaker. Update covered interests and repeat. Adjustments are rounded to four
decimals. The score is evaluated at selection time: a later row's selection score
must not be used to sort the finished greedy list again.

The strongest similarity contributes fully; further comparisons contribute half
strength. This avoids repeatedly charging full price for sharing a broad topic,
while retaining pressure against a third or fourth repeat. Near-duplicate
deductions still accumulate fully. The similarity cap retains at least 40% of the
positive score remaining after the purpose guard, avoiding double-discounting
unsupported relevance. Negative base scores
retain their full existing dormancy deduction.

Return at most the requested number of candidates, with no filling, invented
records, or repeated IDs. Zero returns an empty list. Requests exceeding the pool
return all candidates, including dormant candidates near the end. Invalid limits,
nonfinite scores, or duplicate input IDs are rejected. Since rules do not depend
on the limit, results for 1, 3, 5, and 10 are prefixes of the same selection order.

## Similarity rules

`similarity = 0.5 * samePrimaryTopic + 0.2 * tagJaccard + 0.3 * descriptionJaccard`

- Topic comparisons and tags use the same normalization as scoring. Tags are sets;
  repeated tags and each Circle's primary topic repeated as a tag are removed.
- Jaccard is intersection size divided by union size; two empty sets score zero.
- Description tokens discard common stop words, recurring dataset boilerplate,
  and the primary topic's words. Use description overlap only if both descriptions
  retain at least four distinct meaningful words. Missing or generic descriptions
  provide no extra similarity evidence.
- Near-identity requires description overlap of at least 0.85 plus a shared
  primary topic or tag overlap of at least 0.5. Alternatively, when descriptions
  are unreliable, a shared primary topic and at least two secondary tags on each
  side with tag overlap of at least 0.85 provide a metadata fallback.
- Reliable but different descriptions prevent the metadata-only near-identity
  fallback. A broad topic alone never labels two communities near-identical.
- With unreliable descriptions, identical nonempty descriptions can also be
  corroborated by focused names: normalized name-token Jaccard must be at least
  one third, both names must share a primary-topic token, and primary topics must
  agree. A small suffix-removal heuristic handles inflections such as negotiation/
  negotiate. Name tokens exclude common filler. Missing descriptions do not
  support this fallback. Name evidence compares Circles, never user identities.

The seeded negotiation trio has matching generic descriptions and corroborating
topic-focused names. That combination provides stronger redundancy evidence than
a broad topic alone. Distinct communities sharing a leadership topic receive broad-topic similarity penalties unless additional metadata corroborates near-identity. This remains a soft heuristic rather than a claim that two communities are objectively identical; no hard topic quota or cluster exclusion applies.

## Primary-purpose guard

A small taxonomy policy identifies context-dependent primary topics:
`working-motherhood`, `career-breaks`, and `being-the-only-one`. Secondary tags
such as promotion or work/life integration do not establish interest in those
personal circumstances. Require an explicit interest or strong bio signal for
the primary topic itself. Job title and industry cannot establish that context.

Without this evidence, `purposeMismatchPenalty = relevanceScore` by default,
scaled by configurable `unsupportedContextDiscount` (0–1). The original scores
and eligibility remain unchanged; the selection score retains activity and any
existing dormancy deduction. Do not award coverage/access bonuses or count its
secondary tags as covered interests when it is selected through fallback activity.

The guard expresses unknown fit, not a conclusion that the user is not a parent,
has never taken leave, or lacks another identity. Such Circles remain candidates
and may appear in longer lists. Broad professional topics such as mentorship
continue to match via secondary tags without this discount.

## Interest coverage

Use `matchingEvidence.matches`; never infer additional user interests.
Track the strongest selected match strength per topic, regardless of source.

`gain(topic) = max(0, candidateMatchStrength - strongestSelectedStrength)`

Multiply gains by 12 for explicit interests, 10 for strong bio interests, or 2 for
job-title context. Sum and cap the coverage bonus at 12. Bio confidence must be at
least 0.8. Industry matching remains context evidence, not an invented topic.

This rewards a newly represented interest or a stronger representation of a
previously tag-only match. It does not repeatedly reward the same topic under
different sources. Combined with cumulative similarity penalties, strong bio
interests can enter before a third or fourth repeat of one explicit interest.
There are no reserved positions for explicit, bio, or professional signals.

Bonuses require a positive base score, no dormancy deduction/flag, a supported
primary context when applicable, and activity score of at least 5.
Low-activity candidates remain eligible but cannot win through
coverage/accessibility boosts alone. Existing relevance and activity scores still
dominate large differences in quality; bonuses are modest and bounded.

## Cold-start accessibility

Use fallback accessibility only when every candidate has no extracted topic
signals and no industry-match evidence. This includes completely empty profiles
and profiles without usable personal signals; it does not invent a topic preference.

Add 4 for virtual, 2 for hybrid, 1 for open joining, and 1 for a known primary
topic (a clearly described focus). The bonus is at most 6 and has the same quality
guard as coverage. Award it only when the Circle has a primary topic, nonempty
tags, or at least four meaningful description tokens. An opaque Circle with only
a name and activity receives no accessibility bonus. It remains eligible and
retains its original activity score. Request-to-join and in-person Circles remain eligible.
There is no location comparison: the dataset has no Circle location, and neither
a missing nor a present user location establishes proximity. No claims about
gender, ethnicity, parenthood, or other identity are derived from names or profiles.

## Purpose clarity in personalized fallback lists

For non-cold-start users, award a configurable **one-point purpose clarity bonus**
when a Circle has purpose metadata and meets the existing healthy-candidate bonus
guard. Reuse the same metadata definition: a primary topic, nonempty tags, or at
least four meaningful description tokens. Do not award it for boilerplate alone,
dormant/low-activity candidates, or unsupported primary contexts. The bonus is
constant, not multiplied by the number of fields/tags.

This favors more explainable exploration when activity scores are nearly equal.
It is not topic relevance and does not create matching evidence or personalized
explanation claims. Missing metadata remains eligible and retains its full base
score. A substantially healthier opaque Circle can still outrank a described one.
Cold-start accessibility is evaluated separately.
`purposeClarityBonus: 0` disables the purpose-clarity bonus.

## Configuration and evidence

`DEFAULT_DIVERSITY_CONFIG` exports similarity/near-duplicate weights, the repeated
similarity factor, penalty fraction, context discount, coverage weights/cap/
confidence threshold, minimum activity for bonuses, and accessibility weights.
It also exports the personalized-list purpose-clarity bonus.
Use `options.config` for overrides. Values must be
finite and nonnegative; fractions cannot exceed 1, and coverage weights must keep
explicit >= bio >= professional. Similarity feature weights and reliable-text
thresholds are fixed documented heuristics to keep the v1 configuration small.

Each returned object retains every base-scoring field and adds `selection`:
rank, selection score, applied penalties/bonuses, cold-start flag, comparison
features against selected Circles (including name corroboration), newly covered
interests, unsupported-context/purpose-metadata flags, and configuration.
Explanation generation consumes this evidence after selection.

## Tests and limitations

Tests cover reliable versus boilerplate descriptions, distinct communities sharing
topics/tags, deduplication of metadata, explicit/bio/professional coverage, mixed
and bio-only profiles, partial interest coverage, quality guards, cold start,
unchanged base evidence, deterministic input-order-independent ties, limit prefixes,
and all four seeded scenarios. Inactive public #32 stays available with its
original 80-point penalty.

Additional cases cover damped broad-topic penalties,
focused-name corroboration, unsupported context versus positive explicit/bio
evidence, and transparent versus opaque cold-start candidates.

These are transparent metadata heuristics, not semantic duplicate detection.
Sparse metadata can understate similarity, while broad-topic repetition penalties
can demote useful distinct communities. Name stemming and focused-name overlap can
also misclassify communities with similar branding; penalties stay soft and capped.
Greedy selection depends on earlier selections, uses stable ties, and does not
find a global optimum. Full-pool evaluation is appropriate for the small snapshot;
a larger catalog requires candidate retrieval before greedy selection.
