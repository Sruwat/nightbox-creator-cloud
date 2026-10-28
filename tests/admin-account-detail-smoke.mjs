import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

const backend = resolve('appcode/nightbox/backend');
const scratch = resolve('tests/.tmp');
mkdirSync(scratch, { recursive: true });
const dataDir = mkdtempSync(join(scratch, 'nightbox-admin-account-'));
const port = 31000 + Math.floor(Math.random() * 20000);
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server.js'], {
  cwd: backend,
  env: {
    ...process.env,
    PORT: String(port),
    NIGHTBOX_DATA_DIR: dataDir,
    ADMIN_EMAIL: 'admin@example.test',
    ADMIN_PASSWORD: 'strong-admin-test-password',
    NODE_ENV: 'test',
    ENABLE_HLS_TRANSCODE: 'false',
    VIDEO_STORAGE_DRIVER: 'local',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOutput = '';
server.stdout.on('data', chunk => { serverOutput += chunk.toString().slice(0, 2000); });
server.stderr.on('data', chunk => { serverOutput += chunk.toString().slice(0, 2000); });

async function request(path, options = {}) {
  const response = await fetch(origin + path, options);
  return { status: response.status, body: await response.json() };
}

try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { await fetch(origin + '/health'); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.ok(ready, `test backend started: ${serverOutput}`);
  const json = (body, token) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const admin = await request('/api/admin/login', json({ email: 'admin@example.test', password: 'strong-admin-test-password' }));
  assert.equal(admin.status, 200);
  const creator = await request('/api/auth/register', json({ email: 'creator@example.test', password: 'strong-creator-password' }));
  assert.equal(creator.status, 201);
  const id = creator.body.user.id;
  const path = `/api/admin/users/${encodeURIComponent(id)}/details`;
  assert.equal((await request(path)).status, 403);
  const auth = { Authorization: `Bearer ${admin.body.token}` };
  let details = await request(path, { headers: auth });
  assert.equal(details.status, 200);
  assert.equal(details.body.account.email, 'creator@example.test');
  assert.equal(details.body.account.hasPasswordLogin, 1);
  assert.equal(details.body.summary.videos, 0);
  assert.equal(details.body.summary.storage.quotaBytes, null);
  assert.ok(!JSON.stringify(details.body).includes('password_hash'));
  const updated = await request(`/api/admin/creators/${id}`, { ...json({ email: 'updated@example.test', telegramUserId: '123456', status: 'suspended', displayName: 'Test Creator', bio: 'Creator bio', brandColor: '#123456', avatarUrl: '' }, admin.body.token), method: 'PUT' });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  details = await request(path, { headers: auth });
  assert.equal(details.body.account.email, 'updated@example.test');
  assert.equal(details.body.account.status, 'suspended');
  assert.equal(details.body.profile.displayName, 'Test Creator');
  assert.equal(details.body.profile.brandColor, '#123456');
  const db = new DatabaseSync(join(dataDir, 'nightbox.sqlite'));
  const addEvent = db.prepare('INSERT INTO bot_events(id,user_id,bot_name,event_type,status,created_at) VALUES (?,?,?,?,?,?)');
  for (let index = 0; index < 105; index++) addEvent.run(randomUUID(), id, 'test-bot', 'upload', 'completed', new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString());
  db.close();
  details = await request(path, { headers: auth });
  assert.equal(details.body.summary.botEvents, 105);
  assert.equal(details.body.botEvents.length, 100);
  const olderEvents = await request(`/api/admin/users/${id}/activity/botEvents?offset=100`, { headers: auth });
  assert.equal(olderEvents.status, 200);
  assert.equal(olderEvents.body.records.length, 5);
  assert.equal((await request(`/api/admin/users/${id}/activity/botEvents?offset=-1`, { headers: auth })).status, 400);
  assert.equal((await request(`/api/admin/users/${id}/activity/nope`, { headers: auth })).status, 404);
  assert.equal((await request(`/api/admin/users/${admin.body.user.id}/details`, { headers: auth })).status, 200);
  console.log('Admin account detail, authorization, and edit smoke test passed');
} finally {
  if (server.exitCode === null) {
    server.kill('SIGKILL');
    await new Promise(resolve => server.once('exit', resolve));
  }
  rmSync(dataDir, { recursive: true, force: true });
}
