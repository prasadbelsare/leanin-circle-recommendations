// Isolate HTTP checks from the application database.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { initializeSchema, openDatabase } from '../dist/db/connection.js';
import { loadDataset, seedDatabase } from '../dist/db/seed-data.js';
import { getExplainedCircles, getScoredCircles } from '../dist/recommendations/service.js';

const root = fileURLToPath(new URL('../', import.meta.url));
mkdirSync(join(root, '.local'), { recursive: true });
const databasePath = join(root, '.local', `verification-${randomUUID()}.sqlite`);
const data = loadDataset();
const db = openDatabase(databasePath);
initializeSchema(db);
seedDatabase(db, data);

const reservation = createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const child = process.platform === 'win32'
  ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm.cmd start'], {
    cwd: root, env: { ...process.env, PORT: String(port), DATABASE_PATH: databasePath }, windowsHide: true,
  })
  : spawn('npm', ['start'], { cwd: root, env: { ...process.env, PORT: String(port), DATABASE_PATH: databasePath }, detached: true });
let output = '';
let startupError;
child.stdout.on('data', chunk => { output += chunk; });
child.stderr.on('data', chunk => { output += chunk; });
child.on('error', error => { startupError = error; });
const url = path => `http://127.0.0.1:${port}${path}`;
let requests = 0;
let result;

async function call(path, status = 200) {
  const response = await fetch(url(path));
  requests++;
  assert.equal(response.status, status, path);
  assert.match(response.headers.get('content-type'), /json/);
  return response.json();
}

try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (startupError || child.exitCode !== null) throw new Error(`Server failed: ${startupError ?? output}`);
    try {
      const response = await fetch(url('/health'));
      if (response.ok) { ready = true; break; }
    } catch {}
    await delay(100);
  }
  assert.ok(ready, `Server startup timed out: ${output}`);
  assert.deepEqual(await call('/health'), { status: 'ok', database: 'ok' });
  const summaries = [];
  for (const userId of [1, 4, 7, 15, 23, 42]) {
    const first = await call(`/users/${userId}/recommendations`);
    assert.deepEqual(first, await call(`/users/${userId}/recommendations`));
    if ([7, 42].includes(userId)) {
      assert.deepEqual(first, JSON.parse(readFileSync(join(root, 'docs', 'examples', `user-${userId}-recommendations.json`), 'utf8')));
    }
    summaries.push({ user_id: userId, top_five: first.recommendations.map(row => row.circle_id) });
    const joined = new Set(data.memberships.filter(row => row.user_id === userId).map(row => row.circle_id));
    for (const limit of [1, 3, 5, 10, 20]) {
      const expected = getExplainedCircles(db, userId, limit);
      const body = await call(`/users/${userId}/recommendations?limit=${limit}`);
      assert.deepEqual(body.metadata, { user_id: userId, requested_limit: limit, count: expected.length });
      assert.deepEqual(body.recommendations, expected.map(row => ({
        rank: row.selection.rank, circle_id: row.circle.id, name: row.circle.name,
        ...(row.circle.description !== null ? { description: row.circle.description } : {}),
        primary_topic: row.circle.topic, format: row.circle.format, join_policy: row.circle.join_policy,
        explanation: row.explanation,
      })));
      for (const row of body.recommendations) {
        const circle = data.circles.find(circle => circle.id === row.circle_id);
        assert.equal(circle.access, 'public');
        assert.ok(circle.max_members === null || circle.member_count < circle.max_members);
        assert.ok(!joined.has(circle.id));
        assert.ok(row.explanation.length > 0);
        if (circle.join_policy === 'request') assert.match(row.explanation, /membership requires approval/);
      }
    }
  }
  for (const path of ['/users/0/recommendations', '/users/7/recommendations?limit=0', '/users/7/recommendations?limit=21', '/users/7/recommendations?limit=1&limit=2']) {
    assert.equal((await call(path, 400)).error.code, 'INVALID_REQUEST');
  }
  assert.equal((await call('/users/999999/recommendations', 404)).error.code, 'USER_NOT_FOUND');
  db.prepare('UPDATE circles SET cover_image_url = ? WHERE id = 35').run('invalid-url');
  assert.deepEqual(await call('/users/7/recommendations', 500), {
    error: { code: 'INTERNAL_ERROR', message: 'Unable to load recommendations.' },
  });
  seedDatabase(db, data);
  // Separate inactivity from unlisted status using only the disposable database.
  db.prepare("UPDATE circles SET access = CASE WHEN id IN (21, 22) THEN 'public' ELSE 'unlisted' END").run();
  const alternatives = await call('/users/23/recommendations?limit=20');
  assert.deepEqual(alternatives.recommendations.map(row => row.circle_id), [22, 21]);
  assert.match(alternatives.recommendations[1].explanation, /recent activity is limited/);
  assert.equal(getScoredCircles(db, 23).find(row => row.circle.id === 21).inactivityPenalty, 80);
  db.prepare("UPDATE circles SET access = 'unlisted'").run();
  assert.deepEqual(await call('/users/23/recommendations'), {
    metadata: { user_id: 23, requested_limit: 5, count: 0 }, recommendations: [],
  });
  result = { status: 'passed', requests, summaries };
} finally {
  // Stop only this script's process tree, including the npm wrapper.
  if (child.pid) {
    if (process.platform === 'win32') {
      const stopped = spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
      if (stopped.status !== 0 && child.exitCode === null) {
        db.close();
        throw new Error('Could not stop the verification server; process control may be restricted. Its database remains under .local.');
      }
    }
    else { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
    if (child.exitCode === null) await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(3000)]);
  }
  db.close();
  for (const suffix of ['', '-journal', '-shm', '-wal']) {
    try { unlinkSync(`${databasePath}${suffix}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
console.log(JSON.stringify(result, null, 2));
