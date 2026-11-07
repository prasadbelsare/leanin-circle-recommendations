import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeSchema, openDatabase } from '../src/db/connection.js';
import { loadDataset, seedDatabase } from '../src/db/seed-data.js';
import { rerankCircles } from '../src/recommendations/diversity.js';
import type { EligibleCircle } from '../src/recommendations/eligibility.js';
import { addExplanations, generateExplanation } from '../src/recommendations/explanations.js';
import { scoreCircles, SNAPSHOT_REFERENCE_DATE } from '../src/recommendations/scoring.js';
import { getDiversifiedCircles, getExplainedCircles } from '../src/recommendations/service.js';
import type { ScoringProfile } from '../src/recommendations/signals.js';

const data = loadDataset();
const taxonomy = data.topics.map(topic => topic.slug);
const labels = Object.fromEntries(data.topics.map(topic => [topic.slug, topic.label]));
const empty: ScoringProfile = { topic_interests: [], bio: null, job_title: null, industry: null };
const base: EligibleCircle = { ...data.circles.find(circle => circle.id === 5)!, join_policy: 'open' };

function selected(overrides: Partial<EligibleCircle> = {}, profile: ScoringProfile = empty) {
  return rerankCircles(scoreCircles([{ ...base, ...overrides }], profile, taxonomy), 1)[0]!;
}

describe('pure member-facing explanations', () => {
  it('attributes primary explicit interests to the member’s selections', () => {
    const text = generateExplanation(selected({}, { ...empty, topic_interests: ['leadership-skills'] }), labels);
    expect(text).toBe('Explore your interest in leadership skills with this Circle.');
  });

  it('describes secondary tags as additional topics rather than a Circle’s primary focus', () => {
    const text = generateExplanation(selected({ topic: 'stress-burnout', tags: ['work-life-integration'] }, {
      ...empty, topic_interests: ['work-life-integration'],
    }), labels);
    expect(text).toBe('Focused on stress and burnout, this Circle also connects with your interest in work-life integration.');
    expect(text).not.toContain('focuses on work-life integration');
  });

  it('can name two independently matched explicit interests with correct primary/tag attribution', () => {
    const text = generateExplanation(selected({ topic: 'confidence', tags: ['negotiation', 'negotiation'] }, {
      ...empty, topic_interests: ['confidence', 'negotiation', 'confidence'],
    }), labels);
    expect(text).toBe('Explore your interest in confidence with this Circle, which also connects with negotiation.');
  });

  it('prioritizes an explicit tag over bio or role inference without conflating their sources', () => {
    const text = generateExplanation(selected({ topic: 'leadership-skills', tags: ['confidence'] }, {
      topic_interests: ['confidence'], bio: 'Building my leadership toolkit.', job_title: 'Founder', industry: null,
    }), labels);
    expect(text).toBe('Focused on leadership skills, this Circle also connects with your interest in confidence.');
    expect(text).not.toMatch(/your bio|professional role/);
  });

  it('describes bio-derived interests as suggestions, not explicit selections or personal circumstances', () => {
    const text = generateExplanation(selected({ topic: 'career-breaks', tags: [] }, {
      ...empty, bio: 'Returning to work after a career break and finding my footing.',
    }), labels);
    expect(text).toBe('Its focus on career breaks reflects an interest suggested by your bio.');
    expect(text).not.toMatch(/you selected|you are returning/);
  });

  it('can mention two bio-derived interests and keeps bio-only tags secondary', () => {
    const profile = { ...empty, bio: 'Mentoring women leaders.' };
    const two = generateExplanation(selected({ topic: 'leadership-skills', tags: ['sponsorship-mentorship'] }, profile), labels);
    expect(two).toBe('Its focus on leadership skills and connection to sponsorship and mentorship reflect interests suggested by your bio.');
    const tag = generateExplanation(selected({ topic: 'negotiation', tags: ['sponsorship-mentorship'] }, profile), labels);
    expect(tag).toBe('Focused on negotiation, this Circle also connects with sponsorship and mentorship, an interest suggested by your bio.');
  });

  it('uses professional context cautiously without implying the member selected an interest', () => {
    const role = generateExplanation(selected({}, { ...empty, job_title: 'Founder' }), labels);
    expect(role).toBe('Its focus on leadership skills may be useful in your professional role.');
    const industry = generateExplanation(selected({ topic: null, tags: ['tech'] }, { ...empty, industry: 'Technology' }), labels);
    expect(industry).toBe('Its connection to tech may be relevant to your professional background.');
    expect(industry).not.toMatch(/focuses on tech|you selected|your bio/);
  });

  it('uses truthful generic text for opaque metadata without relying on names or location', () => {
    const text = generateExplanation(selected({
      name: 'Women of the 405 Seattle', topic: null, tags: [], description: null,
      format: 'virtual', join_policy: 'request',
    }), labels);
    expect(text).toBe('Explore a virtual Circle with recent group activity; membership requires approval.');
    expect(text).not.toMatch(/Seattle|405|nearby|local|your|you selected|bio/);
  });

  it('does not turn an unmatched tag or description into a primary topic or personal interest', () => {
    const text = generateExplanation(selected({
      topic: null, tags: ['confidence'], description: 'Peer practice for confidence and building connections.',
    }), labels);
    expect(text).not.toMatch(/focuses on|confidence|your|you selected/);
    expect(text).toContain('hybrid Circle');
  });

  it('uses general discovery for unsupported context even when secondary matches exist', () => {
    const row = selected({ topic: 'working-motherhood', tags: ['getting-promoted'] }, {
      ...empty, topic_interests: ['getting-promoted'],
    });
    expect(row.selection.unsupportedContextPurpose).toBe(true);
    const text = generateExplanation(row, labels);
    expect(text).toContain('Circle focused on working motherhood');
    expect(text).not.toMatch(/your|you selected|parent|mother yourself/);
  });

  it('never calls dormant Circles active and adds a short activity caveat to a personal match', () => {
    const row = selected({ topic: 'resilience', tags: [], feed_posts_30d: 0, chat_messages_30d: 2, last_activity_at: '2026-01-29T00:00:00.000Z' }, {
      ...empty, topic_interests: ['resilience'],
    });
    expect(row.inactivityPenalty).toBe(80);
    expect(generateExplanation(row, labels)).toBe('Explore your interest in resilience with this Circle, though recent activity is limited.');
    expect(generateExplanation(row, labels)).not.toMatch(/active|recent group activity/);
  });

  it('requires recent non-future timestamps and positive activity counts before claiming recent activity', () => {
    for (const overrides of [
      { last_activity_at: '2026-01-01T00:00:00.000Z' },
      { last_activity_at: '2026-10-01T00:00:00.000Z' },
      { last_activity_at: SNAPSHOT_REFERENCE_DATE, feed_posts_30d: 0, chat_messages_30d: 0 },
    ]) {
      expect(generateExplanation(selected(overrides), labels)).not.toContain('recent group activity');
    }
    const later = rerankCircles(scoreCircles([base], empty, taxonomy, [], { referenceDate: '2027-01-01T00:00:00.000Z' }), 1)[0]!;
    expect(generateExplanation(later, labels)).not.toContain('recent group activity');
  });

  it('states approval requirements in the same sentence without promising immediate access', () => {
    const text = generateExplanation(selected({ join_policy: 'request' }, { ...empty, topic_interests: ['leadership-skills'] }), labels);
    expect(text.endsWith('; membership requires approval.')).toBe(true);
    expect(text).not.toMatch(/join now|join immediately|instant access/);
    expect(text.match(/[.!?]/g)).toHaveLength(1);
  });

  it('ignores stale matching evidence that is no longer supported by signals or Circle metadata', () => {
    const row = selected({}, { ...empty, topic_interests: ['leadership-skills'] });
    row.matchingEvidence.signals = [];
    expect(generateExplanation(row, labels)).not.toContain('your interest');
    const changed = selected({}, { ...empty, topic_interests: ['leadership-skills'] });
    changed.circle = { ...changed.circle, topic: null, tags: [] };
    expect(generateExplanation(changed, labels)).not.toContain('leadership skills');
  });

  it('does not explain a source whose scoring weight was disabled', () => {
    const row = rerankCircles(scoreCircles([base], { ...empty, topic_interests: ['leadership-skills'] }, taxonomy, [], {
      config: { explicitWeight: 0 },
    }), 1)[0]!;
    expect(generateExplanation(row, labels)).not.toContain('your interest');
  });

  it('is deterministic and attaches explanations without changing selected objects or order', () => {
    const rows = [selected(), selected({ id: 101, topic: null, tags: [], description: null })];
    const snapshot = structuredClone(rows);
    const explained = addExplanations(rows, labels);
    expect(explained).toEqual(addExplanations(rows, labels));
    expect(explained.map(({ explanation: _explanation, ...row }) => row)).toEqual(rows);
    expect(rows).toEqual(snapshot);
    expect(addExplanations([], labels)).toEqual([]);
    expect(generateExplanation(rows[0]!)).not.toContain('undefined');
  });
});

describe('seeded recommendation explanations', () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = openDatabase(':memory:'); initializeSchema(db); seedDatabase(db, data);
  });
  afterEach(() => db.close());

  it('explains user #7’s leadership and speaking recommendations with accurate topic attribution', () => {
    const rows = getExplainedCircles(db, 7);
    expect(rows.find(row => row.circle.id === 5)!.explanation).toContain('your interest in leadership skills');
    expect(rows.find(row => row.circle.id === 6)!.explanation).toBe('Explore your interest in public speaking with this Circle, which also connects with leadership skills.');
    expect(rows.find(row => row.circle.id === 34)!.explanation).toBe('Focused on visibility and recognition, this Circle also connects with your interest in public speaking.');
  });

  it('explains user #1’s work-life integration selections and bio-derived mentorship separately', () => {
    const rows = getExplainedCircles(db, 1);
    expect(rows.find(row => row.circle.id === 24)!.explanation).toBe('Focused on stress and burnout, this Circle also connects with your interest in work-life integration.');
    expect(rows.find(row => row.circle.id === 39)!.explanation).toContain('focus on sponsorship and mentorship reflects an interest suggested by your bio');
    expect(rows.find(row => row.circle.id === 11)!.explanation).toBe('Focused on negotiation, this Circle also connects with sponsorship and mentorship, an interest suggested by your bio.');
  });

  it('explains user #4’s career-break match as bio-derived', () => {
    const first = getExplainedCircles(db, 4)[0]!;
    expect(first.explanation).toContain('focus on career breaks');
    expect(first.explanation).toContain('suggested by your bio');
    expect(first.explanation).not.toContain('you selected');
  });

  it('explains user #15’s negotiation and confidence matches', () => {
    const rows = getExplainedCircles(db, 15);
    expect(rows.find(row => row.circle.id === 12)!.explanation).toContain('your interest in negotiation');
    expect(rows.find(row => row.circle.id === 13)!.explanation).toBe('Explore your interest in confidence with this Circle, which also connects with negotiation.');
  });

  it('explains user #23’s promotion interest without assuming parenthood', () => {
    const rows = getExplainedCircles(db, 23);
    expect(rows[0]!.explanation).toBe('Explore your interest in getting promoted with this Circle; membership requires approval.');
    expect(rows.find(row => row.circle.id === 16)!.explanation).toBe('Focused on sponsorship and mentorship, this Circle also connects with your interest in getting promoted.');
    expect(rows.every(row => !/parent|motherhood|your family/.test(row.explanation))).toBe(true);
    expect(rows.some(row => row.circle.id === 27)).toBe(false);
    const opaque = getExplainedCircles(db, 23, 20).find(row => row.circle.id === 27)!;
    expect(opaque.explanation).toBe('Explore a virtual Circle with recent group activity; membership requires approval.');
  });

  it('gives user #42 factual discovery explanations without invented preferences', () => {
    const rows = getExplainedCircles(db, 42);
    for (const row of rows) {
      expect(row.explanation).toMatch(/^Explore a (virtual|hybrid) Circle focused on /);
      expect(row.explanation).not.toMatch(/your|you selected|bio|nearby|local/);
      expect(row.explanation).toContain('recent group activity');
    }
  });

  it.each([0, 25, 50, 75])('preserves scores, order, evidence, and truthful sentences for 25 seeded users starting at index %i', start => {
    for (const user of data.users.slice(start, start + 25)) {
      const rows = getExplainedCircles(db, user.id);
      expect(rows.map(({ explanation: _explanation, ...row }) => row)).toEqual(getDiversifiedCircles(db, user.id));
      for (const row of rows) {
        const text = row.explanation;
        expect(text.length).toBeGreaterThan(10);
        expect(text.split(/\s+/).length).toBeLessThanOrEqual(40);
        expect(text.match(/[.!?]/g)).toHaveLength(1);
        if (row.circle.join_policy === 'request') expect(text).toContain('membership requires approval');
        if (text.includes('your interest')) expect(row.matchingEvidence.matches.some(match => match.source === 'explicit')).toBe(true);
        if (text.includes('your bio')) expect(user.bio).not.toBeNull();
        if (row.inactivityPenalty > 0 || row.matchingEvidence.activity.dormant) expect(text).not.toContain('recent group activity');
      }
    }
  });
});
