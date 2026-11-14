/* Resumable, non-destructive migration of local MP4/HLS media to DirectAdmin. */
const fs = require('fs');
const path = require('path');
const ftp = require('basic-ftp');
const DatabaseSync = require('node:sqlite').DatabaseSync;

const root = path.resolve(process.env.VIDEO_STORAGE_ROOT || path.join(__dirname, 'media'));
const host = process.env.DIRECTADMIN_FTP_HOST;
const port = Number(process.env.DIRECTADMIN_FTP_PORT || 21);
const user = process.env.DIRECTADMIN_FTP_USERNAME;
const password = process.env.DIRECTADMIN_FTP_PASSWORD;
const logPath = process.env.DIRECTADMIN_MIGRATION_LOG || path.join(process.env.WORKER_TEMP_DIR || path.join(__dirname, 'temp'), 'directadmin-migration.jsonl');
const batchLimit = Math.max(0, Number.parseInt(process.env.DIRECTADMIN_MIGRATION_LIMIT || '0', 10) || 0);
const deleteVerified = process.env.DIRECTADMIN_MIGRATION_DELETE_VERIFIED === 'true';
const dbPath = process.env.NIGHTBOX_DB_PATH || path.join(__dirname, 'data', 'nightbox.sqlite');

if (!host || !user || !password) throw new Error('DirectAdmin FTP credentials are not configured');

function remotePath(relative) {
  const safe = relative.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!safe || safe.includes('..')) throw new Error(`Unsafe migration path: ${relative}`);
  return `/${safe}`;
}

function filesToMigrate() {
  const result = [];
  if (fs.existsSync(root)) {
    for (const name of fs.readdirSync(root)) {
      if (/^[a-f0-9-]{36}\.mp4$/i.test(name)) result.push({ local: path.join(root, name), remote: name });
    }
  }
  const hlsRoot = path.join(root, 'hls');
  if (fs.existsSync(hlsRoot)) {
    for (const videoId of fs.readdirSync(hlsRoot)) {
      const dir = path.join(hlsRoot, videoId);
      if (!fs.statSync(dir).isDirectory() || !/^[a-f0-9-]{36}$/i.test(videoId)) continue;
      for (const name of fs.readdirSync(dir)) {
        if (/\.(m3u8|ts|m4s)$/i.test(name)) result.push({ local: path.join(dir, name), remote: `hls/${videoId}/${name}` });
      }
    }
  }
  return result;
}

function appendLog(entry) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

function canDeleteSource(item, db) {
  // Only a source MP4 may be removed, and only after the database confirms
  // that HLS is complete, verified, and ready. HLS artifacts are retained.
  const match = /^([a-f0-9-]{36})\.mp4$/i.exec(item.remote);
  if (!match || !db) return false;
  const row = db.prepare(`SELECT status, processing_status, playback_status, cdn_verified_at
    FROM videos WHERE id=?`).get(match[1]);
  return Boolean(row && row.status !== 'deleted' &&
    row.processing_status === 'completed' &&
    row.playback_status === 'ready' && row.cdn_verified_at);
}

async function main() {
  const files = filesToMigrate();
  const done = new Set();
  if (fs.existsSync(logPath)) {
    for (const line of fs.readFileSync(logPath, 'utf8').split(/\r?\n/)) {
      try { const entry = JSON.parse(line); if (entry.ok) done.add(entry.remote); } catch (_) {}
    }
  }
  const pending = files.filter((item) => !done.has(item.remote));
  const batch = batchLimit > 0 ? pending.slice(0, batchLimit) : pending;
  console.log(`MIGRATION_BATCH ${batch.length}/${pending.length} pending (limit=${batchLimit || 'all'}, deleteVerified=${deleteVerified})`);
  const client = new ftp.Client(300000);
  client.ftp.verbose = false;
  let db = null;
  if (deleteVerified) {
    try { db = new DatabaseSync(dbPath); } catch (error) {
      console.error(`SAFE_DELETE_DISABLED ${error.message}`);
    }
  }
  await client.access({ host, port, user, password, secure: false, passive: true });
  let completed = 0;
  for (const item of batch) {
    const size = fs.statSync(item.local).size;
    try {
      let remoteSize = null;
      try { remoteSize = await client.size(remotePath(item.remote)); } catch (_) {}
      if (remoteSize !== size) await client.uploadFrom(item.local, remotePath(item.remote));
      const verified = await client.size(remotePath(item.remote));
      if (verified !== size) throw new Error(`size mismatch local=${size} remote=${verified}`);
      const safeToDelete = deleteVerified && canDeleteSource(item, db);
      if (safeToDelete) fs.unlinkSync(item.local);
      appendLog({ ok: true, deleted: safeToDelete, remote: item.remote, size });
      completed += 1;
      if (completed % 10 === 0) console.log(`MIGRATION_PROGRESS ${completed}/${batch.length}`);
    } catch (error) {
      appendLog({ ok: false, remote: item.remote, error: error.message });
      console.error(`MIGRATION_FAILED ${item.remote}: ${error.message}`);
    }
  }
  client.close();
  console.log(`MIGRATION_FINISHED ${completed}/${batch.length}`);
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
