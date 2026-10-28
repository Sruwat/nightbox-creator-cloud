const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightbox-local-hls-test-'));
const mediaDir = path.join(root, 'media');
const dataDir = path.join(root, 'data');
const tempDir = path.join(root, 'temp');
const fixtureDir = path.join(root, 'fixture');
const videoId = '12345678-1234-1234-1234-123456789abc';
const readyVideoId = 'abcdefab-1234-1234-1234-abcdefabcdef';
const sourcePath = path.join(mediaDir, `${videoId}.mp4`);
const env = {
  ...process.env,
  NODE_ENV: 'test',
  VIDEO_STORAGE_DRIVER: 'local',
  VIDEO_STORAGE_ROOT: mediaDir,
  NIGHTBOX_DATA_DIR: dataDir,
  TEMP_DIR: tempDir,
  HLS_TEMP_DIR: tempDir,
  BUNNY_CDN_HOST: 'cdn.example.test',
  ENABLE_HLS_TRANSCODE: 'true',
  FFMPEG_BIN: 'nightbox-nonexistent-ffmpeg-test',
};

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function request(port, endpoint) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: endpoint }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
    }).on('error', reject);
  });
}

async function waitFor(port, expectedStatus, id = videoId) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await request(port, `/video/${id}`);
      if (response.status === expectedStatus) return response;
    } catch (error) {
      if (error.code !== 'ECONNREFUSED') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for video HTTP ${expectedStatus}`);
}

async function main() {
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.mkdirSync(fixtureDir, { recursive: true });
  fs.writeFileSync(sourcePath, 'test source must survive a failed transcode');
  fs.writeFileSync(path.join(mediaDir, `${readyVideoId}.mp4`), 'ready source');
  fs.writeFileSync(path.join(fixtureDir, 'segment_00000.ts'), 'segment');
  fs.writeFileSync(path.join(fixtureDir, 'master.m3u8'), '#EXTM3U\n');

  process.env.VIDEO_STORAGE_DRIVER = env.VIDEO_STORAGE_DRIVER;
  process.env.VIDEO_STORAGE_ROOT = env.VIDEO_STORAGE_ROOT;
  process.env.BUNNY_CDN_HOST = env.BUNNY_CDN_HOST;
  const bunny = require('./bunny');
  await bunny.uploadHlsDirectory(videoId, fixtureDir);
  assert.equal(fs.readFileSync(path.join(mediaDir, 'hls', videoId, 'master.m3u8'), 'utf8'), '#EXTM3U\n');
  assert.equal(fs.readFileSync(path.join(mediaDir, 'hls', videoId, 'segment_00000.ts'), 'utf8'), 'segment');
  assert.match(bunny.getHlsUrl(videoId), /\/nightbox\/hls\/[^/]+\/master\.m3u8$/);

  const seed = spawnSync(process.execPath, ['-e', `const db=require('./database');db.createVideo({id:'${videoId}',title:'Legacy video',status:'active',playbackStatus:'ready',watchUrl:'https://example.test/watch/${videoId}',embedUrl:'https://example.test/${videoId}.mp4'});db.createVideo({id:'${readyVideoId}',title:'Processed video',status:'active',playbackStatus:'ready',hlsUrl:'https://cdn.example.test/nightbox/hls/${readyVideoId}/master.m3u8',watchUrl:'https://example.test/watch/${readyVideoId}',embedUrl:'https://example.test/${readyVideoId}.mp4'})`], {
    cwd: __dirname, env, encoding: 'utf8',
  });
  assert.equal(seed.status, 0, seed.stderr);

  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: __dirname, env: { ...env, PORT: String(port) }, stdio: 'ignore',
  });
  try {
    const ready = await waitFor(port, 200, readyVideoId);
    assert.equal(ready.status, 200);
    assert.match(ready.body.video.hlsUrl, /\/master\.m3u8$/);
    assert.equal(ready.body.video.streamUrl, `https://cdn.example.test/nightbox/${readyVideoId}.mp4`);
    assert.match(ready.body.video.originHlsUrl, /\/nightbox\/hls\/[^/]+\/master\.m3u8$/);
    const processing = await waitFor(port, 202);
    assert.equal(processing.body.code, 'VIDEO_PROCESSING');
    const failed = await waitFor(port, 409);
    assert.equal(failed.body.code, 'VIDEO_PROCESSING_FAILED');
    assert.equal(fs.existsSync(sourcePath), true, 'local source was deleted');
    console.log('Local HLS path, ready metadata, processing gate, failure state, and source preservation passed.');
  } finally {
    child.kill();
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
});
