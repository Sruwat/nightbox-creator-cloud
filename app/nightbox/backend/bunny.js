/**
 * Bunny.net Stream API Wrapper
 * Handles video creation, upload, retrieval, and deletion
 *
 * Features:
 * - Retry logic with exponential backoff
 * - Extended timeouts for large files
 * - Proper error classification
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BUNNY_API_BASE = 'https://video.bunnycdn.com';
const LIBRARY_ID = process.env.BUNNY_LIBRARY_ID;
const API_KEY = process.env.BUNNY_API_KEY;
const CDN_HOST = process.env.BUNNY_CDN_HOST;

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

// Axios instance with default headers
const bunnyApi = axios.create({
  baseURL: BUNNY_API_BASE,
  headers: {
    'AccessKey': API_KEY,
    'Accept': 'application/json',
  },
});

/**
 * Retry wrapper for API calls with exponential backoff
 */
async function withRetry(fn, retries = MAX_RETRIES, label = 'API call') {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const isTransient = error.code === 'ECONNRESET' ||
                          error.code === 'ETIMEDOUT' ||
                          error.code === 'ECONNABORTED' ||
                          error.response?.status >= 500;

      if (attempt < retries && isTransient) {
        const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        console.log(`[Bunny] ${label} failed (attempt ${attempt}/${retries}), retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw error;
      }
    }
  }
}

/**
 * Create a new video slot in the Bunny library
 */
async function createVideo(title) {
  return withRetry(async () => {
    try {
      const response = await bunnyApi.post(`/library/${LIBRARY_ID}/videos`, {
        title: title || `Video_${Date.now()}`,
      }, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000,
      });
      console.log(`[Bunny] Video created: ${response.data.guid}`);
      return response.data;
    } catch (error) {
      console.error('[Bunny] Error creating video:', error.response?.data || error.message);
      throw new Error('Failed to create video on Bunny.net');
    }
  }, MAX_RETRIES, 'createVideo');
}

/**
 * Upload a video file to Bunny by reading from local file path
 */
async function uploadVideo(videoId, filePath) {
  return withRetry(async () => {
    try {
      const fileStream = fs.createReadStream(filePath);
      const fileStats = fs.statSync(filePath);

      const response = await bunnyApi.put(
        `/library/${LIBRARY_ID}/videos/${videoId}`,
        fileStream,
        {
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': fileStats.size,
          },
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
          timeout: 1800000, // 30 min timeout for large files
        }
      );
      console.log(`[Bunny] Video uploaded: ${videoId} (${Math.round(fileStats.size / 1024 / 1024)}MB)`);
      return response.data;
    } catch (error) {
      console.error('[Bunny] Error uploading video:', error.response?.data || error.message);
      throw new Error('Failed to upload video to Bunny.net');
    }
  }, MAX_RETRIES, 'uploadVideo');
}

/**
 * Upload a video from a remote URL — downloads it first then uploads
 */
async function uploadVideoFromUrl(videoId, url, tempDir) {
  const tempFilePath = path.join(tempDir, `${videoId}_temp.mp4`);

  try {
    // Download the video from URL
    console.log(`[Bunny] Downloading video from URL: ${url}`);
    const downloadResponse = await axios({
      method: 'GET',
      url: url,
      responseType: 'stream',
      timeout: 600000, // 10 min timeout
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    // Save to temp file
    const writer = fs.createWriteStream(tempFilePath);
    downloadResponse.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    const fileSize = fs.statSync(tempFilePath).size;
    console.log(`[Bunny] Downloaded to: ${tempFilePath} (${Math.round(fileSize / 1024 / 1024)}MB)`);

    // Validate file size
    if (fileSize < 1000) {
      throw new Error('Downloaded file too small — likely not a video');
    }

    // Upload to Bunny
    const result = await uploadVideo(videoId, tempFilePath);
    return result;
  } catch (error) {
    console.error('[Bunny] Error uploading from URL:', error.message);
    throw new Error('Failed to upload video from URL');
  } finally {
    // Always clean up temp file
    cleanupTempFile(tempFilePath);
  }
}

/**
 * Get video metadata and status from Bunny
 */
async function getVideo(videoId) {
  return withRetry(async () => {
    try {
      const response = await bunnyApi.get(`/library/${LIBRARY_ID}/videos/${videoId}`, {
        timeout: 15000,
      });
      return response.data;
    } catch (error) {
      console.error('[Bunny] Error getting video:', error.response?.data || error.message);
      throw new Error('Failed to get video from Bunny.net');
    }
  }, MAX_RETRIES, 'getVideo');
}

/**
 * Delete a video from Bunny
 */
async function deleteVideo(videoId) {
  return withRetry(async () => {
    try {
      const response = await bunnyApi.delete(`/library/${LIBRARY_ID}/videos/${videoId}`, {
        timeout: 15000,
      });
      console.log(`[Bunny] Video deleted: ${videoId}`);
      return response.data;
    } catch (error) {
      console.error('[Bunny] Error deleting video:', error.response?.data || error.message);
      throw new Error('Failed to delete video from Bunny.net');
    }
  }, MAX_RETRIES, 'deleteVideo');
}

/**
 * Generate the iframe embed playback URL
 */
function getEmbedUrl(videoId) {
  return `https://iframe.mediadelivery.net/embed/${LIBRARY_ID}/${videoId}?autoplay=true&preload=true`;
}

/**
 * Generate the direct HLS playback URL (for native apps)
 */
function getDirectPlayUrl(videoId) {
  return `https://${CDN_HOST}/${videoId}/playlist.m3u8`;
}

/**
 * Generate the public watch link
 */
function getWatchUrl(videoId) {
  const domain = process.env.DOMAIN_URL || 'https://video.nightbox.in';
  return `${domain}/watch/${videoId}`;
}

/**
 * Clean up a temporary file
 */
function cleanupTempFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`[Cleanup] Deleted temp file: ${filePath}`);
    }
  } catch (err) {
    console.error(`[Cleanup] Failed to delete temp file: ${filePath}`, err.message);
  }
}

module.exports = {
  createVideo,
  uploadVideo,
  uploadVideoFromUrl,
  getVideo,
  deleteVideo,
  getEmbedUrl,
  getDirectPlayUrl,
  getWatchUrl,
  cleanupTempFile,
};
