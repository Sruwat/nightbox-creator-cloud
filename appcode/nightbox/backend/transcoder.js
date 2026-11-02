const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const FFMPEG_BIN = process.env.FFMPEG_BIN || 'ffmpeg';
const MAX_CONCURRENT = Math.max(1, Number(process.env.TRANSCODE_CONCURRENCY || 1));
const TEMP_ROOT = process.env.HLS_TEMP_DIR || path.join(__dirname, 'temp');
let active = 0;
const queues = new Map();
const creatorOrder = [];
let cursor = 0;

function queueFor(creatorKey) {
  const key = String(creatorKey || 'unassigned');
  if (!queues.has(key)) {
    queues.set(key, { urgent: [], background: [] });
    creatorOrder.push(key);
  }
  return queues.get(key);
}

// Round-robin by creator prevents one creator's bulk upload from occupying
// every worker while preserving urgent jobs within each creator's turn.
function nextJob() {
  if (!creatorOrder.length) return null;
  for (let offset = 0; offset < creatorOrder.length; offset += 1) {
    const index = (cursor + offset) % creatorOrder.length;
    const key = creatorOrder[index];
    const bucket = queues.get(key);
    const job = bucket?.urgent.shift() || bucket?.background.shift();
    if (job) {
      cursor = (index + 1) % creatorOrder.length;
      return job;
    }
  }
  return null;
}

function pruneEmptyQueues() {
  for (let index = creatorOrder.length - 1; index >= 0; index -= 1) {
    const key = creatorOrder[index];
    const bucket = queues.get(key);
    if (bucket && !bucket.urgent.length && !bucket.background.length) {
      queues.delete(key);
      creatorOrder.splice(index, 1);
      if (cursor > index) cursor -= 1;
      if (cursor >= creatorOrder.length) cursor = 0;
    }
  }
}

function probeDuration(sourcePath) {
  return new Promise((resolve) => {
    const child = spawn(process.env.FFPROBE_BIN || 'ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', sourcePath,
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.on('close', () => resolve(Number(output.trim()) || 0));
    child.on('error', () => resolve(0));
  });
}

async function runFfmpeg(sourcePath, outputDir, onProgress) {
  const duration = await probeDuration(sourcePath);
  return new Promise((resolve, reject) => {
    const playlistPath = path.join(outputDir, 'master.m3u8');
    const segmentPattern = path.join(outputDir, 'segment_%05d.ts');
    const args = [
      '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:2', '-nostats', '-y', '-i', sourcePath,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
      '-c:v', 'libx264', '-preset', process.env.FFMPEG_PRESET || 'veryfast',
      '-profile:v', 'main', '-level:v', '4.0',
      '-crf', process.env.FFMPEG_CRF || '23', '-maxrate', process.env.FFMPEG_MAXRATE || '2200k',
      '-bufsize', process.env.FFMPEG_BUFSIZE || '4400k', '-pix_fmt', 'yuv420p',
      '-g', '120', '-keyint_min', '1', '-sc_threshold', '0',
      '-force_key_frames', 'expr:gte(t,n_forced*4)',
      '-c:a', 'aac', '-b:a', process.env.FFMPEG_AUDIO_BITRATE || '96k', '-ac', '2',
      '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod',
      '-hls_flags', 'independent_segments',
      '-hls_segment_filename', segmentPattern, playlistPath,
    ];
    const child = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (_) { /* Keep default priority if unsupported. */ }
    let stderr = '';
    let progressBuffer = '';
    child.stderr.on('data', (chunk) => {
      progressBuffer += chunk.toString();
      const lines = progressBuffer.split(/\r?\n/);
      progressBuffer = lines.pop() || '';
      for (const line of lines) {
        const match = line.match(/^out_time_ms=(\d+)/);
        if (match && duration && onProgress) {
          const ratio = Math.max(0, Math.min(1, Number(match[1]) / 1000000 / duration));
          void onProgress(Math.min(70, 30 + Math.round(ratio * 40)));
        } else if (line && !/^(frame|fps|bitrate|total_size|out_time|progress)=/.test(line)) {
          stderr += `${line}\n`;
        }
      }
    });
    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      if (code === 0 && fs.existsSync(playlistPath)) return resolve();
      reject(new Error(stderr.trim().slice(-2000) || `ffmpeg exited with code ${code}`));
    });
  });
}

async function processOne(job) {
  let outputDir = null;
  let sourcePath = job.sourcePath || null;
  try {
    await fs.promises.mkdir(TEMP_ROOT, { recursive: true });
    outputDir = await fs.promises.mkdtemp(path.join(TEMP_ROOT, 'nightbox-hls-'));
    if (!sourcePath && job.prepareSource) {
      if (job.onStage) await job.onStage('downloading', 5);
      sourcePath = await job.prepareSource();
    }
    if (!sourcePath) throw new Error('Transcode source is unavailable');
    if (job.onStage) await job.onStage('transcoding', 30);
    await runFfmpeg(sourcePath, outputDir, (progress) => job.onProgress?.(progress));
    if (job.onStage) await job.onStage('cdn_upload', 72);
    await job.uploadHlsDirectory(job.videoId, outputDir, (ratio) => job.onProgress?.(72 + Math.round(ratio * 18)));
    if (job.onStage) await job.onStage('cdn_verifying', 95);
    if (job.verifyHls) await job.verifyHls(job.videoId);
    if (job.onProgress) await job.onProgress(100);
    await job.onReady(job.getHlsUrl(job.videoId), outputDir);
  } catch (error) {
    await job.onError(error);
  } finally {
    if (outputDir) await fs.promises.rm(outputDir, { recursive: true, force: true });
    if (sourcePath && !job.preserveSource) await fs.promises.rm(sourcePath, { force: true });
  }
}

async function drain() {
  if (active >= MAX_CONCURRENT) return;
  const job = nextJob();
  if (!job) {
    pruneEmptyQueues();
    return;
  }
  active += 1;
  try { await processOne(job); } finally { active -= 1; void drain(); }
}

function enqueue(job) {
  const bucket = queueFor(job.creatorKey);
  (job.priority === 'background' ? bucket.background : bucket.urgent).push(job);
  void drain();
}

function promote(videoId) {
  for (const bucket of queues.values()) {
    const index = bucket.background.findIndex((job) => job.videoId === videoId);
    if (index >= 0) {
      bucket.urgent.push(...bucket.background.splice(index, 1));
      return;
    }
  }
}

module.exports = { enqueue, promote };
