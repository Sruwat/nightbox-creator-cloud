/* Resumable, non-destructive migration of local MP4/HLS media to DirectAdmin. */
const fs = require('fs');
const path = require('path');
const ftp = require('basic-ftp');

const root = path.resolve(process.env.VIDEO_STORAGE_ROOT || path.join(__dirname, 'media'));
const host = process.env.DIRECTADMIN_FTP_HOST;
const port = Number(process.env.DIRECTADMIN_FTP_PORT || 21);
const user = process.env.DIRECTADMIN_FTP_USERNAME;
const password = process.env.DIRECTADMIN_FTP_PASSWORD;
const logPath = process.env.DIRECTADMIN_MIGRATION_LOG || path.join(process.env.WORKER_TEMP_DIR || path.join(__dirname, 'temp'), 'directadmin-migration.jsonl');

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

async function main() {
  const files = filesToMigrate();
  const done = new Set();
  if (fs.existsSync(logPath)) {
    for (const line of fs.readFileSync(logPath, 'utf8').split(/\r?\n/)) {
      try { const entry = JSON.parse(line); if (entry.ok) done.add(entry.remote); } catch (_) {}
    }
  }
  const client = new ftp.Client(300000);
  client.ftp.verbose = false;
  await client.access({ host, port, user, password, secure: false, passive: true });
  let completed = 0;
  for (const item of files) {
    if (done.has(item.remote)) { completed += 1; continue; }
    const size = fs.statSync(item.local).size;
    try {
      let remoteSize = null;
      try { remoteSize = await client.size(remotePath(item.remote)); } catch (_) {}
      if (remoteSize !== size) await client.uploadFrom(item.local, remotePath(item.remote));
      const verified = await client.size(remotePath(item.remote));
      if (verified !== size) throw new Error(`size mismatch local=${size} remote=${verified}`);
      appendLog({ ok: true, remote: item.remote, size });
      completed += 1;
      if (completed % 10 === 0) console.log(`MIGRATION_PROGRESS ${completed}/${files.length}`);
    } catch (error) {
      appendLog({ ok: false, remote: item.remote, error: error.message });
      console.error(`MIGRATION_FAILED ${item.remote}: ${error.message}`);
    }
  }
  client.close();
  console.log(`MIGRATION_FINISHED ${completed}/${files.length}`);
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
