import { beforeAll, describe, expect, it } from 'vitest';
import { assertOutputPath, createContext, createSnapshot, maskDataset, validateSplit, type Snapshot, type SplitManifest } from '../scripts/ml-bridge.js';
import { initializeSchema, openDatabase } from '../src/db/connection.js';
import { loadDataset, seedDatabase } from '../src/db/seed-data.js';
import { compareCircles } from '../src/recommendations/diversity.js';
import { UserNotFoundError } from '../src/recommendations/eligibility.js';
import { SNAPSHOT_REFERENCE_DATE } from '../src/recommendations/scoring.js';
import { getExplainedCircles, getScoredCircles } from '../src/recommendations/service.js';
import type { Dataset } from '../src/schemas/dataset.js';

const data = loadDataset();

function fixture(): Dataset {
  const users = [101, 303, 902].map(id => ({
    ...data.users[0]!, id, bio: null, industry: null, job_title: null,
    location: null, topic_interests: id === 101 ? ['decision-making'] : [],
  }));
  const circles = [11, 22, 55, 88, 144, 233, 377, 610].map(id => ({
    ...data.circles[0]!, id, name: `Community ${id}`, slug: `community-${id}`,
    topic: 'decision-making', tags: [], description: 'Practice decisions with structured peer discussion.',
    access: 'public' as const, max_members: null as number | null, member_count: 0,
    join_policy: 'open' as const, last_activity_at: SNAPSHOT_REFERENCE_DATE,
    feed_posts_30d: 20, chat_messages_30d: 200,
  }));
  const result: Dataset = {
    users, circles,
    topics: [{ id: 17, slug: 'decision-making', label: 'Decision making', domain: 'content' }],
    memberships: [
      { user_id: 101, circle_id: 11, role: 'member', joined_at: SNAPSHOT_REFERENCE_DATE },
      { user_id: 902, circle_id: 11, role: 'leader', joined_at: SNAPSHOT_REFERENCE_DATE },
      { user_id: 101, circle_id: 22, role: 'member', joined_at: SNAPSHOT_REFERENCE_DATE },
      { user_id: 101, circle_id: 55, role: 'member', joined_at: SNAPSHOT_REFERENCE_DATE },
      { user_id: 303, circle_id: 55, role: 'member', joined_at: SNAPSHOT_REFERENCE_DATE },
    ],
    activity: [
      { id: 1001, circle_id: 22, author_user_id: 101, body: 'A decision to discuss.', reaction_count: 1, comment_count: 2, save_count: 0, created_at: SNAPSHOT_REFERENCE_DATE },
      { id: 1002, circle_id: 55, author_user_id: 101, body: 'Considering an alternative.', reaction_count: 2, comment_count: 0, save_count: 1, created_at: SNAPSHOT_REFERENCE_DATE },
      { id: 1003, circle_id: 55, author_user_id: 303, body: 'A separate member post.', reaction_count: 0, comment_count: 1, save_count: 0, created_at: SNAPSHOT_REFERENCE_DATE },
    ],
  };
  Object.assign(result.circles.find(row => row.id === 11)!, { member_count: 2 });
  Object.assign(result.circles.find(row => row.id === 22)!, { member_count: 1, max_members: 2 });
  Object.assign(result.circles.find(row => row.id === 55)!, { member_count: 2 });
  Object.assign(result.circles.find(row => row.id === 144)!, { access: 'unlisted' });
  Object.assign(result.circles.find(row => row.id === 233)!, { member_count: 1, max_members: 1 });
  Object.assign(result.circles.find(row => row.id === 377)!, {
    last_activity_at: '2026-01-01T00:00:00.000Z', feed_posts_30d: 0, chat_messages_30d: 0,
  });
  Object.assign(result.circles.find(row => row.id === 610)!, {
    topic: null, tags: [], description: null, join_policy: 'request',
  });
  return result;
}

function split(): SplitManifest {
  return {
    schema_version: 1, seed: 20260921, snapshot_sha256: 'a'.repeat(64),
    validation: [{ user_id: 101, circle_id: 22 }],
    test: [{ user_id: 101, circle_id: 55 }],
    skipped_users: [
      { user_id: 303, reason: 'insufficient_history' },
      { user_id: 902, reason: 'insufficient_history' },
    ],
  };
}

describe('offline ML bridge with seeded data', () => {
  let snapshot: Snapshot;
  beforeAll(() => { snapshot = createSnapshot(data); }, 60_000);

  it('exports the unchanged full-pool scores, selection evidence, and explanations for every user', () => {
    const db = openDatabase(':memory:');
    try {
      initializeSchema(db); seedDatabase(db, data);
      expect(snapshot.schema_version).toBe(1);
      expect(snapshot.reference_date).toBe(SNAPSHOT_REFERENCE_DATE);
      expect(snapshot.dataset).toEqual(data);
      expect(snapshot.recommendations.map(row => row.user_id)).toEqual(data.users.map(user => user.id));
      for (const row of snapshot.recommendations) {
        const scored = getScoredCircles(db, row.user_id);
        expect(row.scored).toEqual(scored);
        expect(row.baseline).toEqual(getExplainedCircles(db, row.user_id, 5));
        expect(row.baseline).toEqual(row.diagnostics.slice(0, 5));
        expect(new Set(row.diagnostics.map(candidate => candidate.circle.id)).size).toBe(scored.length);
        expect(row.diagnostics.map(({ selection: _selection, explanation: _explanation, ...candidate }) => candidate)
          .sort((a, b) => a.circle.id - b.circle.id))
          .toEqual([...scored].sort((a, b) => a.circle.id - b.circle.id));
        if ([1, 4, 7, 15, 23, 42].includes(row.user_id)) {
          expect(row.diagnostics).toEqual(getExplainedCircles(db, row.user_id, scored.length));
        }
      }
    } finally { db.close(); }
  }, 60_000);

  it('exposes only eligible candidates, including request-to-join and public dormant fallbacks', () => {
    for (const row of snapshot.recommendations) {
      const joined = new Set(data.memberships.filter(m => m.user_id === row.user_id).map(m => m.circle_id));
      for (const candidate of row.scored) {
        expect(candidate.circle.access).toBe('public');
        expect(joined.has(candidate.circle.id)).toBe(false);
        expect(candidate.circle.max_members === null || candidate.circle.member_count < candidate.circle.max_members).toBe(true);
      }
    }
    const cold = snapshot.recommendations.find(row => row.user_id === 42)!;
    expect(cold.scored.find(row => row.circle.id === 32)?.inactivityPenalty).toBe(80);
    const opaque = cold.diagnostics.find(row => row.circle.id === 27)!;
    expect(opaque.selection.hasPurposeMetadata).toBe(false);
    expect(opaque.selection.purposeClarityBonus).toBe(0);
    expect(opaque.explanation).not.toMatch(/your interest|your bio|nearby/);
    const request = cold.diagnostics.find(row => row.circle.join_policy === 'request')!;
    expect(request.explanation).toContain('membership requires approval');
    expect(cold.baseline.every(row => row.matchingEvidence.signals.length === 0)).toBe(true);
  });

  it('retains the planted quality scenarios and bio-derived recommendations', () => {
    const selected = (userId: number) => snapshot.recommendations.find(row => row.user_id === userId)!.baseline;
    expect(selected(7).map(row => row.circle.topic)).toEqual(expect.arrayContaining(['leadership-skills', 'public-speaking']));
    expect(selected(15).filter(row => [10, 11, 12].includes(row.circle.id)).length).toBeLessThan(3);
    expect(selected(23)[0]!.circle.id).toBe(22);
    expect(selected(23).some(row => [20, 21, 27].includes(row.circle.id))).toBe(false);
    expect(selected(4)[0]!.matchingEvidence.matches).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'bio', topic: 'career-breaks' }),
    ]));
    expect(selected(1).some(row => row.matchingEvidence.matches.some(match => match.source === 'bio'))).toBe(true);
  });

  it('exports duplicate pairs using the same Circle comparison rules', () => {
    const context = snapshot.recommendations.find(row => row.user_id === 42)!;
    const candidates = [...context.scored].sort((a, b) => a.circle.id - b.circle.id);
    const expected: [number, number][] = [];
    for (let a = 0; a < candidates.length; a++) {
      for (let b = a + 1; b < candidates.length; b++) {
        const first = candidates[a]!.circle;
        const second = candidates[b]!.circle;
        if (compareCircles(first, second).nearDuplicate) expected.push([first.id, second.id]);
      }
    }
    expect(context.near_duplicate_pairs).toEqual(expected);
  });

  it.each([1, 3, 5, 10, 20])('returns the deterministic baseline prefix for limit %i', limit => {
    const result = createContext(snapshot, { userId: 7, limit });
    expect(result.users).toHaveLength(1);
    expect(result.users[0]!.baseline).toEqual(snapshot.recommendations.find(row => row.user_id === 7)!.diagnostics.slice(0, limit));
    expect(result).toEqual(createContext(snapshot, { userId: 7, limit }));
  });

  it('rejects unknown users and invalid IDs or limits without treating them as empty results', () => {
    expect(() => createContext(snapshot, { userId: 999_999 })).toThrow(UserNotFoundError);
    for (const userId of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => createContext(snapshot, { userId })).toThrow();
    }
    for (const limit of [0, -1, 1.5, 21, NaN, Infinity]) {
      expect(() => createContext(snapshot, { limit })).toThrow();
    }
  });
});

describe('isolated evaluation snapshot', () => {
  let snapshot: Snapshot;
  beforeAll(() => { snapshot = createSnapshot(fixture()); });

  it('protects source data and snapshot inputs from output-path mistakes', () => {
    expect(() => assertOutputPath('data/users.json')).toThrow();
    expect(() => assertOutputPath('src/server.ts')).toThrow();
    expect(() => assertOutputPath('.local/ml/snapshot.json', ['.local/ml/snapshot.json'])).toThrow();
    expect(() => assertOutputPath('.local/ml/report.json', ['.local/ml/snapshot.json'])).not.toThrow();
  });

  it('masks validation/test memberships and only their author posts without freeing seats', () => {
    const source = structuredClone(snapshot.dataset);
    const masked = maskDataset(snapshot.dataset, split());
    expect(masked.memberships.map(row => [row.user_id, row.circle_id])).toEqual([[101, 11], [902, 11], [303, 55]]);
    expect(masked.activity.map(row => row.id)).toEqual([1003]);
    expect(masked.circles).toEqual(source.circles);
    expect(snapshot.dataset).toEqual(source);
    const db = openDatabase(':memory:');
    try {
      initializeSchema(db);
      expect(() => seedDatabase(db, masked)).not.toThrow();
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { db.close(); }
  });

  it('scores held-out candidates through existing services in an isolated database', () => {
    const source = JSON.stringify(snapshot);
    const result = createContext(snapshot, { splits: split(), userId: 101, limit: 20 });
    const context = result.users[0]!;
    expect(context.scored.map(row => row.circle.id)).toEqual(expect.arrayContaining([22, 55]));
    expect(context.scored.some(row => [11, 144, 233].includes(row.circle.id))).toBe(false);
    expect(context.scored.find(row => row.circle.id === 22)!.matchingEvidence.activity.recentEngagementPosts).toBe(0);
    expect(context.scored.find(row => row.circle.id === 55)!.matchingEvidence.activity.recentEngagementPosts).toBe(1);
    const db = openDatabase(':memory:');
    try {
      initializeSchema(db); seedDatabase(db, maskDataset(snapshot.dataset, split()));
      expect(context.scored).toEqual(getScoredCircles(db, 101));
      expect(context.baseline).toEqual(getExplainedCircles(db, 101, 20));
    } finally { db.close(); }
    expect(JSON.stringify(snapshot)).toBe(source);
  });

  it('supports unseen IDs and taxonomy values with fewer results than requested', () => {
    const result = createContext(snapshot, { userId: 101, limit: 20 }).users[0]!;
    expect(result.baseline).toHaveLength(3);
    expect(result.baseline[0]!.circle.id).toBe(88);
    expect(result.baseline[0]!.explanation).toBe('Explore your interest in decision making with this Circle.');
    const inactive = result.diagnostics.find(row => row.circle.id === 377)!;
    expect(inactive.inactivityPenalty).toBe(80);
    expect(inactive.explanation).toContain('recent activity is limited');
    const opaque = result.diagnostics.find(row => row.circle.id === 610)!;
    expect(opaque.circle.join_policy).toBe('request');
    expect(opaque.explanation).toContain('membership requires approval');
    expect(opaque.matchingEvidence.matches).toEqual([]);
  });

  it('returns an empty candidate pool as a successful result', () => {
    const noCandidates = fixture();
    for (const circle of noCandidates.circles) circle.access = 'unlisted';
    const result = createContext(createSnapshot(noCandidates), { userId: 101 }).users[0]!;
    expect(result.scored).toEqual([]);
    expect(result.baseline).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    expect(result.near_duplicate_pairs).toEqual([]);
  });

  it('validates split provenance and rejects duplicate, overlapping, missing, or leader holdouts', () => {
    expect(validateSplit(snapshot, split(), 'a'.repeat(64))).toEqual(split());
    expect(() => validateSplit(snapshot, split(), 'b'.repeat(64))).toThrow();
    const invalid = [
      { ...split(), validation: [split().validation[0]!, split().validation[0]!] },
      { ...split(), test: split().validation },
      { ...split(), validation: [{ user_id: 101, circle_id: 88 }] },
      { ...split(), validation: [{ user_id: 902, circle_id: 11 }] },
      { ...split(), validation: [{ user_id: 9999, circle_id: 22 }] },
      { ...split(), schema_version: 2 },
      { ...split(), seed: 0.5 },
      { ...split(), snapshot_sha256: 'invalid' },
    ];
    for (const manifest of invalid) expect(() => validateSplit(snapshot, manifest)).toThrow();
  });

  it('rejects held-out users with no retained training history', () => {
    const reduced = fixture();
    reduced.memberships = reduced.memberships.filter(row => !(row.user_id === 101 && row.circle_id === 11));
    expect(() => validateSplit(createSnapshot(reduced), split())).toThrow();
  });

  it('validates source dataset relationships before exporting', () => {
    const invalid = fixture();
    invalid.users[0]!.topic_interests = ['unknown-topic'];
    expect(() => createSnapshot(invalid)).toThrow();
  });
});
