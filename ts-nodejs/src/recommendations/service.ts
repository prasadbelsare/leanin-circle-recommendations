import type { DatabaseSync } from 'node:sqlite';
import { loadScoringData } from '../db/scoring-data.js';
import { getEligibleCircles } from './eligibility.js';
import { rerankCircles, type RerankOptions } from './diversity.js';
import { addExplanations, type TopicLabels } from './explanations.js';
import { scoreCircles, type ScoredCircle, type ScoringOptions } from './scoring.js';

export function getScoredCircles(db: DatabaseSync, userId: number, options: ScoringOptions = {}): ScoredCircle[] {
  const circles = getEligibleCircles(db, userId);
  const { profile, taxonomy, posts } = loadScoringData(db, userId);
  return scoreCircles(circles, profile, taxonomy, posts, options);
}

export interface DiversityServiceOptions {
  scoring?: ScoringOptions;
  diversity?: RerankOptions;
}

export function getDiversifiedCircles(db: DatabaseSync, userId: number, limit = 5, options: DiversityServiceOptions = {}) {
  return rerankCircles(getScoredCircles(db, userId, options.scoring), limit, options.diversity);
}

export function getExplainedCircles(db: DatabaseSync, userId: number, limit = 5, options: DiversityServiceOptions = {}) {
  const selected = getDiversifiedCircles(db, userId, limit, options);
  const labels = Object.fromEntries(db.prepare('SELECT slug, label FROM topics ORDER BY slug').all()
    .map(row => [String(row.slug), String(row.label)])) satisfies TopicLabels;
  return addExplanations(selected, labels);
}
