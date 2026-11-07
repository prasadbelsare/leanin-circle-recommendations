# Member-facing explanations

`generateExplanation(selectedCircle, topicLabels?)` is a pure deterministic
function in `src/recommendations/explanations.ts`. `addExplanations` attaches one
sentence per selected Circle without changing order, scores, or evidence.
`getExplainedCircles(db, userId, limit = 5, options?)` composes the existing
selection service and supplies display labels from the topic taxonomy.

Explanation generation transforms structured evidence into template text without
external inference services. The REST route delegates to this service.

## Evidence and wording policy

1. Prefer supported explicit matches, then strong bio matches, then professional
   context, then factual general discovery. An explicit secondary tag remains
   the leading personal reason even if a primary topic has weaker inferred support.
2. A match must still agree with the Circle metadata and a corresponding source
   signal. Ignore source buckets with zero scoring contribution. Bio confidence
   must meet the selection configuration's strong-bio threshold.
3. Primary explicit matches say “Explore your interest in ... with this Circle.”
   Secondary matches first state the actual primary purpose, then connect it to
   the matched interest: “Focused on ..., this Circle also connects with ...”.
   Without a known primary topic, omit that introductory focus rather than
   inventing one. At most two distinct interests from the same source are
   mentioned. Sort by source priority, strength, new coverage gain, and topic
   slug for stable ties. Repeated topics do not repeat in the sentence.
4. Explicit attribution uses “your interest”; inference says “an interest
   suggested by your bio.” Professional relevance remains tentative (“may be
   useful in your professional role”). Industry text references existing matched
   wording, not the Circle's entire primary purpose or assumed member identities.
5. When selection marks the primary context unsupported, suppress personal claims
   from secondary tags. Use general discovery instead. This does not assert that
   the member lacks the relevant personal circumstances.
6. Cold-start and unmatched discovery describes the actual format and known
   primary topic. Do not promote a tag, name, or description to a primary topic.
   An opaque Circle receives only a format/activity explanation; no purpose,
   demographic, geographic, or personal-interest inference is made.
7. Say “recent group activity” only if the Circle has positive post/chat counts,
   last activity is within the 30-day window ending at the scoring reference
   time, the timestamp is not in the future, and no dormancy flag/deduction exists.
   Do not read the wall clock. This refers to the same dataset snapshot as scoring.
8. Dormant Circles get “though recent activity is limited,” including when a
   personal interest is otherwise a strong match. Request-to-join Circles always
   append “membership requires approval” in the same sentence. No template
   promises immediate access, meeting attendance, or available local events.

Labels come from `topics.label`, lowercasing their initial letter within a
sentence and rendering `&` as “and.” The optional labels fallback humanizes the
stored topic slug. Raw bios, job titles, company names, and user names are not
quoted or sent anywhere.

## Examples

- Primary explicit: “Explore your interest in leadership skills with this Circle.”
- Secondary explicit: “Focused on stress and burnout, this Circle also connects
  with your interest in work-life integration.”
- Bio: “Its focus on career breaks reflects an interest suggested by your bio.”
- Cold start: “Explore a hybrid Circle focused on negotiation, with recent
  group activity.”
- Opaque request-to-join: “Explore a virtual Circle with recent group activity;
  membership requires approval.”

The wording is intentionally consistent across Circles that share the same
supported reason. Explanations communicate a supported reason for inclusion,
not a complete account of the greedy selection process or a promise of fit.
Source priority can omit a weaker bio reason even when that reason contributed
to the score; the structured evidence remains available for inspection.

## Tests

Tests cover the requested users (1, 7, 4, 15, 23, 42), primary versus tag wording,
two-interest attribution, bio and professional sources, unsupported primary
context, absent metadata/bio, zero-weight sources, stale evidence, inactive and
future timestamps, approval requirements, determinism, and nonmutation.
All-user cases assert selection-order preservation, one-sentence output, concise
wording, and source/activity/join-policy consistency.
