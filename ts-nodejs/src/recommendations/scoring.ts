import type { EligibleCircle } from './eligibility.js';
import { containsPhrase, extractSignals, industryPhrases, normalizeText, type InterestSignal, type ScoringProfile } from './signals.js';

// Keep recency tied to the dataset snapshot rather than the wall clock.
export const SNAPSHOT_REFERENCE_DATE = '2026-09-21T00:00:00.000Z';
const DAY_MS = 86_400_000;

export const DEFAULT_SCORING_CONFIG = {
  explicitWeight: 60,
  bioWeight: 20,
  professionalWeight: 5,
  activityWeight: 15,
  tagStrength: 0.65,
  additionalMatchBonus: 0.25,
  dormantAfterDays: 90,
  dormantMaxChatMessages: 5,
  inactivityPenalty: 80,
  recencyHalfLifeDays: 30,
  feedSaturation: 20,
  chatSaturation: 200,
  engagementPerPostCap: 100,
  engagementPriorPosts: 3,
} as const;

export type ScoringConfig = { [K in keyof typeof DEFAULT_SCORING_CONFIG]: number };
export interface ScoringOptions {
  referenceDate?: Date | string;
  config?: Partial<ScoringConfig>;
}
export interface EngagementPost {
  circle_id: number;
  created_at: string;
  reaction_count: number;
  comment_count: number;
  save_count: number;
}
export interface TopicMatch extends InterestSignal {
  matchedOn: 'primary_topic' | 'tag';
  strength: number;
}
export interface IndustryMatch {
  source: 'industry';
  evidence: string;
  matchedPhrase: string;
  matchedOn: 'name' | 'description' | 'tag';
  strength: number;
}
export interface ScoredCircle {
  circle: EligibleCircle;
  relevanceScore: number;
  activityScore: number;
  inactivityPenalty: number;
  totalScore: number;
  matchingEvidence: {
    signals: InterestSignal[];
    matches: TopicMatch[];
    industryMatch: IndustryMatch | null;
    components: { explicit: number; bio: number; professional: number };
    activity: {
      referenceDate: string;
      daysSinceLastActivity: number;
      feedPosts30d: number;
      chatMessages30d: number;
      recentEngagementPosts: number;
      boundedEngagement: number;
      recency: number;
      feed: number;
      chat: number;
      dormant: boolean;
    };
    config: ScoringConfig;
  };
}

const round = (value: number) => Math.round(value * 10_000) / 10_000;
const boundedLog = (value: number, saturation: number) => Math.min(1, Math.log1p(Math.max(0, value)) / Math.log1p(saturation));

function resolveOptions(options: ScoringOptions) {
  const reference = new Date(options.referenceDate ?? SNAPSHOT_REFERENCE_DATE);
  if (!Number.isFinite(reference.getTime())) throw new RangeError('Invalid scoring reference date');
  const config: ScoringConfig = { ...DEFAULT_SCORING_CONFIG, ...options.config };
  for (const [key, value] of Object.entries(config)) {
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`Invalid scoring config: ${key}`);
  }
  for (const key of ['recencyHalfLifeDays', 'feedSaturation', 'chatSaturation', 'engagementPerPostCap', 'engagementPriorPosts'] as const) {
    if (config[key] === 0) throw new RangeError(`Scoring config ${key} must be positive`);
  }
  if (config.tagStrength >= 1) throw new RangeError('tagStrength must be less than primary-topic strength (1)');
  return { reference, config };
}

function alignment(strengths: number[], config: ScoringConfig): number {
  const sorted = [...strengths].sort((a, b) => b - a);
  return Math.min(1, (sorted[0] ?? 0) + config.additionalMatchBonus * sorted.slice(1).reduce((sum, value) => sum + value, 0));
}

function matchIndustry(profile: ScoringProfile, circle: EligibleCircle): IndustryMatch | null {
  for (const phrase of industryPhrases(profile.industry)) {
    for (const [matchedOn, texts] of [
      ['tag', circle.tags], ['name', [circle.name]], ['description', [circle.description ?? '']],
    ] as const) {
      if (texts.some(text => containsPhrase(text, phrase))) {
        return { source: 'industry', evidence: profile.industry!, matchedPhrase: phrase, matchedOn, strength: 0.5 };
      }
    }
  }
  return null;
}

export function scoreCircle(
  circle: EligibleCircle,
  profile: ScoringProfile,
  taxonomy: readonly string[],
  posts: readonly EngagementPost[] = [],
  options: ScoringOptions = {},
): ScoredCircle {
  const { reference, config } = resolveOptions(options);
  const signals = extractSignals(profile, taxonomy);
  const tags = new Set(circle.tags.map(normalizeText));
  const primary = normalizeText(circle.topic ?? '');
  const matches: TopicMatch[] = [];
  const creditedTopics = new Set<string>();

  // Credit each topic once, using the strongest signal source.
  for (const signal of signals) {
    if (creditedTopics.has(signal.topic)) continue;
    const normalized = normalizeText(signal.topic);
    const matchedOn = primary === normalized ? 'primary_topic' : tags.has(normalized) ? 'tag' : null;
    if (!matchedOn) continue;
    creditedTopics.add(signal.topic);
    matches.push({ ...signal, matchedOn, strength: signal.confidence * (matchedOn === 'primary_topic' ? 1 : config.tagStrength) });
  }
  const industryMatch = matchIndustry(profile, circle);
  const component = (source: InterestSignal['source'], weight: number) =>
    round(weight * alignment(matches.filter(match => match.source === source).map(match => match.strength), config));
  const explicit = component('explicit', config.explicitWeight);
  const bio = component('bio', config.bioWeight);
  const professional = round(config.professionalWeight * alignment([
    ...matches.filter(match => match.source === 'job_title').map(match => match.strength),
    ...(industryMatch ? [industryMatch.strength] : []),
  ], config));
  const relevanceScore = round(explicit + bio + professional);

  const timestamp = Date.parse(circle.last_activity_at);
  if (!Number.isFinite(timestamp)) throw new RangeError('Invalid Circle activity timestamp');
  const daysSinceLastActivity = Math.max(0, (reference.getTime() - timestamp) / DAY_MS);
  const recent = posts.filter(post => {
    const created = Date.parse(post.created_at);
    return post.circle_id === circle.id && created >= reference.getTime() - 30 * DAY_MS && created <= reference.getTime();
  });

  // Cap each post's engagement and reduce the influence of small samples.
  const engagementSum = recent.reduce((sum, post) => sum + Math.min(1, Math.max(0,
    post.reaction_count + 2 * post.comment_count + 3 * post.save_count) / config.engagementPerPostCap), 0);
  const boundedEngagement = engagementSum / (recent.length + config.engagementPriorPosts);
  const recency = 2 ** (-daysSinceLastActivity / config.recencyHalfLifeDays);
  const feed = boundedLog(circle.feed_posts_30d, config.feedSaturation);
  const chat = boundedLog(circle.chat_messages_30d, config.chatSaturation);
  const activityScore = round(config.activityWeight * ((5 * recency + 4 * feed + 4 * chat + 2 * boundedEngagement) / 15));
  const dormant = daysSinceLastActivity >= config.dormantAfterDays
    && circle.feed_posts_30d === 0 && circle.chat_messages_30d <= config.dormantMaxChatMessages;
  const inactivityPenalty = dormant ? config.inactivityPenalty : 0;

  return {
    circle,
    relevanceScore,
    activityScore,
    inactivityPenalty,
    totalScore: round(relevanceScore + activityScore - inactivityPenalty),
    matchingEvidence: {
      signals, matches, industryMatch,
      components: { explicit, bio, professional },
      activity: {
        referenceDate: reference.toISOString(), daysSinceLastActivity: round(daysSinceLastActivity),
        feedPosts30d: circle.feed_posts_30d, chatMessages30d: circle.chat_messages_30d,
        recentEngagementPosts: recent.length, boundedEngagement: round(boundedEngagement),
        recency: round(recency), feed: round(feed), chat: round(chat), dormant,
      },
      config,
    },
  };
}


export function scoreCircles(
  circles: readonly EligibleCircle[], profile: ScoringProfile, taxonomy: readonly string[],
  posts: readonly EngagementPost[] = [], options: ScoringOptions = {},
): ScoredCircle[] {
  resolveOptions(options);
  return circles.map(circle => scoreCircle(circle, profile, taxonomy, posts, options))
    .sort((a, b) => b.totalScore - a.totalScore || a.circle.id - b.circle.id);
}
