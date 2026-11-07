export interface ScoringProfile {
  topic_interests: string[];
  bio: string | null;
  job_title: string | null;
  industry: string | null;
}

export interface InterestSignal {
  topic: string;
  source: 'explicit' | 'bio' | 'job_title';
  confidence: number;
  evidence: string;
}

export const normalizeText = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function containsPhrase(text: string, phrase: string): boolean {
  return ` ${normalizeText(text)} `.includes(` ${normalizeText(phrase)} `);
}


export const BIO_ALIASES: Readonly<Record<string, readonly string[]>> = {
  'career-breaks': ['career break', 'returning to work', 'return after leave'],
  'leadership-skills': ['leadership toolkit', 'first leadership role', 'women leaders'],
  'managing-a-team': ['first time manager', 'leading a team'],
  'negotiation': ['comp conversation', 'pay equity', 'salary negotiation'],
  'getting-promoted': ['promotion', 'promotion paths', 'ready for the next level'],
  'public-speaking': ['presenting', 'speaking in public'],
  'visibility-recognition': ['executive presence'],
  'sponsorship-mentorship': ['mentoring', 'mentorship', 'sponsorship'],
  'imposter-syndrome': ['imposter feelings', 'impostor syndrome'],
  'stress-burnout': ['burnout'],
};

const JOB_TOPICS: Readonly<Record<string, readonly string[]>> = {
  'engineering manager': ['managing-a-team', 'giving-feedback'],
  'sales manager': ['managing-a-team'],
  'finance manager': ['managing-a-team'],
  'nonprofit director': ['leadership-skills'],
  'strategy lead': ['leadership-skills'],
  founder: ['leadership-skills'],
};

export function extractSignals(profile: ScoringProfile, taxonomy: readonly string[]): InterestSignal[] {
  const known = new Set(taxonomy);
  const signals: InterestSignal[] = [];
  for (const topic of [...new Set(profile.topic_interests)].sort()) {
    if (known.has(topic)) signals.push({ topic, source: 'explicit', confidence: 1, evidence: topic });
  }
  for (const topic of [...known].sort()) {
    const phrases = [topic.replaceAll('-', ' '), ...(BIO_ALIASES[topic] ?? [])];
    const phrase = phrases.find(value => profile.bio && containsPhrase(profile.bio, value));
    if (phrase) signals.push({ topic, source: 'bio', confidence: 0.9, evidence: phrase });
  }
  const job = normalizeText(profile.job_title ?? '');
  for (const topic of JOB_TOPICS[job] ?? []) {
    if (known.has(topic)) signals.push({ topic, source: 'job_title', confidence: 0.6, evidence: profile.job_title! });
  }
  return signals;
}

const INDUSTRY_ALIASES: Readonly<Record<string, readonly string[]>> = {
  technology: ['technology', 'tech', 'software'],
  healthcare: ['healthcare', 'health care'],
  finance: ['finance', 'financial'],
  education: ['education', 'educators'],
  nonprofit: ['nonprofit', 'non profit'],
};


export function industryPhrases(industry: string | null): readonly string[] {
  if (!industry?.trim()) return [];
  const normalized = normalizeText(industry);
  return INDUSTRY_ALIASES[normalized] ?? [normalized];
}
