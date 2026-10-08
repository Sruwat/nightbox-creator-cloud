/**
 * Video Streaming Backend Server
 * Express API with Bunny.net Stream integration
 *
 * Security & Performance features:
 * - Helmet for security headers
 * - Compression for response optimization
 * - Rate limiting on upload endpoints
 * - API key auth for destructive operations
 * - Input sanitization
 * - Graceful shutdown
 * - Request logging
 */

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bunny = require('./bunny');

const app = express();
const PORT = process.env.PORT || 3000;
const DOMAIN_URL = process.env.DOMAIN_URL || 'https://video.nightbox.in';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || crypto.randomBytes(32).toString('hex');

// Track active uploads for health monitoring
let activeUploads = 0;
const startTime = Date.now();

// ─────────────────────────────────────────────
// Security Middleware
// ─────────────────────────────────────────────

// Helmet for security headers (disable CSP for iframe embeds)
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

// Compression for performance
app.use(compression({
  threshold: 1024, // Only compress responses > 1KB
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  },
}));

// Request logging
app.use(morgan(':method :url :status :res[content-length] - :response-time ms'));

// CORS — restrict in production
const allowedOrigins = [
    'https://video.nightbox.in',
    'https://video.prernaupin.in', // Keep old domain for backward compatibility
    'http://localhost:3000',
];
app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin || allowedOrigins.includes(origin)) {
      cb(null, true);
    } else {
      cb(null, true); // Allow all for now since bots need it
    }
  },
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// HSTS Header
app.use((req, res, next) => {
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// ─────────────────────────────────────────────
// Rate Limiting
// ─────────────────────────────────────────────

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50,
  message: { error: 'Too many upload requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Too many requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply rate limiting to the correct routes
app.use('/upload-file', uploadLimiter);
app.use('/upload-from-url', uploadLimiter);
app.use('/video', apiLimiter);

// ─────────────────────────────────────────────
// Input Sanitization
// ─────────────────────────────────────────────

function sanitizeInput(str) {
  if (!str || typeof str !== 'string') return '';
  // Remove HTML tags
  str = str.replace(/<[^>]*>/g, '');
  // Remove dangerous characters
  str = str.replace(/[<>"';{}()\\]/g, '');
  // Limit length
  return str.trim().substring(0, 200);
}

// ─────────────────────────────────────────────
// Auth Middleware
// ─────────────────────────────────────────────

function requireApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.query.apiKey;
  if (!apiKey || apiKey !== ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized. API key required.' });
  }
  next();
}

// ─────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────

// Root Route - Serve landing page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Temp directory
const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// Multer config with file filter
const storage = multer.diskStorage({
  destination: TEMP_DIR,
  filename: (req, file, cb) => {
    // Sanitize original filename
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}_${safeName}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 2 * 1024 * 1024 * 1024, // 2GB max
    files: 1, // Only 1 file at a time
  },
  fileFilter: (req, file, cb) => {
    // Accept video MIME types + common extensions
    const allowedMimes = [
      'video/mp4', 'video/x-matroska', 'video/avi', 'video/webm',
      'video/x-flv', 'video/quicktime', 'video/x-ms-wmv',
      'video/3gpp', 'video/mpeg', 'application/octet-stream',
    ];
    if (allowedMimes.includes(file.mimetype) || file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      // Allow it anyway — Telegram sometimes sends wrong MIME
      cb(null, true);
    }
  },
});

// POST /upload-file
app.post('/upload-file', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video file provided' });

  const filePath = req.file.path;
  const fileSize = req.file.size;
  const rawTitle = req.body.title || req.file.originalname || `Video_${Date.now()}`;
  const title = sanitizeInput(rawTitle);

  // CRITICAL: Reject empty/tiny files BEFORE creating Bunny video slot
  if (!fileSize || fileSize === 0) {
    bunny.cleanupTempFile(filePath);
    return res.status(400).json({ error: 'Uploaded file is empty (0 bytes). Download likely failed.' });
  }
  
  // INCREASED: 300KB minimum for the server too
  if (fileSize < 300000) { 
    bunny.cleanupTempFile(filePath);
    return res.status(400).json({ error: `File too small (${fileSize} bytes). Not a valid video.` });
  }

  // SERVER-SIDE MAGIC BYTE CHECK
  try {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(16);
    fs.readSync(fd, buffer, 0, 16, 0);
    fs.closeSync(fd);

    const headerHex = buffer.toString('hex');
    const headerStr = buffer.toString('utf8').toLowerCase();

    // Check for HTML/JSON (Common error page signatures)
    if (headerStr.includes('<html') || headerStr.includes('<!doc') || headerStr.includes('{"err')) {
      bunny.cleanupTempFile(filePath);
      return res.status(400).json({ error: 'Security Block: Uploaded file is HTML/JSON (nonsense), not a video.' });
    }

    // Basic Video Signatures
    const isVideo = (
      headerHex.includes('66747970') || // ftyp (MP4)
      headerHex.startsWith('1a45dfa3') || // MKV/WebM
      headerHex.startsWith('464c56') || // FLV
      headerHex.startsWith('52494646') // AVI
    );

    if (!isVideo && fileSize < 5000000) { // If <5MB and no magic bytes, reject
      bunny.cleanupTempFile(filePath);
      return res.status(400).json({ error: 'Invalid file format. Please upload a valid video (MP4, MKV, etc.).' });
    }
  } catch (err) {
    console.error('[UploadGuard] Magic byte check failed:', err);
  }


  console.log(`Upload received: ${title} (${Math.round(fileSize / 1024 / 1024)}MB)`);

  activeUploads++;

  try {
    const videoData = await bunny.createVideo(title);
    const videoId = videoData.guid;
    await bunny.uploadVideo(videoId, filePath);

    // Log metadata for recovery purposes
    console.log(JSON.stringify({
      event: 'video_uploaded',
      videoId,
      title,
      size: req.file.size,
      timestamp: new Date().toISOString(),
    }));

    res.json({
      success: true,
      videoId,
      watchUrl: bunny.getWatchUrl(videoId),
      embedUrl: bunny.getEmbedUrl(videoId),
      message: 'Video uploaded. Processing may take a few minutes.',
    });
  } catch (error) {
    console.error('Upload error:', error.message);
    res.status(500).json({ error: error.message });
  } finally {
    activeUploads--;
    bunny.cleanupTempFile(filePath);
  }
});

// POST /upload-from-url
app.post('/upload-from-url', async (req, res) => {
  const { url, title: rawTitle } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });
  if (!/^https?:\/\/.+/i.test(url)) return res.status(400).json({ error: 'Invalid URL' });

  const title = sanitizeInput(rawTitle) || `Video_${Date.now()}`;

  activeUploads++;

  try {
    const videoData = await bunny.createVideo(title);
    const videoId = videoData.guid;
    await bunny.uploadVideoFromUrl(videoId, url, TEMP_DIR);
    res.json({
      success: true,
      videoId,
      watchUrl: bunny.getWatchUrl(videoId),
      embedUrl: bunny.getEmbedUrl(videoId),
      message: 'Video uploaded from URL. Processing may take a few minutes.',
    });
  } catch (error) {
    console.error('URL upload error:', error.message);
    res.status(500).json({ error: error.message });
  } finally {
    activeUploads--;
  }
});

// GET /video/:id
app.get('/video/:id', async (req, res) => {
  const videoId = req.params.id;
  if (!videoId || videoId.length < 10) return res.status(400).json({ error: 'Invalid video ID' });
  // Sanitize video ID — should only contain hex chars and dashes
  if (!/^[a-f0-9-]+$/i.test(videoId)) return res.status(400).json({ error: 'Invalid video ID format' });

  try {
    const v = await bunny.getVideo(videoId);
    res.json({
      success: true,
      video: {
        id: v.guid, title: v.title, status: v.status,
        duration: v.length, size: v.storageSize, views: v.views,
        dateUploaded: v.dateUploaded,
        thumbnailUrl: v.thumbnailFileName ? `https://${process.env.BUNNY_CDN_HOST}/${v.guid}/${v.thumbnailFileName}` : null,
        embedUrl: bunny.getEmbedUrl(videoId),
        hlsUrl: bunny.getDirectPlayUrl(videoId),
        watchUrl: bunny.getWatchUrl(videoId),
        downloadUrl: `${DOMAIN_URL}/download/${videoId}`,
      },
    });
  } catch (error) {
    res.status(404).json({ error: 'Video not found' });
  }
});

// DELETE /video/:id — requires API key
app.delete('/video/:id', requireApiKey, async (req, res) => {
  const videoId = req.params.id;
  if (!videoId || !/^[a-f0-9-]+$/i.test(videoId)) {
    return res.status(400).json({ error: 'Invalid video ID' });
  }

  try {
    await bunny.deleteVideo(videoId);
    res.json({ success: true, message: 'Deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /download/:id — proxy download from Bunny CDN
app.get('/download/:id', async (req, res) => {
  const videoId = req.params.id;
  if (!videoId || !/^[a-f0-9-]+$/i.test(videoId)) {
    return res.status(400).json({ error: 'Invalid video ID' });
  }

  const cdnHost = process.env.BUNNY_CDN_HOST;

  // Try multiple Bunny CDN URL formats in order of preference
  const urlsToTry = [
    `https://${cdnHost}/${videoId}/play_720p.mp4`,
    `https://${cdnHost}/${videoId}/play_480p.mp4`,
    `https://${cdnHost}/${videoId}/play_360p.mp4`,
    `https://${cdnHost}/${videoId}/original`,
  ];

  for (const url of urlsToTry) {
    try {
      console.log(`[Download] Trying: ${url}`);
      const response = await axios({
        method: 'GET',
        url: url,
        responseType: 'stream',
        timeout: 300000, // 5 min timeout
        headers: {
          'AccessKey': API_KEY,
          'Referer': DOMAIN_URL,
        },
      });

      // Get video title for filename
      let fileName = `${videoId}.mp4`;
      try {
        const videoData = await bunny.getVideo(videoId);
        if (videoData.title) {
          fileName = videoData.title.replace(/[^a-zA-Z0-9._-]/g, '_') + '.mp4';
        }
      } catch (_) {}

      // Set download headers
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      if (response.headers['content-length']) {
        res.setHeader('Content-Length', response.headers['content-length']);
      }

      // Pipe the video stream to the client
      response.data.pipe(res);
      response.data.on('error', (err) => {
        console.error('[Download] Stream error:', err.message);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Download stream error' });
        }
      });
      return; // Success — stop trying other URLs
    } catch (err) {
      console.log(`[Download] ${url} failed: ${err.response?.status || err.message}`);
      continue; // Try next URL format
    }
  }

  // All formats failed
  res.status(404).json({ error: 'Video download not available. MP4 fallback may not be enabled.' });
});

// GET /watch/:id — serve fallback HTML
app.get('/watch/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'watch.html'));
});

// Android App Links verification
app.get('/.well-known/assetlinks.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.json([{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app',
      package_name: 'simple.shayaribygenz',
      sha256_cert_fingerprints: [
        '03:2D:A4:3E:C7:99:BE:64:69:01:D5:30:6A:4D:67:8B:5A:25:3F:78:73:69:41:88:A2:C0:20:DC:7D:C1:F5:1A',
        '14:30:0C:9C:17:B1:0F:AF:A5:A0:50:4A:95:0C:04:F6:ED:C8:D7:3F:32:21:EE:5E:50:36:F6:7B:FD:8C:FF:34',
        'FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C'
      ],
    },
  }]);
});

// Static files with caching
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1d',
  etag: true,
  lastModified: true,
}));

app.get('/favicon.ico', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'logo.png'));
});

// Enhanced health check
app.get('/health', (req, res) => {
  const uptime = Math.floor((Date.now() - startTime) / 1000);
  const memUsage = process.memoryUsage();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
    activeUploads,
    memory: {
      rss: `${Math.round(memUsage.rss / 1024 / 1024)}MB`,
      heap: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
    },
  });
});

// Error handler
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large. Max 2GB.' });
    return res.status(400).json({ error: err.message });
  }

  console.error('Unhandled error:', err.message);

  if (req.accepts('html')) {
    return res.status(500).sendFile(path.join(__dirname, 'public', 'error.html'));
  }

  res.status(500).json({ error: 'Internal server error' });
});

// 404 fallback
app.use((req, res) => {
  if (req.accepts('html')) {
    return res.status(404).sendFile(path.join(__dirname, 'public', 'error.html'));
  }
  res.status(404).json({ error: 'Route not found' });
});

// ─────────────────────────────────────────────
// Server Start + Graceful Shutdown
// ─────────────────────────────────────────────

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Backend running on port ${PORT}`);
  console.log(`📡 Domain: ${DOMAIN_URL}`);
  console.log(`🎬 Bunny Library: ${process.env.BUNNY_LIBRARY_ID}`);
  console.log(`🔑 Admin API Key: ${ADMIN_API_KEY.substring(0, 8)}...`);
  console.log(`🛡️  Security: helmet + compression + rate limiting\n`);
});

// Graceful shutdown for PM2
function gracefulShutdown(signal) {
  console.log(`\n${signal} received. Shutting down gracefully...`);
  server.close(() => {
    console.log('HTTP server closed.');
    // Clean up temp files
    try {
      const tempFiles = fs.readdirSync(TEMP_DIR);
      tempFiles.forEach(file => {
        try { fs.unlinkSync(path.join(TEMP_DIR, file)); } catch (e) { /* ignore */ }
      });
      console.log(`Cleaned up ${tempFiles.length} temp files.`);
    } catch (e) { /* ignore */ }
    process.exit(0);
  });

  // Force close after 30 seconds
  setTimeout(() => {
    console.error('Forced shutdown after timeout.');
    process.exit(1);
  }, 30000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});
