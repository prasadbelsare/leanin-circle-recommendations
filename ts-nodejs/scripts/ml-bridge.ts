import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { initializeSchema, openDatabase } from '../src/db/connection.js';
import { loadDataset, seedDatabase } from '../src/db/seed-data.js';
import { datasetSchema, type Dataset } from '../src/schemas/dataset.js';
import { compareCircles, rerankCircles } from '../src/recommendations/diversity.js';
import { addExplanations, type ExplainedCircle } from '../src/recommendations/explanations.js';
import { SNAPSHOT_REFERENCE_DATE, type ScoredCircle } from '../src/recommendations/scoring.js';
import { getScoredCircles } from '../src/recommendations/service.js';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const pairSchema = z.strictObject({ user_id: id, circle_id: id });
const splitSchema = z.strictObject({
  schema_version: z.literal(1),
  seed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  snapshot_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  validation: z.array(pairSchema),
  test: z.array(pairSchema),
  skipped_users: z.array(z.strictObject({ user_id: id, reason: z.string().min(1) })),
});

export type SplitManifest = z.infer<typeof splitSchema>;
export interface SnapshotInput {
  schema_version: 1;
  reference_date: string;
  dataset: Dataset;
}
export interface UserContext {
  user_id: number;
  scored: ScoredCircle[];
  baseline: ExplainedCircle[];
  diagnostics: ExplainedCircle[];
  near_duplicate_pairs: [number, number][];
}
export interface Snapshot extends SnapshotInput { recommendations: UserContext[] }

const key = (row: { user_id: number; circle_id: number }) => `${row.user_id}:${row.circle_id}`;

export function validateSplit(snapshot: SnapshotInput, input: unknown, snapshotHash?: string): SplitManifest {
  const splits = splitSchema.parse(input);
  if (snapshotHash !== undefined && splits.snapshot_sha256 !== snapshotHash) {
    throw new Error('Split manifest belongs to a different snapshot');
  }
  const memberships = new Map(snapshot.dataset.memberships.map(row => [key(row), row]));
  const users = new Set(snapshot.dataset.users.map(row => row.id));
  const heldOut = new Set<string>();
  const validationUsers = new Set<number>();
  const testUsers = new Set<number>();
  for (const [rows, cohort] of [[splits.validation, validationUsers], [splits.test, testUsers]] as const) {
    for (const row of rows) {
      const pair = key(row);
      if (memberships.get(pair)?.role !== 'member') throw new Error('Held-out targets must be existing ordinary-member memberships');
      if (heldOut.has(pair) || cohort.has(row.user_id)) throw new Error('Duplicate or overlapping held-out targets');
      heldOut.add(pair);
      cohort.add(row.user_id);
    }
  }
  if (validationUsers.size !== testUsers.size || [...validationUsers].some(user => !testUsers.has(user))) {
    throw new Error('Each evaluated user needs one validation and one test target');
  }
  for (const user of validationUsers) {
    if (!snapshot.dataset.memberships.some(row => row.user_id === user && !heldOut.has(key(row)))) {
      throw new Error('Each evaluated user must retain a training membership');
    }
  }
  const skipped = new Set<number>();
  for (const row of splits.skipped_users) {
    if (!users.has(row.user_id) || skipped.has(row.user_id) || validationUsers.has(row.user_id)) {
      throw new Error('Invalid skipped-user cohort');
    }
    skipped.add(row.user_id);
    const history = snapshot.dataset.memberships.filter(membership => membership.user_id === row.user_id);
    if (row.reason !== 'insufficient_history' || (history.length >= 3 && history.filter(membership => membership.role === 'member').length >= 2)) {
      throw new Error('Skipped users must have insufficient history');
    }
  }
  if ([...users].some(user => !validationUsers.has(user) && !skipped.has(user))) {
    throw new Error('Split manifest must account for every user');
  }
  return splits;
}

export function maskDataset(dataset: Dataset, splits: SplitManifest): Dataset {
  validateSplit({ schema_version: 1, reference_date: SNAPSHOT_REFERENCE_DATE, dataset }, splits);
  const hidden = new Set([...splits.validation, ...splits.test].map(key));
  // Snapshot capacity stays fixed: hiding a label is not a member departure.
  return datasetSchema.parse({
    ...dataset,
    memberships: dataset.memberships.filter(row => !hidden.has(key(row))),
    activity: dataset.activity.filter(row => !hidden.has(`${row.author_user_id}:${row.circle_id}`)),
  });
}

export function createContext(
  snapshot: SnapshotInput,
  options: { splits?: SplitManifest; userId?: number; limit?: number } = {},
) {
  if (snapshot.schema_version !== 1 || snapshot.reference_date !== SNAPSHOT_REFERENCE_DATE) {
    throw new Error('Unsupported snapshot schema or reference date');
  }
  const limit = z.number().int().min(1).max(20).parse(options.limit ?? 5);
  if (options.userId !== undefined) id.parse(options.userId);
  const original = datasetSchema.parse(snapshot.dataset);
  const data = options.splits ? maskDataset(original, options.splits) : original;
  const db = openDatabase(':memory:');
  try {
    initializeSchema(db);
    seedDatabase(db, data);
    const labels = Object.fromEntries(data.topics.map(topic => [topic.slug, topic.label]));
    const ids = options.userId === undefined ? data.users.map(user => user.id).sort((a, b) => a - b) : [options.userId];
    const users: UserContext[] = ids.map(user_id => {
      const scored = getScoredCircles(db, user_id);
      const diagnostics = addExplanations(rerankCircles(scored, scored.length), labels);
      const near_duplicate_pairs: [number, number][] = [];
      const circles = scored.map(row => row.circle).sort((a, b) => a.id - b.id);
      for (let i = 0; i < circles.length; i++) {
        for (let j = i + 1; j < circles.length; j++) {
          if (compareCircles(circles[i]!, circles[j]!).nearDuplicate) {
            near_duplicate_pairs.push([circles[i]!.id, circles[j]!.id]);
          }
        }
      }
      return { user_id, scored, diagnostics, baseline: diagnostics.slice(0, limit), near_duplicate_pairs };
    });
    return { schema_version: 1 as const, reference_date: SNAPSHOT_REFERENCE_DATE, users };
  } finally {
    db.close();
  }
}

export function createSnapshot(input: Dataset): Snapshot {
  const snapshot: SnapshotInput = {
    schema_version: 1, reference_date: SNAPSHOT_REFERENCE_DATE, dataset: datasetSchema.parse(input),
  };
  return { ...snapshot, recommendations: createContext(snapshot).users };
}

function readSnapshot(path: string): SnapshotInput {
  const envelope = z.object({
    schema_version: z.literal(1), reference_date: z.literal(SNAPSHOT_REFERENCE_DATE), dataset: datasetSchema,
  });
  return envelope.parse(JSON.parse(readFileSync(path, 'utf8')) as unknown);
}

export function assertOutputPath(path: string, inputs: string[] = []) {
  const canonical = (value: string): string => {
    const target = resolve(value);
    if (existsSync(target)) return realpathSync(target);
    if (dirname(target) === target) throw new Error('Output drive is unavailable');
    return resolve(canonical(dirname(target)), basename(target));
  };
  const target = canonical(path);
  if (inputs.some(input => relative(canonical(input), target) === '')) throw new Error('Output must not overwrite an input');
  const nodeRoot = canonical(fileURLToPath(new URL('../', import.meta.url)));
  const root = canonical(resolve(nodeRoot, '..'));
  const isWithin = (directory: string) => {
    const path = relative(directory, target);
    return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
  };
  if (isWithin(root) && !isWithin(resolve(nodeRoot, '.local')) && !isWithin(resolve(root, 'ml', '.local'))) {
    throw new Error('Repository experiment outputs must stay under ml/.local or ts-nodejs/.local');
  }
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, 'utf8');
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

function runCli() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string' }, snapshot: { type: 'string' }, splits: { type: 'string' },
      'data-dir': { type: 'string' }, 'user-id': { type: 'string' }, limit: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    process.stdout.write('Offline ML bridge: export --out FILE [--data-dir DIR]\ncontext --snapshot FILE [--splits FILE] [--user-id ID] [--limit 1..20] [--out FILE]\n');
    return;
  }
  if (positionals.length !== 1) throw new Error('Choose exactly one command: export or context');
  if (values.out) assertOutputPath(values.out, [values.snapshot, values.splits].filter((path): path is string => !!path));
  const command = positionals[0];
  let result: unknown;
  if (command === 'export') {
    if (!values.out || values.snapshot || values.splits || values['user-id'] || values.limit) {
      throw new Error('export requires --out; only --data-dir is optional');
    }
    result = createSnapshot(values['data-dir'] ? loadDataset(resolve(values['data-dir'])) : loadDataset());
  } else if (command === 'context') {
    if (!values.snapshot || values['data-dir']) throw new Error('context requires --snapshot and does not accept --data-dir');
    const path = resolve(values.snapshot);
    const snapshot = readSnapshot(path);
    const splits = values.splits ? validateSplit(snapshot, JSON.parse(readFileSync(resolve(values.splits), 'utf8')) as unknown,
      createHash('sha256').update(readFileSync(path)).digest('hex')) : undefined;
    const integer = (value: string) => {
      if (!/^[1-9]\d*$/.test(value)) throw new Error('IDs and limits must be positive decimal integers');
      return id.parse(Number(value));
    };
    result = createContext(snapshot, {
      ...(splits ? { splits } : {}),
      ...(values['user-id'] ? { userId: integer(values['user-id']) } : {}),
      ...(values.limit ? { limit: integer(values.limit) } : {}),
    });
  } else {
    throw new Error('Unknown command; expected export or context');
  }
  if (values.out) {
    writeJson(resolve(values.out), result);
    process.stderr.write(`Wrote ${values.out}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { runCli(); } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'ML bridge failed'}\n`);
    process.exitCode = 1;
  }
}
