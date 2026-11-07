import type { EligibleCircle } from './eligibility.js';
import type { ScoredCircle, TopicMatch } from './scoring.js';
import { normalizeText } from './signals.js';

export const DEFAULT_DIVERSITY_CONFIG = {
  similarityWeight: 32,
  repeatSimilarityFactor: 0.5,
  nearDuplicatePenalty: 20,
  maxPenaltyFraction: 0.6,
  explicitCoverageBonus: 12,
  bioCoverageBonus: 10,
  professionalCoverageBonus: 2,
  maxCoverageBonus: 12,
  strongBioConfidence: 0.8,
  minimumActivityForBonus: 5,
  unsupportedContextDiscount: 1,
  virtualBonus: 4,
  hybridBonus: 2,
  openJoinBonus: 1,
  knownTopicBonus: 1,
  purposeClarityBonus: 1,
} as const;

export type DiversityConfig = { [K in keyof typeof DEFAULT_DIVERSITY_CONFIG]: number };
export interface RerankOptions { config?: Partial<DiversityConfig> }

export interface CircleSimilarity {
  similarity: number;
  samePrimaryTopic: boolean;
  tagOverlap: number;
  descriptionOverlap: number;
  nameFocusOverlap: number;
  nearDuplicate: boolean;
}

export interface DiversifiedCircle extends ScoredCircle {
  selection: {
    rank: number;
    selectionScore: number;
    similarityPenalty: number;
    coverageBonus: number;
    accessibilityBonus: number;
    purposeClarityBonus: number;
    purposeMismatchPenalty: number;
    unsupportedContextPurpose: boolean;
    hasPurposeMetadata: boolean;
    coldStart: boolean;
    comparisons: ({ circleId: number } & CircleSimilarity)[];
    newInterestCoverage: { topic: string; source: TopicMatch['source']; strengthGain: number }[];
    config: DiversityConfig;
  };
}

const round = (value: number) => Math.round(value * 10_000) / 10_000;
const normalizedSet = (values: readonly string[]) => new Set(values.map(normalizeText).filter(Boolean));
function jaccard(a: Set<string>, b: Set<string>): number {
  const union = new Set([...a, ...b]);
  return union.size ? [...a].filter(value => b.has(value)).length / union.size : 0;
}

// Strip boilerplate and topic words; shared topics are scored separately.
const STOP_WORDS = new Set(`a an the and or for of to in on with we our us you your
  is are be this that at by from as it circle circles group community collective
  supportive support women woman focused focus about join together`.split(/\s+/));

function descriptionTokens(circle: EligibleCircle): Set<string> {
  const topicWords = new Set(normalizeText(circle.topic ?? '').split(' '));
  return new Set(normalizeText(circle.description ?? '').split(' ')
    .filter(word => word.length > 2 && !STOP_WORDS.has(word) && !topicWords.has(word)));
}

// Match name variants such as "negotiation" and "negotiate".
const stem = (word: string) => word.replace(/(?:ion|ing|ed|es|e|s)$/, '');
function nameTokens(circle: EligibleCircle): Set<string> {
  return new Set(normalizeText(circle.name).split(' ')
    .filter(word => word.length > 2 && !STOP_WORDS.has(word)).map(stem));
}

// These primary topics need explicit or bio evidence, not secondary tags.
const CONTEXT_DEPENDENT_TOPICS = new Set(['working motherhood', 'career breaks', 'being the only one']);

function hasUnsupportedContextPurpose(candidate: ScoredCircle, config: DiversityConfig): boolean {
  const primary = normalizeText(candidate.circle.topic ?? '');
  return CONTEXT_DEPENDENT_TOPICS.has(primary) && !candidate.matchingEvidence.signals.some(signal =>
    normalizeText(signal.topic) === primary
    && (signal.source === 'explicit' || (signal.source === 'bio' && signal.confidence >= config.strongBioConfidence)));
}

export function compareCircles(a: EligibleCircle, b: EligibleCircle): CircleSimilarity {
  const topicA = normalizeText(a.topic ?? '');
  const topicB = normalizeText(b.topic ?? '');
  const samePrimaryTopic = !!topicA && topicA === topicB;
  // Primary topics repeated as tags must not inflate tag similarity.
  const tagsA = normalizedSet(a.tags);
  const tagsB = normalizedSet(b.tags);
  if (topicA) tagsA.delete(topicA);
  if (topicB) tagsB.delete(topicB);
  const tagOverlap = jaccard(tagsA, tagsB);
  const descriptionA = descriptionTokens(a);
  const descriptionB = descriptionTokens(b);
  const reliableDescription = descriptionA.size >= 4 && descriptionB.size >= 4;
  const descriptionOverlap = reliableDescription ? jaccard(descriptionA, descriptionB) : 0;
  const namesA = nameTokens(a);
  const namesB = nameTokens(b);
  const topicStems = new Set(topicA.split(' ').map(stem));
  const nameFocusOverlap = samePrimaryTopic && [...namesA].some(word => namesB.has(word) && topicStems.has(word))
    ? jaccard(namesA, namesB) : 0;
  const sameDescription = !!normalizeText(a.description ?? '')
    && normalizeText(a.description ?? '') === normalizeText(b.description ?? '');
  // A shared topic alone is not evidence of a duplicate.
  const nearDuplicate = (descriptionOverlap >= 0.85 && (samePrimaryTopic || tagOverlap >= 0.5))
    || (!reliableDescription && samePrimaryTopic && tagsA.size >= 2 && tagsB.size >= 2 && tagOverlap >= 0.85)
    || (!reliableDescription && samePrimaryTopic && sameDescription && nameFocusOverlap >= 1 / 3);
  return {
    similarity: round(Math.min(1, (samePrimaryTopic ? 0.5 : 0) + 0.2 * tagOverlap + 0.3 * descriptionOverlap)),
    samePrimaryTopic, tagOverlap: round(tagOverlap), descriptionOverlap: round(descriptionOverlap),
    nameFocusOverlap: round(nameFocusOverlap), nearDuplicate,
  };
}

function resolveConfig(options: RerankOptions): DiversityConfig {
  const config: DiversityConfig = { ...DEFAULT_DIVERSITY_CONFIG, ...options.config };
  for (const [key, value] of Object.entries(config)) {
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`Invalid diversity config: ${key}`);
  }
  if (config.maxPenaltyFraction > 1 || config.strongBioConfidence > 1
    || config.repeatSimilarityFactor > 1 || config.unsupportedContextDiscount > 1) {
    throw new RangeError('Diversity fractions must be between 0 and 1');
  }
  if (config.explicitCoverageBonus < config.bioCoverageBonus || config.bioCoverageBonus < config.professionalCoverageBonus) {
    throw new RangeError('Coverage weights must prioritize explicit, then bio, then professional context');
  }
  return config;
}

export function rerankCircles(
  scored: readonly ScoredCircle[], limit = 5, options: RerankOptions = {},
): DiversifiedCircle[] {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('Limit must be a nonnegative safe integer');
  const config = resolveConfig(options);
  const remaining = new Map<number, ScoredCircle>();
  for (const candidate of scored) {
    if (remaining.has(candidate.circle.id)) throw new RangeError('Scored candidate IDs must be unique');
    if (!Number.isFinite(candidate.totalScore)) throw new RangeError('Candidate total score must be finite');
    remaining.set(candidate.circle.id, candidate);
  }
  const coldStart = scored.every(row => row.matchingEvidence.signals.length === 0 && !row.matchingEvidence.industryMatch);
  const selected: DiversifiedCircle[] = [];
  const covered = new Map<string, number>();

  while (selected.length < limit && remaining.size > 0) {
    let best: DiversifiedCircle | undefined;
    for (const candidate of remaining.values()) {
      const comparisons = selected.map(row => ({ circleId: row.circle.id, ...compareCircles(candidate.circle, row.circle) }));
      const similarities = comparisons.map(comparison => comparison.similarity);
      const maxSimilarity = Math.max(0, ...similarities);
      const repeatedSimilarity = similarities.reduce((sum, value) => sum + value, 0) - maxSimilarity;
      const rawPenalty = config.similarityWeight * (maxSimilarity + config.repeatSimilarityFactor * repeatedSimilarity)
        + config.nearDuplicatePenalty * comparisons.filter(comparison => comparison.nearDuplicate).length;
      const unsupportedContextPurpose = hasUnsupportedContextPurpose(candidate, config);
      const purposeMismatchPenalty = unsupportedContextPurpose ? round(Math.max(0, candidate.relevanceScore) * config.unsupportedContextDiscount) : 0;
      // Apply the cap after the purpose discount to avoid counting it twice.
      const similarityPenalty = round(Math.min(rawPenalty,
        config.maxPenaltyFraction * Math.max(0, candidate.totalScore - purposeMismatchPenalty)));
      const hasPurposeMetadata = !!normalizeText(candidate.circle.topic ?? '')
        || candidate.circle.tags.some(tag => normalizeText(tag).length > 0)
        || descriptionTokens(candidate.circle).size >= 4;
      const healthy = candidate.inactivityPenalty === 0 && !candidate.matchingEvidence.activity.dormant
        && candidate.totalScore > 0 && candidate.activityScore >= config.minimumActivityForBonus && !unsupportedContextPurpose;
      const newInterestCoverage = candidate.matchingEvidence.matches
        .filter(match => match.source !== 'bio' || match.confidence >= config.strongBioConfidence)
        .map(match => ({ topic: match.topic, source: match.source, strengthGain: round(Math.max(0, match.strength - (covered.get(match.topic) ?? 0))) }))
        .filter(match => match.strengthGain > 0);
      const coverageBonus = healthy ? round(Math.min(config.maxCoverageBonus, newInterestCoverage.reduce((sum, match) => {
        const weight = match.source === 'explicit' ? config.explicitCoverageBonus
          : match.source === 'bio' ? config.bioCoverageBonus : config.professionalCoverageBonus;
        return sum + weight * match.strengthGain;
      }, 0))) : 0;
      // Format suggests accessibility, not proximity; Circles have no location.
      const accessibilityBonus = healthy && coldStart && hasPurposeMetadata ? round(
        (candidate.circle.format === 'virtual' ? config.virtualBonus : candidate.circle.format === 'hybrid' ? config.hybridBonus : 0)
        + (candidate.circle.join_policy === 'open' ? config.openJoinBonus : 0)
        + (candidate.circle.topic ? config.knownTopicBonus : 0),
      ) : 0;
      // Reward a clear purpose without inventing personal relevance.
      const purposeClarityBonus = healthy && !coldStart && hasPurposeMetadata ? config.purposeClarityBonus : 0;
      const result: DiversifiedCircle = {
        ...candidate,
        selection: {
          rank: selected.length + 1,
          selectionScore: round(candidate.totalScore - similarityPenalty - purposeMismatchPenalty + coverageBonus + accessibilityBonus + purposeClarityBonus),
          similarityPenalty, coverageBonus, accessibilityBonus, purposeClarityBonus, purposeMismatchPenalty,
          unsupportedContextPurpose, hasPurposeMetadata, coldStart,
          comparisons, newInterestCoverage, config,
        },
      };
      if (!best || result.selection.selectionScore > best.selection.selectionScore
        || (result.selection.selectionScore === best.selection.selectionScore && result.circle.id < best.circle.id)) best = result;
    }
    selected.push(best!);
    remaining.delete(best!.circle.id);
    for (const match of best!.matchingEvidence.matches) {
      if (!best!.selection.unsupportedContextPurpose && (match.source !== 'bio' || match.confidence >= config.strongBioConfidence)) {
        covered.set(match.topic, Math.max(covered.get(match.topic) ?? 0, match.strength));
      }
    }
  }
  return selected;
}
