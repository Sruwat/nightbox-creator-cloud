const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const FFMPEG_BIN = process.env.FFMPEG_BIN || 'ffmpeg';
const MAX_CONCURRENT = Math.max(1, Number(process.env.TRANSCODE_CONCURRENCY || 1));
const TEMP_ROOT = process.env.HLS_TEMP_DIR || path.join(__dirname, 'temp');
let active = 0;
const urgentQueue = [];
const backgroundQueue = [];

function runFfmpeg(sourcePath, outputDir) {
  return new Promise((resolve, reject) => {
    const playlistPath = path.join(outputDir, 'master.m3u8');
    const segmentPattern = path.join(outputDir, 'segment_%05d.ts');
    const args = [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', sourcePath,
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
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      if (code === 0 && fs.existsSync(playlistPath)) return resolve();
      reject(new Error(stderr.trim().slice(-2000) || `ffmpeg exited with code ${code}`));
    });
  });
}

async function processOne(job) {
  await fs.promises.mkdir(TEMP_ROOT, { recursive: true });
  const outputDir = await fs.promises.mkdtemp(path.join(TEMP_ROOT, 'nightbox-hls-'));
  let sourcePath = job.sourcePath || null;
  try {
    if (!sourcePath && job.prepareSource) sourcePath = await job.prepareSource();
    if (!sourcePath) throw new Error('Transcode source is unavailable');
    await runFfmpeg(sourcePath, outputDir);
    await job.uploadHlsDirectory(job.videoId, outputDir);
    job.onReady(job.getHlsUrl(job.videoId));
  } catch (error) {
    job.onError(error);
  } finally {
    await fs.promises.rm(outputDir, { recursive: true, force: true });
    if (sourcePath && !job.preserveSource) await fs.promises.rm(sourcePath, { force: true });
  }
}

async function drain() {
  if (active >= MAX_CONCURRENT || (!urgentQueue.length && !backgroundQueue.length)) return;
  active += 1;
  const job = urgentQueue.shift() || backgroundQueue.shift();
  try { await processOne(job); } finally { active -= 1; void drain(); }
}

function enqueue(job) {
  (job.priority === 'background' ? backgroundQueue : urgentQueue).push(job);
  void drain();
}

module.exports = { enqueue };
