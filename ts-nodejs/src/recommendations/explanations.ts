import type { DiversifiedCircle } from './diversity.js';
import type { TopicMatch } from './scoring.js';
import { normalizeText } from './signals.js';

export type TopicLabels = Readonly<Record<string, string>>;
export interface ExplainedCircle extends DiversifiedCircle { explanation: string }

const SOURCE_PRIORITY = { explicit: 0, bio: 1, job_title: 2 } as const;
const DAY_MS = 86_400_000;

function topicLabel(topic: string, labels: TopicLabels): string {
  const label = (labels[topic] ?? topic.replaceAll('-', ' ')).trim().replaceAll('&', 'and');
  return label.charAt(0).toLowerCase() + label.slice(1);
}

function supportedMatches(row: DiversifiedCircle): TopicMatch[] {
  const { matches, signals, components } = row.matchingEvidence;
  const tags = new Set(row.circle.tags.map(normalizeText));
  const gains = new Map(row.selection.newInterestCoverage.map(match => [match.topic, match.strengthGain]));
  return matches.filter(match => {
    const component = match.source === 'explicit' ? components.explicit : match.source === 'bio' ? components.bio : components.professional;
    return component > 0 && match.strength > 0 && match.evidence.trim().length > 0
      && signals.some(signal => signal.topic === match.topic && signal.source === match.source && signal.evidence === match.evidence)
      && (match.source !== 'bio' || match.confidence >= row.selection.config.strongBioConfidence)
      && (match.matchedOn === 'primary_topic'
        ? normalizeText(row.circle.topic ?? '') === normalizeText(match.topic)
        : tags.has(normalizeText(match.topic)));
  }).sort((a, b) => SOURCE_PRIORITY[a.source] - SOURCE_PRIORITY[b.source]
    || b.strength - a.strength
    || (gains.get(b.topic) ?? 0) - (gains.get(a.topic) ?? 0)
    || (a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : 0));
}

function matchReason(row: DiversifiedCircle, matches: TopicMatch[], labels: TopicLabels): string | undefined {
  const first = matches[0];
  if (!first) return undefined;
  // Keep both interests from one source so attribution stays accurate.
  const second = matches.find(match => match.source === first.source && match.topic !== first.topic);
  const label = topicLabel(first.topic, labels);
  const other = second ? topicLabel(second.topic, labels) : undefined;
  if (first.matchedOn === 'primary_topic') {
    if (first.source === 'explicit') return `Explore your interest in ${label} with this Circle${other ? `, which also connects with ${other}` : ''}`;
    const focus = `Its focus on ${label}${other ? ` and connection to ${other}` : ''}`;
    if (first.source === 'bio') return `${focus} ${other ? 'reflect interests' : 'reflects an interest'} suggested by your bio`;
    return `${focus} may be useful in your professional role`;
  }
  const purpose = row.circle.topic ? `Focused on ${topicLabel(row.circle.topic, labels)}, this Circle` : 'This Circle';
  const connection = `${purpose}${row.circle.topic ? ' also' : ''} connects with`;
  const interests = `${label}${other ? ` and ${other}` : ''}`;
  if (first.source === 'explicit') return `${connection} your interest in ${interests}`;
  if (first.source === 'bio') return `${connection} ${interests}, ${other ? 'interests' : 'an interest'} suggested by your bio`;
  return `${purpose}'s connection to ${interests} may be useful in your professional role`;
}

function hasRecentActivity(row: DiversifiedCircle): boolean {
  const reference = Date.parse(row.matchingEvidence.activity.referenceDate);
  const lastActivity = Date.parse(row.circle.last_activity_at);
  return row.inactivityPenalty === 0 && !row.matchingEvidence.activity.dormant
    && lastActivity <= reference && lastActivity >= reference - 30 * DAY_MS
    && (row.circle.feed_posts_30d > 0 || row.circle.chat_messages_30d > 0);
}

function discoveryReason(row: DiversifiedCircle, labels: TopicLabels): string {
  const format = { virtual: 'a virtual', hybrid: 'a hybrid', in_person: 'an in-person' }[row.circle.format];
  // Only a primary topic can supply the Circle's stated focus.
  const focus = row.circle.topic ? ` focused on ${topicLabel(row.circle.topic, labels)}` : '';
  const activity = hasRecentActivity(row) ? `${focus ? ',' : ''} with recent group activity` : '';
  return `Explore ${format} Circle${focus}${activity}`;
}

export function generateExplanation(row: DiversifiedCircle, labels: TopicLabels = {}): string {
  let reason: string | undefined;
  if (!row.selection.coldStart && !row.selection.unsupportedContextPurpose) {
    const matches = supportedMatches(row);
    const industry = row.matchingEvidence.industryMatch;
    const best = matches[0];
    if (industry && row.matchingEvidence.components.professional > 0
      && (!best || (best.source === 'job_title' && industry.strength > best.strength))) {
      reason = `Its connection to ${industry.matchedPhrase} may be relevant to your professional background`;
    } else {
      reason = matchReason(row, matches, labels);
    }
  }
  reason ??= discoveryReason(row, labels);
  if (row.inactivityPenalty > 0 || row.matchingEvidence.activity.dormant) reason += ', though recent activity is limited';
  if (row.circle.join_policy === 'request') reason += '; membership requires approval';
  return `${reason}.`;
}

export function addExplanations(rows: readonly DiversifiedCircle[], labels: TopicLabels = {}): ExplainedCircle[] {
  return rows.map(row => ({ ...row, explanation: generateExplanation(row, labels) }));
}
