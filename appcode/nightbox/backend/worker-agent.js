/**
 * NightBox distributed HLS worker.
 *
 * The primary backend remains the source of truth. This process only claims
 * leased jobs, downloads the authorized source, creates/uploads HLS, and
 * reports the result back to the coordinator.
 */
require('dotenv').config();
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const axios = require('axios');
const transcoder = require('./transcoder');

const COORDINATOR_URL = String(process.env.WORKER_COORDINATOR_URL || '').replace(/\/$/, '');
const WORKER_KEY = String(process.env.WORKER_SHARED_SECRET || '');
const WORKER_ID = String(process.env.WORKER_ID || `${os.hostname()}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
const CONCURRENCY = Math.max(1, Number(process.env.WORKER_CONCURRENCY || process.env.TRANSCODE_CONCURRENCY || 1));
const POLL_MS = Math.max(1000, Number(process.env.WORKER_POLL_MS || 3000));
const TEMP_ROOT = process.env.WORKER_TEMP_DIR || path.join(__dirname, 'temp', 'worker');
const activeJobs = new Set();
let stopping = false;

if (!COORDINATOR_URL || !WORKER_KEY) throw new Error('WORKER_COORDINATOR_URL and WORKER_SHARED_SECRET are required');
fs.mkdirSync(TEMP_ROOT, { recursive: true });

function metrics() {
  let diskRatio = 0;
  try {
    const stat = fs.statfsSync(TEMP_ROOT);
    diskRatio = stat.blocks ? 1 - (Number(stat.bavail) / Number(stat.blocks)) : 0;
  } catch (_) { /* load guard remains conservative on unsupported filesystems */ }
  return {
    workerId: WORKER_ID,
    concurrency: CONCURRENCY,
    activeJobs: activeJobs.size,
    cpuLoad: Math.min(1, os.loadavg()[0] / Math.max(1, os.cpus().length)),
    memoryRatio: 1 - (os.freemem() / Math.max(1, os.totalmem())),
    diskRatio,
  };
}

async function coordinator(method, route, body, extraHeaders = {}) {
  const response = await axios({
    method,
    url: `${COORDINATOR_URL}${route}`,
    data: body,
    timeout: 30000,
    validateStatus: () => true,
    headers: { 'X-Worker-Key': WORKER_KEY, 'Content-Type': 'application/json', ...extraHeaders },
  });
  if (response.status >= 400) throw new Error(`Coordinator ${route} returned ${response.status}`);
  return response;
}

function createHlsArchive(directory, archivePath) {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-czf', archivePath, '-C', directory, '.'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(stderr.trim() || `tar exited with code ${code}`)));
  });
}

async function sendHlsArchive(videoId, workerId, directory) {
  const archivePath = path.join(TEMP_ROOT, `${videoId}.tar.gz`);
  try {
    await createHlsArchive(directory, archivePath);
    const stream = fs.createReadStream(archivePath);
    const response = await axios.post(`${COORDINATOR_URL}/internal/workers/jobs/${encodeURIComponent(videoId)}/hls-archive`, stream, {
      timeout: 1_800_000,
      maxContentLength: 2 * 1024 * 1024 * 1024,
      maxBodyLength: 2 * 1024 * 1024 * 1024,
      headers: { 'X-Worker-Key': WORKER_KEY, 'X-Worker-Id': workerId, 'Content-Type': 'application/gzip', 'Content-Length': fs.statSync(archivePath).size },
    });
    if (response.status >= 400) throw new Error(`HLS handoff returned ${response.status}`);
  } finally {
    await fs.promises.rm(archivePath, { force: true }).catch(() => {});
  }
}

async function heartbeat() {
  try { await coordinator('POST', '/internal/workers/heartbeat', metrics()); } catch (error) {
    console.error('[Worker heartbeat]', error.message);
  }
}

async function downloadSource(job) {
  const target = path.join(TEMP_ROOT, `${job.videoId}.mp4`);
  const response = await axios.get(job.sourceUrl, { responseType: 'stream', timeout: 600000, maxContentLength: 2 * 1024 * 1024 * 1024, maxBodyLength: 2 * 1024 * 1024 * 1024 });
  const writer = fs.createWriteStream(target);
  response.data.pipe(writer);
  await new Promise((resolve, reject) => {
    writer.once('finish', resolve);
    writer.once('error', reject);
    response.data.once('error', reject);
  });
  return target;
}

async function runJob(job) {
  activeJobs.add(job.videoId);
  let sourcePath = null;
  const report = async (stage, progress) => {
    try { await coordinator('POST', `/internal/workers/jobs/${encodeURIComponent(job.videoId)}/progress`, { workerId: WORKER_ID, stage, progress }); } catch (error) {
      console.error(`[Worker ${job.videoId}] progress report:`, error.message);
    }
  };
  try {
    await report('downloading', 5);
    sourcePath = await downloadSource(job);
    await report('transcoding', 30);
    await new Promise((resolve) => transcoder.enqueue({
      videoId: job.videoId,
      creatorKey: job.ownerId || 'unassigned',
      sourcePath,
      preserveSource: false,
      // The Traffic VPS never receives Bunny credentials. HLS is handed back
      // to the primary after FFmpeg finishes, where Bunny upload/verification
      // is performed by the source-of-truth backend.
      uploadHlsDirectory: async () => {},
      getHlsUrl: () => null,
      verifyHls: async () => {},
      onStage: (stage, progress = 0) => { void report(stage, progress); },
      onProgress: (progress) => { void report('transcoding', progress); },
      onReady: async (_hlsUrl, outputDir) => {
        try {
          await report('completed', 100);
          await sendHlsArchive(job.videoId, WORKER_ID, outputDir);
        } catch (error) {
          await coordinator('POST', `/internal/workers/jobs/${encodeURIComponent(job.videoId)}/fail`, { workerId: WORKER_ID, error: String(error?.message || error) });
        } finally { resolve(); }
      },
      onError: async (error) => {
        try { await coordinator('POST', `/internal/workers/jobs/${encodeURIComponent(job.videoId)}/fail`, { workerId: WORKER_ID, error: String(error?.message || error) }); }
        finally { resolve(); }
      },
    }));
  } catch (error) {
    try { await coordinator('POST', `/internal/workers/jobs/${encodeURIComponent(job.videoId)}/fail`, { workerId: WORKER_ID, error: String(error?.message || error) }); } catch (reportError) { console.error('[Worker failure report]', reportError.message); }
  } finally {
    if (sourcePath) { try { fs.rmSync(sourcePath, { force: true }); } catch (_) { /* transcoder may already have removed it */ } }
    activeJobs.delete(job.videoId);
  }
}

async function claimAvailable() {
  while (!stopping && activeJobs.size < CONCURRENCY) {
    const response = await coordinator('POST', '/internal/workers/claim', metrics());
    if (response.status === 204 || !response.data?.job) return;
    void runJob(response.data.job);
  }
}

async function loop() {
  while (!stopping) {
    try { await claimAvailable(); } catch (error) { console.error('[Worker claim]', error.message); }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

setInterval(() => { void heartbeat(); }, 5000).unref();
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
console.log(`[NightBox worker] ${WORKER_ID} online; concurrency=${CONCURRENCY}; coordinator=${COORDINATOR_URL}`);
void heartbeat();
void loop();
