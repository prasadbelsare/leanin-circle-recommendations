import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeSchema, openDatabase } from '../src/db/connection.js';
import { loadDataset, seedDatabase } from '../src/db/seed-data.js';
import { compareCircles, rerankCircles } from '../src/recommendations/diversity.js';
import type { EligibleCircle } from '../src/recommendations/eligibility.js';
import { scoreCircles, SNAPSHOT_REFERENCE_DATE } from '../src/recommendations/scoring.js';
import { getDiversifiedCircles, getScoredCircles } from '../src/recommendations/service.js';
import type { ScoringProfile } from '../src/recommendations/signals.js';

const data = loadDataset();
const taxonomy = data.topics.map(topic => topic.slug);
const empty: ScoringProfile = { topic_interests: [], bio: null, job_title: null, industry: null };

function circle(id: number, overrides: Partial<EligibleCircle> = {}): EligibleCircle {
  return {
    ...data.circles[0]!, id, name: `Fixture ${id}`, slug: `fixture-${id}`,
    topic: 'leadership-skills', tags: [], description: null,
    access: 'public', join_policy: 'open', format: 'virtual',
    last_activity_at: SNAPSHOT_REFERENCE_DATE, feed_posts_30d: 20, chat_messages_30d: 200,
    ...overrides,
  };
}

describe('Circle similarity', () => {
  it('does not label a shared broad topic or boilerplate description as near-identity', () => {
    const description = 'A supportive circle for women focused on leadership skills.';
    const comparison = compareCircles(circle(1, { description }), circle(2, { description }));
    expect(comparison.samePrimaryTopic).toBe(true);
    expect(comparison.similarity).toBe(0.5);
    expect(comparison.descriptionOverlap).toBe(0);
    expect(comparison.nearDuplicate).toBe(false);
  });

  it('detects reliable description overlap and distinguishes different communities despite shared topics/tags', () => {
    const a = circle(1, { tags: ['confidence', 'communication'], description: 'Weekly practice workshops rehearsing board presentations using peer feedback.' });
    const b = circle(2, { tags: ['confidence', 'communication'], description: 'Weekly practice workshops rehearsing board presentations using peer feedback.' });
    const distinct = circle(3, { tags: ['confidence', 'communication'], description: 'Monthly hiking adventures exploring mountain trails building outdoor friendships.' });
    expect(compareCircles(a, b).nearDuplicate).toBe(true);
    expect(compareCircles(a, b).descriptionOverlap).toBe(1);
    expect(compareCircles(a, distinct).nearDuplicate).toBe(false);
    expect(compareCircles(a, distinct).similarity).toBeLessThan(compareCircles(a, b).similarity);
  });

  it('normalizes and deduplicates tags without counting primary topics twice', () => {
    const a = circle(1, { tags: ['confidence', 'public-speaking'] });
    const b = circle(2, { tags: [' CONFIDENCE ', 'public speaking', 'public-speaking', 'leadership-skills'] });
    const comparison = compareCircles(a, b);
    expect(comparison.tagOverlap).toBe(1);
    expect(comparison.nearDuplicate).toBe(true);
    expect(compareCircles(b, a)).toEqual(comparison);
  });

  it('does not consider missing metadata evidence of duplication', () => {
    const comparison = compareCircles(circle(1, { topic: null }), circle(2, { topic: null }));
    expect(comparison).toMatchObject({ similarity: 0, tagOverlap: 0, descriptionOverlap: 0, nearDuplicate: false });
  });

  it('uses focused names to corroborate repeated generic descriptions without labeling a broad topic alone as identity', () => {
    const description = 'A supportive circle for women focused on negotiation.';
    const a = circle(1, { topic: 'negotiation', name: 'Negotiation Circle', description });
    const b = circle(2, { topic: 'negotiation', name: 'Negotiate Like a Leader', description });
    expect(compareCircles(a, b)).toMatchObject({ nearDuplicate: true, descriptionOverlap: 0 });
    expect(compareCircles(a, b).nameFocusOverlap).toBeGreaterThan(0);
    expect(compareCircles(a, { ...b, name: 'The Elevation Collective' }).nearDuplicate).toBe(false);
    expect(compareCircles(a, { ...b, description: null }).nearDuplicate).toBe(false);
    expect(compareCircles(b, a)).toEqual(compareCircles(a, b));
  });
});

describe('greedy selection with isolated candidates', () => {
  it('prefers describable near-equal fallbacks for known interests without inventing topic relevance', () => {
    const scored = scoreCircles([
      circle(1, { topic: null, tags: [], description: null }),
      circle(2, { chat_messages_30d: 150 }),
      circle(3, { topic: null, tags: [], description: 'Monthly workshops rehearsing presentations using structured peer feedback.', chat_messages_30d: 150 }),
    ], { ...empty, topic_interests: ['negotiation'] }, taxonomy);
    const baseline = rerankCircles(scored, 3, { config: { purposeClarityBonus: 0 } });
    expect(baseline[0]!.circle.id).toBe(1);
    const result = rerankCircles(scored, 3);
    expect(result.map(row => row.circle.id)).toEqual([2, 3, 1]);
    for (const row of result) {
      expect(row.relevanceScore).toBe(0);
      expect(row.matchingEvidence.matches).toEqual([]);
      expect(row.selection.coverageBonus).toBe(0);
      expect(row.selection.purposeClarityBonus).toBe(row.selection.hasPurposeMetadata ? 1 : 0);
    }
    expect(result.map(({ selection: _selection, ...row }) => row).sort((a, b) => a.circle.id - b.circle.id))
      .toEqual([...scored].sort((a, b) => a.circle.id - b.circle.id));
  });

  it('does not grant clarity bonuses for boilerplate or promote low-activity candidates over healthy fallbacks', () => {
    const scored = scoreCircles([
      circle(1, { topic: null, tags: [], description: null }),
      circle(2, { topic: null, tags: [], description: 'A supportive circle for women.' }),
      circle(3, { feed_posts_30d: 0, chat_messages_30d: 0, last_activity_at: '2026-08-22T00:00:00.000Z' }),
      circle(4, { feed_posts_30d: 0, chat_messages_30d: 0, last_activity_at: '2026-01-01T00:00:00.000Z' }),
    ], { ...empty, topic_interests: ['negotiation'] }, taxonomy);
    const result = rerankCircles(scored, 4);
    expect(result.map(row => row.circle.id)).toEqual([1, 2, 3, 4]);
    expect(result.every(row => row.selection.purposeClarityBonus === 0)).toBe(true);
    expect(result[3]!.inactivityPenalty).toBe(80);
  });

  it('leaves cold-start selection scores and ordering unchanged when clarity preference is enabled', () => {
    const scored = scoreCircles([
      circle(1, { topic: null, tags: [], description: null }), circle(2), circle(3, { format: 'in_person' }),
    ], empty, taxonomy);
    const enabled = rerankCircles(scored, 3);
    const disabled = rerankCircles(scored, 3, { config: { purposeClarityBonus: 0 } });
    expect(enabled.map(row => [row.circle.id, row.selection.selectionScore]))
      .toEqual(disabled.map(row => [row.circle.id, row.selection.selectionScore]));
    expect(enabled.every(row => row.selection.purposeClarityBonus === 0)).toBe(true);
  });

  it('damps accumulation from broad-topic peers while retaining cumulative repetition pressure', () => {
    const scored = scoreCircles([circle(1), circle(2), circle(3), circle(4)], {
      ...empty, topic_interests: ['leadership-skills'],
    }, taxonomy);
    const result = rerankCircles(scored, 4);
    expect(result.map(row => row.selection.similarityPenalty)).toEqual([0, 16, 24, 32]);
    expect(result.every(row => row.selection.comparisons.every(comparison => !comparison.nearDuplicate))).toBe(true);
    const cumulative = rerankCircles(scored, 4, { config: { repeatSimilarityFactor: 1 } });
    expect(cumulative[2]!.selection.similarityPenalty).toBe(32);
  });

  it('does not treat secondary-topic tags as evidence of an unsupported context-dependent primary purpose', () => {
    const profile = { ...empty, topic_interests: ['getting-promoted'] };
    for (const primary of ['working-motherhood', 'career-breaks', 'being-the-only-one']) {
      const scored = scoreCircles([circle(1, { topic: primary, tags: ['getting-promoted'] }), circle(2, { topic: 'getting-promoted' })], profile, taxonomy);
      const result = rerankCircles(scored, 2);
      const contextual = result.find(row => row.circle.id === 1)!;
      expect(result[0]!.circle.id).toBe(2);
      expect(contextual.selection.unsupportedContextPurpose).toBe(true);
      expect(contextual.selection.purposeMismatchPenalty).toBe(contextual.relevanceScore);
      expect(contextual.selection.coverageBonus).toBe(0);
      expect(contextual.totalScore).toBe(scored.find(row => row.circle.id === 1)!.totalScore);
    }
    const generic = rerankCircles(scoreCircles([circle(1, { topic: 'sponsorship-mentorship', tags: ['getting-promoted'] })], profile, taxonomy), 1)[0]!;
    expect(generic.selection.purposeMismatchPenalty).toBe(0);
  });

  it('accepts explicit or strong bio evidence for context-dependent primary purposes without assuming their absence', () => {
    for (const profile of [
      { ...empty, topic_interests: ['working-motherhood'] },
      { ...empty, bio: 'I want to discuss working motherhood.' },
    ]) {
      const result = rerankCircles(scoreCircles([circle(1, { topic: 'working-motherhood' })], profile, taxonomy), 1)[0]!;
      expect(result.selection.unsupportedContextPurpose).toBe(false);
      expect(result.selection.purposeMismatchPenalty).toBe(0);
      expect(result.selection.coverageBonus).toBeGreaterThan(0);
    }
  });

  it('caps diversity against the remaining score instead of double-discounting unsupported relevance', () => {
    const scored = scoreCircles(Array.from({ length: 4 }, (_, index) => circle(index + 1, {
      topic: 'working-motherhood', tags: ['getting-promoted'],
    })), { ...empty, topic_interests: ['getting-promoted'] }, taxonomy);
    for (const result of rerankCircles(scored, 4)) {
      const remaining = result.totalScore - result.selection.purposeMismatchPenalty;
      expect(result.selection.selectionScore).toBeGreaterThanOrEqual(0.4 * remaining - 0.0001);
    }
  });

  it('requires purpose metadata for cold-start access bonuses, while retaining opaque candidates', () => {
    const scored = scoreCircles([
      circle(1, { topic: null, tags: [], description: null }),
      circle(2),
      circle(3, { topic: null, tags: [], description: 'Monthly workshops rehearsing presentations using structured peer feedback.' }),
    ], empty, taxonomy);
    const selected = rerankCircles(scored, 3);
    expect(selected[0]!.circle.id).toBe(2);
    expect(selected[2]!.circle.id).toBe(1);
    expect(selected[2]!.selection.hasPurposeMetadata).toBe(false);
    expect(selected[2]!.selection.accessibilityBonus).toBe(0);
    expect(selected.find(row => row.circle.id === 3)!.selection.hasPurposeMetadata).toBe(true);
    expect(selected.find(row => row.circle.id === 3)!.selection.accessibilityBonus).toBe(5);
  });

  it('suppresses near-identical candidates more strongly than distinct topic peers', () => {
    const repeated = 'Weekly practice workshops rehearsing board presentations using peer feedback.';
    const scored = scoreCircles([
      circle(1, { description: repeated }), circle(2, { description: repeated }),
      circle(3, { description: 'Outdoor hiking adventures exploring mountain trails building lasting friendships.' }),
    ], { ...empty, topic_interests: ['leadership-skills'] }, taxonomy);
    const result = rerankCircles(scored, 3);
    expect(result.map(row => row.circle.id)).toEqual([1, 3, 2]);
    expect(result[2]!.selection.comparisons.some(comparison => comparison.nearDuplicate)).toBe(true);
  });

  it('covers a strong bio-derived interest despite many matches to one explicit interest', () => {
    const circles = Array.from({ length: 6 }, (_, index) => circle(index + 1));
    circles.push(circle(7, { topic: 'career-breaks' }));
    const scored = scoreCircles(circles, {
      ...empty, topic_interests: ['leadership-skills'], bio: 'Returning to work after a career break.',
    }, taxonomy);
    expect(scored.slice(0, 5).some(row => row.circle.id === 7)).toBe(false);
    const selected = rerankCircles(scored, 5);
    expect(selected[0]!.matchingEvidence.components.explicit).toBe(60);
    const bio = selected.find(row => row.circle.id === 7)!;
    expect(bio).toBeDefined();
    expect(bio.selection.coverageBonus).toBe(9);
    expect(bio.selection.newInterestCoverage).toContainEqual({ topic: 'career-breaks', source: 'bio', strengthGain: 0.9 });
  });

  it('allows bio-only coverage without reserving fixed slots for signal types', () => {
    const scored = scoreCircles([circle(1, { topic: 'career-breaks' }), circle(2)], {
      ...empty, bio: 'Returning to work after a career break.',
    }, taxonomy);
    expect(rerankCircles(scored, 1)[0]!.circle.id).toBe(1);
    expect(rerankCircles(scored, 1)[0]!.selection.coverageBonus).toBe(9);
    const explicitOnly = scoreCircles([circle(1), circle(2), circle(3)], { ...empty, topic_interests: ['leadership-skills'] }, taxonomy);
    expect(rerankCircles(explicitOnly, 3)).toHaveLength(3);
  });

  it('gives explicit coverage greater weight than equivalent bio or professional evidence', () => {
    const results = [
      { ...empty, topic_interests: ['leadership-skills'] },
      { ...empty, bio: 'Building my leadership toolkit.' },
      { ...empty, job_title: 'Founder' },
    ].map(profile => rerankCircles(scoreCircles([circle(1)], profile, taxonomy), 1)[0]!);
    expect(results.map(row => row.selection.coverageBonus)).toEqual([12, 9, 1.2]);
  });

  it('provides only remaining coverage credit for stronger representations of a covered interest', () => {
    const scored = scoreCircles([circle(1, { topic: null, tags: ['leadership-skills'] }), circle(2)], {
      ...empty, topic_interests: ['leadership-skills'],
    }, taxonomy);
    // Force a tag match first to test partial coverage.
    scored.find(row => row.circle.id === 1)!.totalScore = 90;
    const selected = rerankCircles(scored, 2);
    expect(selected.map(row => row.circle.id)).toEqual([1, 2]);
    expect(selected[1]!.selection.newInterestCoverage).toEqual([{ topic: 'leadership-skills', source: 'explicit', strengthGain: 0.35 }]);
    expect(selected[1]!.selection.coverageBonus).toBe(4.2);
  });

  it('keeps low-activity, unrelated, and dormant candidates from displacing strong healthy matches through bonuses', () => {
    const healthy = Array.from({ length: 6 }, (_, index) => circle(index + 1));
    const scored = scoreCircles([
      ...healthy,
      circle(7, { topic: 'career-breaks', feed_posts_30d: 0, chat_messages_30d: 0, last_activity_at: '2026-08-21T00:00:00.000Z' }),
      circle(8, { topic: 'career-breaks', feed_posts_30d: 0, chat_messages_30d: 0, last_activity_at: '2026-01-01T00:00:00.000Z' }),
      circle(9, { topic: 'negotiation' }),
    ], { ...empty, topic_interests: ['leadership-skills'], bio: 'Returning to work after a career break.' }, taxonomy);
    const selected = rerankCircles(scored, 9);
    expect(selected.slice(0, 6).every(row => row.circle.id <= 6)).toBe(true);
    expect(selected.find(row => row.circle.id === 7)!.selection.coverageBonus).toBe(0);
    const dormant = selected.find(row => row.circle.id === 8)!;
    expect(dormant.inactivityPenalty).toBe(80);
    expect(dormant.selection.coverageBonus).toBe(0);
    expect(dormant.selection.accessibilityBonus).toBe(0);
  });

  it('uses bounded cold-start accessibility signals without inventing interests', () => {
    const scored = scoreCircles([
      circle(1, { format: 'in_person', join_policy: 'request' }),
      circle(2, { format: 'virtual' }), circle(3, { format: 'hybrid' }),
    ], empty, taxonomy);
    const selected = rerankCircles(scored, 3);
    expect(selected[0]!.circle.id).toBe(2);
    expect(selected.find(row => row.circle.id === 2)!.selection.accessibilityBonus).toBe(6);
    expect(selected.find(row => row.circle.id === 3)!.selection.accessibilityBonus).toBe(4);
    for (const row of selected) {
      expect(row.selection.coldStart).toBe(true);
      expect(row.selection.coverageBonus).toBe(0);
      expect(row.matchingEvidence.signals).toEqual([]);
    }
  });

  it('breaks ties by ID, preserves inputs and scores, and returns no invented or duplicate candidates', () => {
    const scored = scoreCircles([circle(3), circle(1), circle(2)], empty, taxonomy);
    const snapshot = structuredClone(scored);
    const results = rerankCircles([...scored].reverse(), 100);
    expect(results.map(row => row.circle.id)).toEqual([1, 2, 3]);
    expect(results).toEqual(rerankCircles(scored, 100));
    for (const { selection: _selection, ...original } of results) {
      expect(original).toEqual(scored.find(row => row.circle.id === original.circle.id));
    }
    expect(scored).toEqual(snapshot);
    expect(rerankCircles(scored, 0)).toEqual([]);
    expect(rerankCircles([], 5)).toEqual([]);
  });

  it('supports configurable parameters and rejects malformed limits or configurations', () => {
    const scored = scoreCircles([circle(1), circle(2)], empty, taxonomy);
    const result = rerankCircles(scored, 2, { config: {
      similarityWeight: 0, nearDuplicatePenalty: 0, maxCoverageBonus: 0,
      virtualBonus: 0, hybridBonus: 0, openJoinBonus: 0, knownTopicBonus: 0,
    } });
    expect(result.map(row => row.selection.selectionScore)).toEqual(scored.map(row => row.totalScore));
    for (const limit of [-1, 1.5, NaN, Infinity]) expect(() => rerankCircles(scored, limit)).toThrow(RangeError);
    expect(() => rerankCircles(scored, 5, { config: { similarityWeight: -1 } })).toThrow(RangeError);
    expect(() => rerankCircles(scored, 5, { config: { maxPenaltyFraction: 1.1 } })).toThrow(RangeError);
    expect(() => rerankCircles(scored, 5, { config: { bioCoverageBonus: 20 } })).toThrow(RangeError);
    expect(() => rerankCircles([scored[0]!, scored[0]!])).toThrow(RangeError);
  });
});

describe('seeded diversity selection', () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = openDatabase(':memory:'); initializeSchema(db); seedDatabase(db, data);
  });
  afterEach(() => db.close());

  it('represents both of user #7’s explicit primary interests', () => {
    const results = getDiversifiedCircles(db, 7);
    expect(results.map(row => row.circle.id)).toContain(5);
    expect(results.map(row => row.circle.topic)).toEqual(expect.arrayContaining(['leadership-skills', 'public-speaking']));
    expect(results.find(row => row.circle.topic === 'public-speaking')!.selection.coverageBonus).toBeGreaterThan(0);
  });

  it('returns fewer than three seeded negotiation peers for user #15 in the default five', () => {
    expect(getScoredCircles(db, 15).slice(0, 5).filter(row => [10, 11, 12].includes(row.circle.id))).toHaveLength(3);
    const results = getDiversifiedCircles(db, 15);
    expect(results.filter(row => [10, 11, 12].includes(row.circle.id)).length).toBeLessThan(3);
    expect(results.some(row => row.circle.topic === 'negotiation')).toBe(true);
    expect(results.some(row => row.circle.topic === 'confidence')).toBe(true);
  });

  it('keeps #22 first for user #23, with full, unlisted, and joined Circles absent', () => {
    const results = getDiversifiedCircles(db, 23, 100);
    expect(results[0]!.circle.id).toBe(22);
    expect(results.some(row => [20, 21, 23].includes(row.circle.id))).toBe(false);
    expect(results.findIndex(row => row.circle.id === 19)).toBeGreaterThanOrEqual(5);
    expect(results.find(row => row.circle.id === 19)!.selection.unsupportedContextPurpose).toBe(true);
  });

  it('keeps opaque #27 as an eligible fallback but favors clearly described choices for user #23', () => {
    const results = getDiversifiedCircles(db, 23, 100);
    const opaque = results.find(row => row.circle.id === 27)!;
    expect(results.slice(0, 5).some(row => row.circle.id === 27)).toBe(false);
    expect(opaque.selection.purposeClarityBonus).toBe(0);
    expect(opaque.selection.selectionScore).toBe(12.9555);
    expect(results.find(row => row.circle.id === 15)!.selection.purposeClarityBonus).toBe(1);
    expect(results.find(row => row.circle.id === 15)!.relevanceScore).toBe(0);
  });

  it.each([
    { userId: 1, before: [24, 25, 5, 39, 11], after: [24, 25, 5, 39, 11] },
    { userId: 7, before: [35, 6, 34, 1, 5], after: [35, 6, 34, 1, 5] },
    { userId: 15, before: [12, 13, 11, 37, 38], after: [12, 13, 11, 37, 38] },
    { userId: 23, before: [22, 16, 27, 15, 1], after: [22, 16, 15, 1, 12] },
    { userId: 42, before: [39, 11, 24, 8, 22], after: [39, 11, 24, 8, 22] },
  ])('preserves core scenarios while refining opaque fallbacks for user $userId', ({ userId, before, after }) => {
    const scoredBefore = getScoredCircles(db, userId);
    expect(getDiversifiedCircles(db, userId, 5, { diversity: { config: { purposeClarityBonus: 0 } } }).map(row => row.circle.id)).toEqual(before);
    expect(getDiversifiedCircles(db, userId).map(row => row.circle.id)).toEqual(after);
    expect(getScoredCircles(db, userId)).toEqual(scoredBefore);
  });

  it('gives user #42 diverse broad-access results without invented interests or location', () => {
    const results = getDiversifiedCircles(db, 42);
    expect(results.some(row => row.circle.id === 27)).toBe(false);
    expect(new Set(results.map(row => row.circle.topic)).size).toBeGreaterThanOrEqual(4);
    expect(results.some(row => row.circle.format === 'virtual')).toBe(true);
    expect(results.every(row => row.circle.format !== 'in_person')).toBe(true);
    for (const row of results) {
      expect(row.relevanceScore).toBe(0);
      expect(row.selection.newInterestCoverage).toEqual([]);
      expect(row.selection.coverageBonus).toBe(0);
    }
    const before = results.map(row => row.circle.id);
    db.prepare('UPDATE users SET location = ? WHERE id = 42').run('Seattle, WA');
    expect(getDiversifiedCircles(db, 42).map(row => row.circle.id)).toEqual(before);
  });

  it('supports a seeded bio-only user and keeps #32 available with its original penalty', () => {
    expect(getDiversifiedCircles(db, 4)[0]!.matchingEvidence.matches)
      .toEqual(expect.arrayContaining([expect.objectContaining({ topic: 'career-breaks', source: 'bio' })]));
    const inactive = getDiversifiedCircles(db, 42, 100).find(row => row.circle.id === 32)!;
    expect(inactive.inactivityPenalty).toBe(80);
    expect(inactive.totalScore).toBe(getScoredCircles(db, 42).find(row => row.circle.id === 32)!.totalScore);
  });

  it.each([1, 7, 15, 23, 42])('produces deterministic eligible prefixes for user %i at limits 1, 3, 5, and 10', userId => {
    const input = getScoredCircles(db, userId);
    const full = rerankCircles(input, 100);
    expect(full.map(row => row.circle.id).sort((a, b) => a - b))
      .toEqual(input.map(row => row.circle.id).sort((a, b) => a - b));
    for (const limit of [1, 3, 5, 10]) {
      const selected = getDiversifiedCircles(db, userId, limit);
      expect(selected).toEqual(full.slice(0, limit));
      expect(selected).toEqual(rerankCircles([...input].reverse(), limit));
      expect(new Set(selected.map(row => row.circle.id)).size).toBe(selected.length);
    }
  });

  it.each([0, 25, 50, 75])('preserves supported interest coverage and cold-start behavior for 25 users starting at index %i', start => {
    const supportedTopics = (rows: ReturnType<typeof rerankCircles>) => new Set(rows
      .filter(row => !row.selection.unsupportedContextPurpose)
      .flatMap(row => row.matchingEvidence.matches
        .filter(match => match.source === 'explicit' || (match.source === 'bio' && match.confidence >= row.selection.config.strongBioConfidence))
        .map(match => match.topic)));
    for (const user of data.users.slice(start, start + 25)) {
      const scored = getScoredCircles(db, user.id);
      const before = rerankCircles(scored, 5, { config: { purposeClarityBonus: 0 } });
      const after = rerankCircles(scored, 5);
      const coveredAfter = supportedTopics(after);
      for (const topic of supportedTopics(before)) expect(coveredAfter.has(topic)).toBe(true);
      if (before.every(row => row.selection.coldStart)) {
        expect(after.map(row => [row.circle.id, row.selection.selectionScore]))
          .toEqual(before.map(row => [row.circle.id, row.selection.selectionScore]));
      }
    }
  });
});
