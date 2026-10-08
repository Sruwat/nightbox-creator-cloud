/**
 * Bunny Storage + CDN wrapper.
 * Stores original MP4 objects and serves them through the Pull Zone.
 */
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STORAGE_ZONE = process.env.BUNNY_STORAGE_ZONE;
const STORAGE_PASSWORD = process.env.BUNNY_STORAGE_PASSWORD;
const CDN_HOST = process.env.BUNNY_CDN_HOST;
const STORAGE_PREFIX = String(process.env.BUNNY_STORAGE_PREFIX || 'nightbox').replace(/^\/+|\/+$/g, '');
const STORAGE_DRIVER = String(process.env.VIDEO_STORAGE_DRIVER || 'bunny').toLowerCase();
const LOCAL_STORAGE_ROOT = path.resolve(process.env.VIDEO_STORAGE_ROOT || path.join(__dirname, 'media'));
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const MAX_VIDEO_BYTES = 4 * 1024 * 1024 * 1024;

const bunnyApi = axios.create({
  baseURL: 'https://storage.bunnycdn.com',
  headers: { AccessKey: STORAGE_PASSWORD, Accept: 'application/json' },
});

function objectPath(videoId) {
  return `${STORAGE_ZONE}/${STORAGE_PREFIX}/${videoId}.mp4`;
}

function localPath(videoId) {
  return path.join(LOCAL_STORAGE_ROOT, `${videoId}.mp4`);
}

async function withRetry(fn, retries = MAX_RETRIES, label = 'API call') {
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const transient = ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED'].includes(error.code) || error.response?.status >= 500;
      if (attempt < retries && transient) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * (2 ** (attempt - 1))));
      else { console.error(`[Bunny CDN] ${label} failed:`, error.response?.data || error.message); throw error; }
    }
  }
  throw new Error(`${label} failed`);
}

function createVideo(title) { return { guid: crypto.randomUUID(), title: title || 'NightBox video' }; }

function assertConfigured() {
  if (!CDN_HOST) throw new Error('Bunny CDN host is not configured');
  if (STORAGE_DRIVER !== 'local' && (!STORAGE_ZONE || !STORAGE_PASSWORD)) throw new Error('Bunny Storage/CDN is not configured');
}

async function uploadVideo(videoId, filePath) {
  assertConfigured();
  if (STORAGE_DRIVER === 'local') {
    const fileStats = fs.statSync(filePath);
    if (fileStats.size > MAX_VIDEO_BYTES) throw new Error('Video exceeds the 4GB upload limit');
    fs.mkdirSync(LOCAL_STORAGE_ROOT, { recursive: true });
    const target = localPath(videoId);
    const temporaryTarget = `${target}.uploading`;
    fs.copyFileSync(filePath, temporaryTarget);
    fs.renameSync(temporaryTarget, target);
    console.log(`[NightBox VPS storage] Uploaded ${videoId}`);
    return { guid: videoId, storageSize: fileStats.size };
  }
  return withRetry(async () => {
    const fileStats = fs.statSync(filePath);
    if (fileStats.size > MAX_VIDEO_BYTES) throw new Error('Video exceeds the 4GB upload limit');
    const response = await bunnyApi.put(`/${objectPath(videoId)}`, fs.createReadStream(filePath), {
      headers: { 'Content-Type': 'video/mp4', 'Content-Length': fileStats.size }, maxContentLength: Infinity, maxBodyLength: Infinity, timeout: 1800000,
    });
    console.log(`[Bunny CDN] Uploaded ${videoId}`);
    return response.data;
  }, MAX_RETRIES, 'uploadVideo');
}

async function uploadVideoFromUrl(videoId, url, tempDir) {
  const tempFilePath = path.join(tempDir, `${videoId}_temp.mp4`);
  try {
    const response = await axios({ method: 'GET', url, responseType: 'stream', timeout: 600000, maxContentLength: MAX_VIDEO_BYTES, maxBodyLength: MAX_VIDEO_BYTES, headers: { 'User-Agent': 'NightBox/1.0' } });
    const advertisedLength = Number(response.headers['content-length'] || 0);
    if (advertisedLength > MAX_VIDEO_BYTES) throw new Error('Remote video exceeds the 4GB upload limit');
    const writer = fs.createWriteStream(tempFilePath);
    let bytes = 0;
    response.data.on('data', (chunk) => { bytes += chunk.length; if (bytes > MAX_VIDEO_BYTES) response.data.destroy(new Error('Remote video exceeds the 4GB upload limit')); });
    response.data.pipe(writer);
    await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); response.data.on('error', reject); });
    if (fs.statSync(tempFilePath).size < 1000) throw new Error('Downloaded file too small');
    return await uploadVideo(videoId, tempFilePath);
  } finally { cleanupTempFile(tempFilePath); }
}

async function getVideo(videoId) {
  assertConfigured();
  if (STORAGE_DRIVER === 'local') {
    try {
      const stats = fs.statSync(localPath(videoId));
      return { guid: videoId, status: 4, storageSize: stats.size, dateUploaded: stats.birthtime.toISOString() };
    } catch (error) {
      if (error.code === 'ENOENT') throw error;
      throw error;
    }
  }
  return withRetry(async () => {
    const response = await bunnyApi.head(`/${objectPath(videoId)}`, { timeout: 15000 });
    return { guid: videoId, status: 4, storageSize: Number(response.headers['content-length'] || 0), dateUploaded: response.headers.date || null };
  }, MAX_RETRIES, 'getVideo');
}

async function deleteVideo(videoId) {
  assertConfigured();
  if (STORAGE_DRIVER === 'local') {
    try { fs.unlinkSync(localPath(videoId)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { success: true };
  }
  return withRetry(async () => (await bunnyApi.delete(`/${objectPath(videoId)}`, { timeout: 30000 })).data, MAX_RETRIES, 'deleteVideo');
}

function getDirectPlayUrl(videoId) { assertConfigured(); return `https://${CDN_HOST}/${STORAGE_PREFIX}/${videoId}.mp4`; }
function getEmbedUrl(videoId) { return getDirectPlayUrl(videoId); }
// Share links are public-facing URLs. Keep the API origin configurable for
// legacy deployments, but default new links to the main NightBox domain.
function getWatchUrl(videoId) {
  const publicWatchUrl = String(process.env.PUBLIC_WATCH_URL || process.env.DOMAIN_URL || 'https://nightbox.in').replace(/\/$/, '');
  return `${publicWatchUrl}/watch/${videoId}`;
}
function cleanupTempFile(filePath) { try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (error) { console.error('[Cleanup] Failed:', error.message); } }

module.exports = { createVideo, uploadVideo, uploadVideoFromUrl, getVideo, deleteVideo, getEmbedUrl, getDirectPlayUrl, getWatchUrl, cleanupTempFile, getLocalPath: (videoId) => STORAGE_DRIVER === 'local' ? localPath(videoId) : null, isLocalStorage: () => STORAGE_DRIVER === 'local' };
