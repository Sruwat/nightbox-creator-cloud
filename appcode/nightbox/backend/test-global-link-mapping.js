const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightbox-global-link-'));
process.env.NIGHTBOX_DATA_DIR = dataDir;

const store = require('./database');

try {
  const creatorA = 'creator-a';
  const videoId = 'video-global-link-test';
  const createdAt = store.now();

  store.db.prepare(
    "INSERT INTO users (id,email,role,status,created_at) VALUES (?,?,?,?,?)",
  ).run(creatorA, 'creator-a@example.test', 'creator', 'active', createdAt);
  store.db.prepare(
    "INSERT INTO videos (id,owner_id,title,watch_url,embed_url,status,created_at) VALUES (?,?,?,?,?,?,?)",
  ).run(videoId, creatorA, 'Test video', 'https://watch.test/video', 'https://embed.test/video', 'active', createdAt);

  const original = store.createLink(videoId, creatorA);
  const firstGlobal = store.createGlobalLink(videoId);
  const secondGlobal = store.createGlobalLink(videoId);

  assert.equal(firstGlobal.slug, original.slug, 'global link should reuse the source canonical link');
  assert.equal(secondGlobal.slug, firstGlobal.slug, 'repeated global imports should be idempotent');
  assert.equal(
    store.db.prepare('SELECT COUNT(*) AS count FROM videos WHERE id = ?').get(videoId).count,
    1,
    'global import must not create another video row',
  );
  assert.equal(
    store.db.prepare('SELECT COUNT(*) AS count FROM creator_links WHERE video_id = ?').get(videoId).count,
    1,
    'global import must not create another link row',
  );
  console.log('global link mapping test: ok');
} finally {
  store.db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
