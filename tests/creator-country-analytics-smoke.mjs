import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const backend = resolve('appcode/nightbox/backend');
const scratch = resolve('tests/.tmp');
mkdirSync(scratch, { recursive: true });
const dataDir = mkdtempSync(join(scratch, 'nightbox-country-'));
const port = 31000 + Math.floor(Math.random() * 20000);
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server.js'], {
  cwd: backend,
  env: { ...process.env, PORT: String(port), NIGHTBOX_DATA_DIR: dataDir, NODE_ENV: 'test', TRUST_PROXY: 'true', ENABLE_HLS_TRANSCODE: 'false', VIDEO_STORAGE_DRIVER: 'local', IPQUALITYSCORE_API_KEY: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
server.stdout.on('data', chunk => { output += chunk.toString().slice(0, 1000); });
server.stderr.on('data', chunk => { output += chunk.toString().slice(0, 1000); });

async function request(path, options = {}) {
  const response = await fetch(origin + path, options);
  return { status: response.status, body: await response.json() };
}

try {
  let ready = false;
  for (let attempt = 0; attempt < 70; attempt++) {
    try { await fetch(origin + '/health'); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.ok(ready, `backend started: ${output}`);
  const registered = await request('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'country-test@example.test', password: 'strong-test-password' }) });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  const creatorId = registered.body.user.id;
  const auth = { Authorization: `Bearer ${registered.body.token}` };
  const db = new DatabaseSync(join(dataDir, 'nightbox.sqlite'));
  const videoId = randomUUID();
  const linkId = randomUUID();
  const slug = `country-test-${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  db.prepare('INSERT INTO videos(id,owner_id,title,watch_url,embed_url,status,playback_status,hls_url,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(videoId, creatorId, 'Country test', 'https://nightbox.in/watch/test', 'https://nightbox.in/embed/test', 'active', 'ready', 'https://cdn.example.test/test.m3u8', now);
  db.prepare('INSERT INTO creator_links(id,video_id,creator_id,slug,created_at) VALUES (?,?,?,?,?)').run(linkId, videoId, creatorId, slug, now);
  assert.equal((await request('/api/creator/analytics')).status, 401);
  const start = async (ip, spoofedCountry) => request(`/api/links/${slug}/view/start`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 CountryTest', 'X-Real-IP': ip, 'CF-IPCountry': spoofedCountry }, body: '{}' });
  const us = await start('8.8.8.8', 'FR');
  const au = await start('1.1.1.1', 'FR');
  assert.equal(us.status, 201, JSON.stringify(us.body));
  assert.equal(au.status, 201, JSON.stringify(au.body));
  assert.equal(us.body.counted, true);
  assert.equal(au.body.counted, true);
  const countries = (await request('/api/creator/analytics', { headers: auth })).body.countries;
  assert.deepEqual(countries.map(row => row.country).sort(), ['AU', 'US']);
  assert.equal((await request('/api/creator/overview?range=all', { headers: auth })).body.dailyActivity.reduce((sum, row) => sum + row.views, 0), 2);
  const older = new Date(Date.now() - 10 * 86400000).toISOString();
  db.prepare('UPDATE view_sessions SET qualified_at=? WHERE id=?').run(older, us.body.sessionId);
  db.prepare('UPDATE earnings SET created_at=? WHERE view_id=?').run(older, us.body.sessionId);
  assert.equal((await request('/api/creator/overview?range=week', { headers: auth })).body.dailyActivity.reduce((sum, row) => sum + row.views, 0), 1);
  assert.equal((await request('/api/creator/overview?range=all', { headers: auth })).body.dailyActivity.reduce((sum, row) => sum + row.views, 0), 2);
  db.close();
  console.log('Country attribution and all-date creator analytics smoke test passed');
} finally {
  if (server.exitCode === null) {
    server.kill('SIGKILL');
    await new Promise(resolve => server.once('exit', resolve));
  }
  rmSync(dataDir, { recursive: true, force: true });
}
