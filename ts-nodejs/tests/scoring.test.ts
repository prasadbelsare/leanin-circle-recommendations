import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeSchema, openDatabase } from '../src/db/connection.js';
import { loadDataset, seedDatabase } from '../src/db/seed-data.js';
import { getEligibleCircles } from '../src/recommendations/eligibility.js';
import { scoreCircle, scoreCircles, SNAPSHOT_REFERENCE_DATE, type EngagementPost } from '../src/recommendations/scoring.js';
import { getScoredCircles } from '../src/recommendations/service.js';
import { extractSignals, type ScoringProfile } from '../src/recommendations/signals.js';

const data = loadDataset();
const taxonomy = data.topics.map(topic => topic.slug);
const empty: ScoringProfile = { topic_interests: [], bio: null, job_title: null, industry: null };
const base = data.circles.find(circle => circle.id === 22)!;

describe('pure relevance scoring', () => {
  it('prioritizes explicit matches and gives primary topics more weight than tags', () => {
    const explicit = { ...empty, topic_interests: ['getting-promoted'] };
    const primary = scoreCircle(base, explicit, taxonomy);
    const tagOnly = scoreCircle({ ...base, topic: null, tags: ['getting-promoted'] }, explicit, taxonomy);
    const bio = scoreCircle(base, { ...empty, bio: 'Ready for the next level.' }, taxonomy);
    expect(primary.relevanceScore).toBe(60);
    expect(tagOnly.relevanceScore).toBe(39);
    expect(bio.relevanceScore).toBe(18);
    expect(tagOnly.relevanceScore).toBeGreaterThan(bio.relevanceScore);
    expect(primary.matchingEvidence.matches[0]).toMatchObject({ source: 'explicit', matchedOn: 'primary_topic', strength: 1 });
  });

  it('does not double-count a topic across primary topic, repeated tags, interests, or sources', () => {
    const profile = { ...empty, topic_interests: ['leadership-skills'], bio: 'Building my leadership toolkit.', job_title: 'Founder' };
    const circle = { ...base, topic: 'leadership-skills', tags: ['leadership-skills'] };
    const original = scoreCircle(circle, profile, taxonomy);
    const repeated = scoreCircle({ ...circle, tags: ['leadership skills', 'leadership-skills', ' LEADERSHIP-SKILLS '] },
      { ...profile, topic_interests: ['leadership-skills', 'leadership-skills'] }, taxonomy);
    expect(repeated.relevanceScore).toBe(original.relevanceScore);
    expect(repeated.matchingEvidence.components).toEqual({ explicit: 60, bio: 0, professional: 0 });
    expect(repeated.matchingEvidence.matches).toHaveLength(1);
    expect(repeated.matchingEvidence.signals.map(signal => signal.source)).toEqual(['explicit', 'bio', 'job_title']);
  });

  it('adds a capped bonus for multiple distinct matches', () => {
    const circle = { ...base, topic: null, tags: taxonomy };
    const one = scoreCircle(circle, { ...empty, topic_interests: ['negotiation'] }, taxonomy);
    const two = scoreCircle(circle, { ...empty, topic_interests: ['negotiation', 'confidence'] }, taxonomy);
    const many = scoreCircle(circle, { ...empty, topic_interests: taxonomy }, taxonomy);
    expect(two.relevanceScore).toBeGreaterThan(one.relevanceScore);
    expect(many.matchingEvidence.components.explicit).toBe(60);
    expect(many.relevanceScore).toBeLessThanOrEqual(60);
  });

  it('handles absent profile fields, descriptions, and Circle topics safely', () => {
    const scored = scoreCircle({ ...base, topic: null, tags: [], description: null }, empty, taxonomy);
    expect(scored.relevanceScore).toBe(0);
    expect(scored.matchingEvidence.signals).toEqual([]);
    expect(scored.matchingEvidence.matches).toEqual([]);
    expect(scored.matchingEvidence.industryMatch).toBeNull();
    expect(Number.isFinite(scored.totalScore)).toBe(true);
  });

  it('uses conservative job rules and direct industry evidence with a shared five-point cap', () => {
    const circle = { ...base, topic: 'managing-a-team', tags: ['giving-feedback', 'tech'], description: null };
    const scored = scoreCircle(circle, { ...empty, job_title: 'Engineering Manager', industry: 'Technology' }, taxonomy);
    expect(scored.matchingEvidence.industryMatch).toMatchObject({ source: 'industry', evidence: 'Technology', matchedPhrase: 'tech', matchedOn: 'tag' });
    expect(scored.matchingEvidence.components.professional).toBeGreaterThan(0);
    expect(scored.matchingEvidence.components.professional).toBeLessThanOrEqual(5);
    expect(extractSignals({ ...empty, job_title: 'Product Manager' }, taxonomy)).toEqual([]);
    expect(extractSignals({ ...empty, job_title: 'Working mother' }, taxonomy)).toEqual([]);
    expect(scoreCircle(base, { ...empty, industry: 'Technology' }, taxonomy).relevanceScore).toBe(0);
  });

  it('uses phrase boundaries, documents alias evidence, and preserves explicit/bio distinctions', () => {
    const signals = extractSignals({ ...empty, bio: 'Returning to work after a career break. Prepping for a comp conversation.' }, taxonomy);
    expect(signals).toContainEqual({ topic: 'career-breaks', source: 'bio', confidence: 0.9, evidence: 'career break' });
    expect(signals).toContainEqual({ topic: 'negotiation', source: 'bio', confidence: 0.9, evidence: 'comp conversation' });
    expect(extractSignals({ ...empty, bio: 'My misconfidenceword is unusual.' }, taxonomy)).toEqual([]);
  });

  it('retains unmatched strong bio signals for later interest coverage', () => {
    const scored = scoreCircle(base, { ...empty, topic_interests: ['getting-promoted'], bio: 'Returning to work after a career break.' }, taxonomy);
    expect(scored.matchingEvidence.signals).toContainEqual({ topic: 'career-breaks', source: 'bio', confidence: 0.9, evidence: 'career break' });
    expect(scored.matchingEvidence.matches.map(match => match.topic)).toEqual(['getting-promoted']);
  });
});

describe('activity scoring and reference time', () => {
  const post = (overrides: Partial<EngagementPost> = {}): EngagementPost => ({
    circle_id: base.id, created_at: SNAPSHOT_REFERENCE_DATE,
    reaction_count: 10, comment_count: 5, save_count: 2, ...overrides,
  });

  it('scores posts, chat, recency, and bounded engagement without exceeding 15 points', () => {
    const quiet = scoreCircle({ ...base, feed_posts_30d: 0, chat_messages_30d: 0 }, empty, taxonomy);
    const busy = scoreCircle({ ...base, feed_posts_30d: 1_000_000, chat_messages_30d: 1_000_000 }, empty, taxonomy,
      Array.from({ length: 100 }, () => post({ reaction_count: 1_000_000 })));
    expect(busy.activityScore).toBeGreaterThan(quiet.activityScore);
    expect(busy.activityScore).toBeLessThanOrEqual(15);
    expect(busy.matchingEvidence.activity.boundedEngagement).toBeLessThanOrEqual(1);
    const moderate = scoreCircle(base, empty, taxonomy, [post({ reaction_count: 100, comment_count: 0, save_count: 0 })]);
    const huge = scoreCircle(base, empty, taxonomy, [post({ reaction_count: 1_000_000 })]);
    expect(huge.activityScore).toBe(moderate.activityScore);
    expect(scoreCircle(base, empty, taxonomy, [post()]).activityScore)
      .toBeGreaterThan(scoreCircle(base, empty, taxonomy, [post({ reaction_count: 0, comment_count: 0, save_count: 0 })]).activityScore);
  });

  it('includes only engagement in the 30-day window, for this Circle, and not in the future', () => {
    const scored = scoreCircle(base, empty, taxonomy, [
      post(), post({ created_at: '2026-08-22T00:00:00.000Z' }),
      post({ created_at: '2026-08-21T23:59:59.999Z' }),
      post({ created_at: '2026-09-21T00:00:00.001Z' }), post({ circle_id: 9999 }),
    ]);
    expect(scored.matchingEvidence.activity.recentEngagementPosts).toBe(2);
    expect(scored.matchingEvidence.activity.referenceDate).toBe(SNAPSHOT_REFERENCE_DATE);
  });

  it('evaluates recency and dormancy at an injected date with explicit threshold boundaries', () => {
    const circle = { ...base, last_activity_at: '2026-06-23T00:00:00.000Z', feed_posts_30d: 0, chat_messages_30d: 5 };
    const before = scoreCircle(circle, empty, taxonomy, [], { referenceDate: new Date('2026-09-20T00:00:00.000Z') });
    const at = scoreCircle(circle, empty, taxonomy);
    expect(before.matchingEvidence.activity.daysSinceLastActivity).toBe(89);
    expect(before.inactivityPenalty).toBe(0);
    expect(at.matchingEvidence.activity.daysSinceLastActivity).toBe(90);
    expect(at.inactivityPenalty).toBe(80);
    expect(scoreCircle({ ...circle, chat_messages_30d: 6 }, empty, taxonomy).inactivityPenalty).toBe(0);
    expect(scoreCircle({ ...circle, feed_posts_30d: 1 }, empty, taxonomy).inactivityPenalty).toBe(0);
    expect(before.activityScore).toBeGreaterThan(at.activityScore);
  });

  it('gives each aggregate and recency a positive, bounded contribution', () => {
    const quiet = { ...base, last_activity_at: SNAPSHOT_REFERENCE_DATE, feed_posts_30d: 0, chat_messages_30d: 0 };
    expect(scoreCircle(quiet, empty, taxonomy).activityScore).toBe(5);
    expect(scoreCircle({ ...quiet, feed_posts_30d: 20 }, empty, taxonomy).activityScore).toBe(9);
    expect(scoreCircle({ ...quiet, chat_messages_30d: 200 }, empty, taxonomy).activityScore).toBe(9);
    const older = scoreCircle({ ...quiet, last_activity_at: '2026-08-22T00:00:00.000Z' }, empty, taxonomy);
    expect(older.activityScore).toBe(2.5);
    expect(older.matchingEvidence.activity.recency).toBe(0.5);
    const future = scoreCircle({ ...quiet, last_activity_at: '2026-10-01T00:00:00.000Z' }, empty, taxonomy);
    expect(future.activityScore).toBe(5);
    expect(future.matchingEvidence.activity.daysSinceLastActivity).toBe(0);
  });

  it('makes weights and dormancy thresholds tunable', () => {
    const circle = { ...base, last_activity_at: '2026-01-01T00:00:00.000Z', feed_posts_30d: 0, chat_messages_30d: 0 };
    const scored = scoreCircle(circle, { ...empty, topic_interests: ['getting-promoted'] }, taxonomy, [], {
      config: { explicitWeight: 50, inactivityPenalty: 70, dormantAfterDays: 365 },
    });
    expect(scored.relevanceScore).toBe(50);
    expect(scored.inactivityPenalty).toBe(0);
    expect(() => scoreCircle(base, empty, taxonomy, [], { referenceDate: 'invalid' })).toThrow(RangeError);
    expect(() => scoreCircle(base, empty, taxonomy, [], { config: { chatSaturation: 0 } })).toThrow(RangeError);
    expect(() => scoreCircle(base, empty, taxonomy, [], { config: { activityWeight: -1 } })).toThrow(RangeError);
  });

  it('uses Circle ID to break tied scores and does not mutate inputs', () => {
    const circles = [{ ...base, id: 9 }, { ...base, id: 1 }];
    const snapshot = structuredClone(circles);
    const results = scoreCircles(circles, empty, taxonomy);
    expect(results.map(result => result.circle.id)).toEqual([1, 9]);
    expect(results).toEqual(scoreCircles([...circles].reverse(), empty, taxonomy));
    expect(circles).toEqual(snapshot);
  });
});

describe('scoring seeded eligible candidates', () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = openDatabase(':memory:');
    initializeSchema(db);
    seedDatabase(db, data);
  });
  afterEach(() => db.close());

  it('gives user #7 strong leadership and speaking matches', () => {
    const scored = getScoredCircles(db, 7);
    for (const id of [5, 6]) {
      const result = scored.find(row => row.circle.id === id)!;
      expect(result.matchingEvidence.components.explicit).toBe(60);
      expect(result.totalScore).toBeGreaterThan(60);
    }
    expect(scored.slice(0, 5).map(row => row.circle.id)).toEqual(expect.arrayContaining([5, 6]));
  });

  it('recognizes career-break interests from user #4’s bio despite no stated interests', () => {
    const results = getScoredCircles(db, 4);
    expect(results[0]!.matchingEvidence.signals.some(signal => signal.source === 'explicit')).toBe(false);
    const career = results.filter(result => result.circle.topic === 'career-breaks');
    expect(career.length).toBeGreaterThan(0);
    expect(career.every(result => result.matchingEvidence.components.bio === 18)).toBe(true);
  });

  it('gives user #42 activity scores without inventing personal signals', () => {
    const results = getScoredCircles(db, 42);
    expect(results.some(result => result.activityScore > 0)).toBe(true);
    expect(new Set(results.map(result => result.activityScore)).size).toBeGreaterThan(1);
    for (const result of results) {
      expect(result.relevanceScore).toBe(0);
      expect(result.matchingEvidence.signals).toEqual([]);
      expect(result.matchingEvidence.industryMatch).toBeNull();
    }
  });

  it('scores #22 above an equally relevant public dormant Circle for user #23', () => {
    db.prepare("UPDATE circles SET access = 'public' WHERE id = 21").run();
    const results = getScoredCircles(db, 23);
    const healthy = results.find(result => result.circle.id === 22)!;
    const dormant = results.find(result => result.circle.id === 21)!;
    expect(healthy.relevanceScore).toBe(dormant.relevanceScore);
    expect(healthy.totalScore).toBeGreaterThan(dormant.totalScore);
    expect(dormant.inactivityPenalty).toBe(80);
    expect(results.some(result => result.circle.id === 20)).toBe(false);
  });

  it('keeps inactive public #32 scoreable with a substantial penalty', () => {
    const result = getScoredCircles(db, 42).find(row => row.circle.id === 32)!;
    expect(result.inactivityPenalty).toBe(80);
    expect(result.totalScore).toBeLessThan(-65);
    expect(result.matchingEvidence.activity.dormant).toBe(true);
  });

  it('returns every eligible Circle, sorted deterministically with reproducible evidence', () => {
    for (const user of [7, 4, 42, 23]) {
      const results = getScoredCircles(db, user);
      expect(results).toEqual(getScoredCircles(db, user));
      expect(results.map(row => row.circle.id).sort((a, b) => a - b))
        .toEqual(getEligibleCircles(db, user).map(circle => circle.id));
      for (let i = 1; i < results.length; i++) {
        const previous = results[i - 1]!;
        const next = results[i]!;
        expect(previous.totalScore > next.totalScore || (previous.totalScore === next.totalScore && previous.circle.id < next.circle.id)).toBe(true);
      }
    }
  });
});
