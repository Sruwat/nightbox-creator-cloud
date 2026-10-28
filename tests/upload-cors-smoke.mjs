import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const backend = resolve('appcode/nightbox/backend');
const scratch = resolve('tests/.tmp');
mkdirSync(scratch, { recursive: true });
const dataDir = mkdtempSync(join(scratch, 'nightbox-upload-cors-'));
const port = 32000 + Math.floor(Math.random() * 1000);
const origin = `http://127.0.0.1:${port}`;
const webOrigin = 'https://nightbox.in';
const server = spawn(process.execPath, ['server.js'], {
  cwd: backend,
  env: {
    ...process.env,
    PORT: String(port),
    NIGHTBOX_DATA_DIR: dataDir,
    NODE_ENV: 'production',
    TRUST_PROXY: 'true',
    VIDEO_STORAGE_DRIVER: 'local',
    VIDEO_STORAGE_ROOT: join(dataDir, 'media'),
    BUNNY_CDN_HOST: 'cdn.example.test',
    WEB_ORIGINS: webOrigin,
    AUTH_SECRET: 'upload-cors-auth-secret-2026-strong-value',
    IP_HASH_SECRET: 'upload-cors-ip-secret-2026-strong-value',
    VIEW_HASH_SECRET: 'upload-cors-view-secret-2026-strong-value',
    ADMIN_API_KEY: 'upload-cors-admin-key-2026-strong-value',
    IPQUALITYSCORE_API_KEY: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
server.stdout.on('data', (chunk) => { output += chunk.toString().slice(0, 1000); });
server.stderr.on('data', (chunk) => { output += chunk.toString().slice(0, 1000); });

try {
  let ready = false;
  for (let attempt = 0; attempt < 70; attempt += 1) {
    try { await fetch(`${origin}/health`); ready = true; break; } catch { await new Promise((resolveWait) => setTimeout(resolveWait, 100)); }
  }
  assert.ok(ready, `backend started: ${output}`);

  const preflight = await fetch(`${origin}/upload-file`, {
    method: 'OPTIONS',
    headers: {
      Origin: webOrigin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), webOrigin);
  assert.match(preflight.headers.get('access-control-allow-methods') || '', /POST/);
  assert.match(preflight.headers.get('access-control-allow-headers') || '', /Authorization/);

  const unauthenticated = await fetch(`${origin}/upload-file`, {
    method: 'POST',
    headers: { Origin: webOrigin },
    body: new FormData(),
  });
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.headers.get('access-control-allow-origin'), webOrigin);
  console.log('upload-cors-smoke: passed (preflight and upload error responses include CORS headers)');
} finally {
  server.kill('SIGTERM');
  await new Promise((resolveExit) => {
    if (server.exitCode !== null) return resolveExit();
    server.once('exit', resolveExit);
    setTimeout(resolveExit, 2000);
  });
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Temporary test cleanup is best effort on Windows. */ }
}
