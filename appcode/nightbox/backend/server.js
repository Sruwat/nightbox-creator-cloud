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
const { OAuth2Client } = require('google-auth-library');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const axios = require('axios');
const bunny = require('./bunny');
const store = require('./database');

const app = express();
const googleAuthClient = new OAuth2Client();
app.set('trust proxy', process.env.TRUST_PROXY === 'true');
const PORT = process.env.PORT || 3000;
const DOMAIN_URL = process.env.DOMAIN_URL || 'https://video.nightbox.in';
const BUNNY_STORAGE_PASSWORD = process.env.BUNNY_STORAGE_PASSWORD;
const BUNNY_STORAGE_ZONE = process.env.BUNNY_STORAGE_ZONE;
const BUNNY_LOCAL_STORAGE = String(process.env.VIDEO_STORAGE_DRIVER || '').toLowerCase() === 'local';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || crypto.randomBytes(32).toString('hex');
const allowedOrigins = (process.env.WEB_ORIGINS || 'http://localhost:4173,http://localhost:4174').split(',').map((value) => value.trim()).filter(Boolean);

if (process.env.NODE_ENV === 'production') {
  for (const name of ['AUTH_SECRET', 'IP_HASH_SECRET', 'VIEW_HASH_SECRET', 'ADMIN_API_KEY']) {
    if (!process.env[name] || process.env[name].length < 32) throw new Error(`${name} must be configured with at least 32 characters in production`);
  }
}

function bearerUser(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  const user = store.verifyToken(header.slice(7));
  return user?.status === 'suspended' ? null : user;
}

function requireUser(req, res, next) {
  const user = bearerUser(req);
  if (!user) return res.status(401).json({ error: 'Authentication required' });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  const user = bearerUser(req);
  if (user?.role === 'admin') { req.user = user; return next(); }
  if ((req.headers['x-api-key'] || req.query.apiKey) === ADMIN_API_KEY) return next();
  return res.status(403).json({ error: 'Administrator access required' });
}

function apiKeyUser(req) {
  const value = String(req.headers['x-bot-key'] || req.headers['x-api-key'] || '');
  if (!value.startsWith('nb_live_')) return null;
  const keyHash = store.hash(`${value}|${process.env.AUTH_SECRET || 'local-development-secret-change-me'}`);
  const key = store.db.prepare('SELECT id,user_id FROM creator_api_keys WHERE key_hash=? AND revoked_at IS NULL').get(keyHash);
  if (!key) return null;
  store.db.prepare('UPDATE creator_api_keys SET last_used_at=? WHERE id=?').run(store.now(), key.id);
  const user = store.findUserById(key.user_id);
  return user?.status === 'suspended' ? null : user;
}

function uploadOwner(req) {
  return bearerUser(req) || apiKeyUser(req);
}

function requestIp(req) {
  return String(req.ip || req.socket.remoteAddress || '').trim();
}

function viewerCountry(req) {
  const header = process.env.TRUST_PROXY === 'true'
    ? req.headers['cf-ipcountry']
    : (process.env.NODE_ENV === 'production' ? null : req.headers['x-country-code']);
  return String(header || 'ZZ').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2) || 'ZZ';
}

async function viewerIsBlocked(req) {
  const ip = requestIp(req);
  const userAgent = String(req.headers['user-agent'] || '').toLowerCase();
  if (/\b(bot|crawler|spider|headless|curl|wget)\b/.test(userAgent)) return true;
  const blocked = new Set(String(process.env.BLOCKED_IP_HASHES || '').split(',').map((value) => value.trim()).filter(Boolean));
  const ipHash = store.hash(`${ip}|${process.env.IP_HASH_SECRET || process.env.AUTH_SECRET || 'change-me'}`);
  if (blocked.has(ipHash)) return true;
  if (!process.env.IPQUALITYSCORE_API_KEY) return process.env.NODE_ENV === 'production';
  if (!ip || ip === '::1' || ip === '127.0.0.1') return false;
  try {
    const response = await axios.get(`https://ipqualityscore.com/api/json/ip/${process.env.IPQUALITYSCORE_API_KEY}/${encodeURIComponent(ip)}`, { timeout: 2500 });
    return Boolean(response.data?.vpn || response.data?.proxy || response.data?.tor || response.data?.bot_status);
  } catch (error) {
    console.warn('IP reputation lookup unavailable:', error.message);
    return process.env.NODE_ENV === 'production' || process.env.BLOCK_ON_REPUTATION_FAILURE === 'true';
  }
}

async function validateRemoteUrl(value) {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Invalid remote URL');
  const addresses = await dns.lookup(parsed.hostname, { all: true });
  const isPrivate = (address) => {
    if (address === '::1' || address.startsWith('fc') || address.startsWith('fd') || address.startsWith('fe80')) return true;
    if (net.isIPv4(address)) return /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(address);
    if (net.isIPv6(address) && address.startsWith('::ffff:')) return isPrivate(address.slice(7));
    return false;
  };
  if (!addresses.length || addresses.some(({ address }) => isPrivate(address))) throw new Error('Remote URL resolves to a private network');
  return parsed.toString();
}

function fileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const digest = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => digest.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(digest.digest('hex')));
  });
}

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
app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin || allowedOrigins.includes(origin)) {
      cb(null, true);
    } else cb(new Error('Origin is not allowed'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Country-Code'],
}));

app.use('/api/webhooks/razorpay', express.raw({ type: 'application/json', limit: '1mb' }));
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

const viewLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  message: { error: 'Too many view requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

const downloadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Too many download requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many authentication attempts' },
  standardHeaders: true,
  legacyHeaders: false,
});

const subscriptionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Too many subscription requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply rate limiting to the correct routes
app.use('/upload-file', uploadLimiter);
app.use('/upload-from-url', uploadLimiter);
app.use('/video', apiLimiter);
app.use('/api/links', viewLimiter);
app.use('/api/views', viewLimiter);
app.use('/download', downloadLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/google', authLimiter);
app.use('/api/admin/login', authLimiter);
app.use('/api/subscriptions', subscriptionLimiter);

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

app.post('/api/auth/register', (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== 'string' || !/^\S+@\S+\.\S+$/.test(email) || typeof password !== 'string' || password.length < 10) {
    return res.status(400).json({ error: 'A valid email and password of at least 10 characters are required' });
  }
  try {
    const user = store.createUser(email, password);
    res.status(201).json({ user, token: store.signToken(user) });
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) return res.status(409).json({ error: 'Email already registered' });
    res.status(500).json({ error: 'Unable to create account' });
  }
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = typeof email === 'string' ? store.findUser(email) : null;
  if (!user || typeof password !== 'string' || !store.verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  if (user.status === 'suspended') return res.status(403).json({ error: 'This account is suspended' });
  res.json({ user: { id: user.id, email: user.email, role: user.role }, token: store.signToken(user) });
});

app.post('/api/auth/google', async (req, res) => {
  const clientId = String(process.env.GOOGLE_CLIENT_ID || '').trim();
  const credential = req.body?.credential;
  if (!clientId) return res.status(503).json({ error: 'Google sign-in is not configured on the server' });
  if (typeof credential !== 'string' || credential.length > 12000) {
    return res.status(400).json({ error: 'A valid Google credential is required' });
  }

  try {
    const ticket = await googleAuthClient.verifyIdToken({ idToken: credential, audience: clientId });
    const claims = ticket.getPayload();
    if (!claims?.sub || !claims.email || (claims.email_verified !== true && claims.email_verified !== 'true')) {
      return res.status(401).json({ error: 'Google did not return a verified email identity' });
    }

    const user = store.linkGoogleUser(claims.email, claims.sub);
    if (user.role !== 'creator') return res.status(403).json({ error: 'Google sign-in is only available for creator accounts' });
    if (user.status === 'suspended') return res.status(403).json({ error: 'This account is suspended' });
    return res.json({ user: { id: user.id, email: user.email, role: user.role }, token: store.signToken(user) });
  } catch (error) {
    if (String(error.message).includes('already linked')) {
      return res.status(409).json({ error: 'This email is already linked to a different Google account' });
    }
    return res.status(401).json({ error: 'Google sign-in could not be verified' });
  }
});

app.post('/api/admin/login', (req, res) => {
  const { email, password } = req.body || {};
  const configuredEmail = process.env.ADMIN_EMAIL;
  const configuredPassword = process.env.ADMIN_PASSWORD;
  if (!configuredEmail || !configuredPassword) return res.status(503).json({ error: 'Admin credentials are not configured on the server' });
  if (email !== configuredEmail || password !== configuredPassword) return res.status(401).json({ error: 'Invalid administrator credentials' });
  let admin = store.findUser(configuredEmail);
  if (!admin) admin = store.createUser(configuredEmail, configuredPassword, 'admin');
  if (admin.role !== 'admin') return res.status(403).json({ error: 'Account is not an administrator' });
  res.json({ user: { id: admin.id, email: admin.email, role: admin.role }, token: store.signToken(admin) });
});

app.get('/api/me', requireUser, (req, res) => res.json({ user: store.findUserById(req.user.id) }));
app.post('/api/account/password', requireUser, (req, res) => {
  const currentPassword = String(req.body?.currentPassword || '');
  const newPassword = String(req.body?.newPassword || '');
  const user = store.findUserById(req.user.id);
  const stored = store.findUser(user.email);
  if (!stored || !store.verifyPassword(currentPassword, stored.password_hash)) return res.status(400).json({ error: 'Current password is incorrect' });
  if (newPassword.length < 10) return res.status(400).json({ error: 'New password must be at least 10 characters' });
  store.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(store.hashPassword(newPassword), req.user.id);
  res.json({ updated: true });
});

app.get('/api/creator/api-keys', requireUser, (req, res) => res.json({ keys: store.db.prepare('SELECT id,key_prefix AS prefix,created_at AS createdAt,last_used_at AS lastUsedAt,revoked_at AS revokedAt FROM creator_api_keys WHERE user_id=? ORDER BY created_at DESC').all(req.user.id) }));
app.get('/api/creator/bot-identity', (req, res) => {
  const user = apiKeyUser(req);
  if (!user) return res.status(401).json({ error: 'Valid creator bot key is required' });
  res.json({ user: { id: user.id, email: user.email } });
});
// Attach an existing NightBox video to the authenticated creator without
// downloading or duplicating the underlying video. The new creator link is
// the ownership boundary used by the view/earning pipeline.
app.post('/api/creator/import-link', (req, res) => {
  const user = apiKeyUser(req);
  if (!user) return res.status(401).json({ error: 'Valid creator bot key is required' });
  const rawUrl = String(req.body?.url || '').trim();
  let slug = rawUrl;
  try {
    if (/^https?:\/\//i.test(rawUrl)) slug = new URL(rawUrl).pathname.split('/').filter(Boolean).pop() || '';
  } catch { slug = ''; }
  if (!/^[A-Za-z0-9_-]{4,100}$/.test(slug)) return res.status(400).json({ error: 'Invalid NightBox link' });
  const source = store.db.prepare('SELECT l.id,l.video_id AS videoId,v.title,v.watch_url AS watchUrl,v.embed_url AS embedUrl FROM creator_links l JOIN videos v ON v.id=l.video_id WHERE l.slug=? AND v.status <> \'deleted\'').get(slug);
  if (!source) return res.status(404).json({ error: 'NightBox link not found' });
  const existing = store.db.prepare('SELECT id,slug FROM creator_links WHERE video_id=? AND creator_id=? LIMIT 1').get(source.videoId, user.id);
  const link = existing || store.createLink(source.videoId, user.id);
  if (req.headers['x-bot-key']) store.db.prepare('INSERT INTO bot_events (id,user_id,bot_name,event_type,external_id,video_id,status,created_at) VALUES (?,?,?,?,?,?,?,?)').run(store.id(), user.id, String(req.headers['x-bot-name'] || 'nightbox-import').slice(0, 40), 'link_import', String(req.headers['x-bot-external-id'] || '').slice(0, 120) || null, source.videoId, existing ? 'duplicate' : 'created', store.now());
  res.status(existing ? 200 : 201).json({ success: true, videoId: source.videoId, title: source.title, watchUrl: source.watchUrl, embedUrl: source.embedUrl, link: `${DOMAIN_URL}/l/${link.slug}`, duplicate: Boolean(existing) });
});
app.post('/api/creator/api-keys', requireUser, (req, res) => {
  const raw = `nb_live_${crypto.randomBytes(24).toString('base64url')}`;
  const keyHash = store.hash(`${raw}|${process.env.AUTH_SECRET || 'local-development-secret-change-me'}`);
  const record = { id: store.id(), prefix: raw.slice(0, 16), createdAt: store.now() };
  store.db.prepare('INSERT INTO creator_api_keys (id,user_id,key_hash,key_prefix,created_at) VALUES (?,?,?,?,?)').run(record.id, req.user.id, keyHash, record.prefix, record.createdAt);
  res.status(201).json({ key: { ...record, value: raw } });
});
app.delete('/api/creator/api-keys/:id', requireUser, (req, res) => {
  const result = store.db.prepare('UPDATE creator_api_keys SET revoked_at=? WHERE id=? AND user_id=? AND revoked_at IS NULL').run(store.now(), req.params.id, req.user.id);
  if (!result.changes) return res.status(404).json({ error: 'API key not found' });
  res.json({ revoked: true });
});
app.get('/api/creator/bot-events', requireUser, (req, res) => res.json({ events: store.db.prepare('SELECT id,bot_name AS botName,event_type AS eventType,external_id AS externalId,video_id AS videoId,status,error,created_at AS createdAt FROM bot_events WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(req.user.id) }));
app.get('/api/creator/tickets', requireUser, (req, res) => res.json({ tickets: store.db.prepare('SELECT id,subject,message,status,admin_note AS adminNote,created_at AS createdAt,updated_at AS updatedAt FROM support_tickets WHERE user_id=? ORDER BY created_at DESC').all(req.user.id) }));
app.post('/api/creator/tickets', requireUser, (req, res) => {
  const subject = sanitizeInput(req.body?.subject);
  const message = sanitizeInput(req.body?.message);
  if (!subject || !message) return res.status(400).json({ error: 'Subject and message are required' });
  const ticket = { id: store.id(), userId: req.user.id, subject, message, createdAt: store.now() };
  store.db.prepare('INSERT INTO support_tickets (id,user_id,subject,message,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(ticket.id, ticket.userId, ticket.subject, ticket.message, ticket.createdAt, ticket.createdAt);
  res.status(201).json({ ticket: { ...ticket, status: 'open', adminNote: null, updatedAt: ticket.createdAt } });
});
app.get('/api/events', (req, res) => res.json({ events: store.db.prepare("SELECT id,title,description,starts_at AS startsAt,ends_at AS endsAt,reward_note AS rewardNote FROM platform_events WHERE active=1 ORDER BY starts_at ASC,created_at DESC").all() }));
app.post('/api/contact', apiLimiter, (req, res) => {
  const name = sanitizeInput(req.body?.name);
  const email = String(req.body?.email || '').trim().toLowerCase();
  const subject = sanitizeInput(req.body?.subject);
  const message = sanitizeInput(req.body?.message);
  if (!name || !/^\S+@\S+\.\S+$/.test(email) || !subject || !message) return res.status(400).json({ error: 'Name, valid email, subject, and message are required' });
  const timestamp = store.now();
  store.db.prepare('INSERT INTO contact_messages (id,name,email,subject,message,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(store.id(), name, email, subject, message, timestamp, timestamp);
  res.status(201).json({ received: true });
});
app.post('/api/dmca-reports', apiLimiter, (req, res) => {
  const name = sanitizeInput(req.body?.name);
  const email = String(req.body?.email || '').trim().toLowerCase();
  const reason = sanitizeInput(req.body?.reason);
  const videoUrl = sanitizeInput(req.body?.videoUrl);
  if (!name || !/^\S+@\S+\.\S+$/.test(email) || !reason) return res.status(400).json({ error: 'Name, valid email, and report reason are required' });
  const timestamp = store.now();
  store.db.prepare('INSERT INTO dmca_reports (id,reporter_name,reporter_email,video_url,reason,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(store.id(), name, email, videoUrl || null, reason, timestamp, timestamp);
  res.status(201).json({ received: true });
});

app.get('/api/plans', (req, res) => {
  res.json({ plans: store.db.prepare('SELECT id,name,price_minor,currency,duration_days,video_ads_removed,all_ads_removed,recurring FROM subscription_plans WHERE active = 1 ORDER BY price_minor').all() });
});

app.get('/api/feed', (req, res) => {
  const requestedLimit = Number(req.query.limit || 20);
  const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 50) : 20;
  const videos = store.db.prepare(`SELECT v.id,v.title,v.embed_url AS embedUrl,v.watch_url AS watchUrl,MIN(l.slug) AS slug,v.created_at AS createdAt FROM videos v LEFT JOIN creator_links l ON l.video_id=v.id WHERE v.status <> 'deleted' GROUP BY v.id ORDER BY v.created_at DESC LIMIT ${limit}`).all();
  res.json({ videos });
});

function razorpayConfigured() {
  return process.env.PAYMENT_PROVIDER === 'razorpay' && process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET;
}

function razorpayAuth() {
  return { username: process.env.RAZORPAY_KEY_ID, password: process.env.RAZORPAY_KEY_SECRET };
}

function signatureMatches(payload, signature, secret) {
  if (!payload || !signature || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return expected.length === String(signature).length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signature)));
}

function activateSubscription(subscriptionId, paymentId, rawEvent) {
  const subscription = store.db.prepare(`SELECT s.*, p.duration_days, p.recurring FROM subscriptions s JOIN subscription_plans p ON p.id = s.plan_id WHERE s.id = ?`).get(subscriptionId);
  if (!subscription) throw new Error('Subscription not found');
  // A client retry or a repeated provider notification must not grant the same payment twice.
  const previousPayment = paymentId
    ? store.db.prepare('SELECT status FROM payments WHERE provider_payment_id=? AND subscription_id=?').get(String(paymentId), subscriptionId)
    : null;
  if (subscription.status === 'active' && previousPayment?.status === 'paid') {
    return store.db.prepare(`SELECT s.id,s.plan_id,s.status,s.started_at AS startedAt,s.expires_at AS expiresAt,s.renews_at AS renewsAt,p.video_ads_removed AS videoAdsRemoved,p.all_ads_removed AS allAdsRemoved FROM subscriptions s JOIN subscription_plans p ON p.id=s.plan_id WHERE s.id=?`).get(subscriptionId);
  }
  const startedAt = subscription.started_at || store.now();
  const currentExpiry = subscription.expires_at ? Date.parse(subscription.expires_at) : 0;
  const baseTime = Math.max(Date.now(), Number.isFinite(currentExpiry) ? currentExpiry : 0);
  const expiresAt = new Date(baseTime + subscription.duration_days * 86400000).toISOString();
  store.db.exec('BEGIN');
  try {
    store.db.prepare('UPDATE subscriptions SET status = ?, started_at = COALESCE(started_at, ?), expires_at = ?, renews_at = ? WHERE id = ?').run('active', startedAt, expiresAt, subscription.recurring ? expiresAt : null, subscriptionId);
    if (paymentId) {
      store.db.prepare(`UPDATE payments SET status = 'paid', subscription_id = COALESCE(subscription_id, ?), raw_event = ?, updated_at = ? WHERE provider_payment_id = ?`).run(subscriptionId, rawEvent || null, store.now(), paymentId);
    }
    store.db.exec('COMMIT');
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
  return store.db.prepare(`SELECT s.id,s.plan_id,s.status,s.started_at AS startedAt,s.expires_at AS expiresAt,s.renews_at AS renewsAt,p.video_ads_removed AS videoAdsRemoved,p.all_ads_removed AS allAdsRemoved FROM subscriptions s JOIN subscription_plans p ON p.id=s.plan_id WHERE s.id=?`).get(subscriptionId);
}

function upsertProviderPayment(subscriptionId, paymentId, entity, status, rawEvent) {
  if (!subscriptionId || !paymentId) return;
  const subscription = store.db.prepare('SELECT s.user_id,p.price_minor,p.currency FROM subscriptions s JOIN subscription_plans p ON p.id=s.plan_id WHERE s.id=?').get(subscriptionId);
  if (!subscription) return;
  const existing = store.db.prepare('SELECT id FROM payments WHERE provider_payment_id=?').get(String(paymentId));
  const amount = Number(entity?.amount || subscription.price_minor);
  const currency = String(entity?.currency || subscription.currency || 'INR');
  const timestamp = store.now();
  if (existing) {
    store.db.prepare('UPDATE payments SET subscription_id=COALESCE(subscription_id,?),status=?,amount_minor=?,currency=?,raw_event=?,updated_at=? WHERE id=?').run(subscriptionId, status, amount, currency, rawEvent || null, timestamp, existing.id);
    return;
  }
  store.db.prepare('INSERT INTO payments (id,user_id,subscription_id,provider,provider_payment_id,amount_minor,currency,status,raw_event,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(store.id(), subscription.user_id, subscriptionId, 'razorpay', String(paymentId), amount, currency, status, rawEvent || null, timestamp, timestamp);
}

app.get('/api/me/subscription', requireUser, (req, res) => {
  store.db.prepare("UPDATE subscriptions SET status='expired' WHERE user_id=? AND status='active' AND expires_at IS NOT NULL AND expires_at <= ?").run(req.user.id, store.now());
  const subscription = store.db.prepare(`SELECT s.id,s.plan_id,s.status,s.started_at AS startedAt,s.expires_at AS expiresAt,s.renews_at AS renewsAt,s.cancelled_at AS cancelledAt,p.name,p.video_ads_removed AS videoAdsRemoved,p.all_ads_removed AS allAdsRemoved,p.recurring FROM subscriptions s JOIN subscription_plans p ON p.id=s.plan_id WHERE s.user_id=? AND s.status IN ('pending','active','cancelled') ORDER BY s.created_at DESC LIMIT 1`).get(req.user.id);
  res.json({ subscription: subscription || null });
});

app.post('/api/subscriptions/:id/cancel', requireUser, async (req, res) => {
  const subscription = store.db.prepare('SELECT * FROM subscriptions WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!subscription) return res.status(404).json({ error: 'Subscription not found' });
  if (!['pending', 'active'].includes(subscription.status)) return res.status(409).json({ error: `Subscription is already ${subscription.status}` });
  try {
    if (subscription.provider_subscription_id && razorpayConfigured()) {
      await axios.post(`https://api.razorpay.com/v1/subscriptions/${encodeURIComponent(subscription.provider_subscription_id)}/cancel`, { cancel_at_cycle_end: 1 }, { auth: razorpayAuth() });
    }
    const cancelledAt = store.now();
    store.db.prepare("UPDATE subscriptions SET status='cancelled',cancelled_at=?,renews_at=NULL WHERE id=? AND user_id=?").run(cancelledAt, subscription.id, req.user.id);
    res.json({ subscription: store.db.prepare(`SELECT s.id,s.plan_id,s.status,s.started_at AS startedAt,s.expires_at AS expiresAt,s.renews_at AS renewsAt,s.cancelled_at AS cancelledAt,p.name,p.video_ads_removed AS videoAdsRemoved,p.all_ads_removed AS allAdsRemoved,p.recurring FROM subscriptions s JOIN subscription_plans p ON p.id=s.plan_id WHERE s.id=?`).get(subscription.id) });
  } catch (error) {
    console.error('Subscription cancellation failed:', error.response?.data || error.message);
    res.status(502).json({ error: 'Unable to cancel subscription with payment provider' });
  }
});

app.get('/api/creator/videos', requireUser, (req, res) => {
  const videos = store.db.prepare(`
    SELECT v.id, v.title, v.status, v.file_size AS fileSize, v.watch_url AS watchUrl, v.embed_url AS embedUrl, v.created_at AS createdAt,
      (SELECT MIN(l.slug) FROM creator_links l WHERE l.video_id = v.id AND l.creator_id = ?) AS linkSlug,
      COALESCE((SELECT COUNT(*) FROM view_sessions s JOIN creator_links l ON l.id = s.link_id WHERE l.video_id = v.id AND l.creator_id = ? AND s.counted = 1), 0) AS eligibleViews
      ,COALESCE((SELECT SUM(e.amount_micros) FROM earnings e JOIN creator_links l2 ON l2.id = e.link_id WHERE l2.video_id = v.id AND l2.creator_id = ?), 0) AS earningsMicros
    FROM videos v WHERE v.owner_id = ? OR EXISTS (SELECT 1 FROM creator_links own_link WHERE own_link.video_id = v.id AND own_link.creator_id = ?) ORDER BY v.created_at DESC
  `).all(req.user.id, req.user.id, req.user.id, req.user.id, req.user.id);
  res.json({ videos: videos.map((video) => ({ ...video, link: video.linkSlug ? `${DOMAIN_URL}/l/${video.linkSlug}` : null })) });
});

app.delete('/api/creator/videos/:id', requireUser, (req, res) => {
  const video = store.db.prepare('SELECT id FROM videos WHERE id = ? AND owner_id = ?').get(req.params.id, req.user.id);
  if (!video) return res.status(404).json({ error: 'Video not found' });
  store.db.prepare('DELETE FROM videos WHERE id = ? AND owner_id = ?').run(req.params.id, req.user.id);
  res.json({ deleted: true });
});

app.post('/api/creator/videos/:id/link', requireUser, (req, res) => {
  const video = store.db.prepare('SELECT id FROM videos WHERE id = ? AND owner_id = ?').get(req.params.id, req.user.id);
  if (!video) return res.status(404).json({ error: 'Video not found' });
  const link = store.createLink(video.id, req.user.id);
  res.status(201).json({ link: { ...link, url: `${DOMAIN_URL}/l/${link.slug}` } });
});

app.get('/api/links/:slug', (req, res) => {
  const link = store.db.prepare(`SELECT l.id, l.slug, v.id AS videoId, v.title, v.embed_url AS embedUrl, v.watch_url AS watchUrl FROM creator_links l JOIN videos v ON v.id = l.video_id WHERE l.slug = ?`).get(req.params.slug);
  if (!link) return res.status(404).json({ error: 'Link not found' });
  res.json({ link });
});

app.post('/api/links/:slug/view/start', async (req, res) => {
  const link = store.db.prepare('SELECT id FROM creator_links WHERE slug = ?').get(req.params.slug);
  if (!link) return res.status(404).json({ error: 'Link not found' });
  if (await viewerIsBlocked(req)) return res.status(403).json({ error: 'Viewer did not pass traffic quality checks' });
  const ip = requestIp(req);
  const userAgent = req.headers['user-agent'] || '';
  const viewerHash = store.hash(`${ip}|${userAgent}|${process.env.VIEW_HASH_SECRET || process.env.AUTH_SECRET || 'change-me'}`);
  const ipHash = store.hash(`${ip}|${process.env.IP_HASH_SECRET || process.env.AUTH_SECRET || 'change-me'}`);
  const viewer = bearerUser(req);
  const viewToken = crypto.randomBytes(32).toString('base64url');
  const session = { id: store.id(), linkId: link.id, viewerUserId: viewer?.id || null, viewerHash, ipHash, viewTokenHash: store.hash(`${viewToken}|${process.env.VIEW_HASH_SECRET || process.env.AUTH_SECRET || 'change-me'}`), country: viewerCountry(req) };
  store.db.prepare('INSERT INTO view_sessions (id,link_id,viewer_user_id,viewer_hash,ip_hash,view_token_hash,country,started_at) VALUES (?,?,?,?,?,?,?,?)').run(session.id, session.linkId, session.viewerUserId, session.viewerHash, session.ipHash, session.viewTokenHash, session.country, store.now());
  res.status(201).json({ sessionId: session.id, viewToken, minimumWatchSeconds: store.db.prepare('SELECT minimum_watch_seconds AS seconds FROM view_rules WHERE id = 1').get().seconds });
});

app.post('/api/views/:id/qualify', (req, res) => {
  const session = store.db.prepare('SELECT * FROM view_sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'View session not found' });
  const viewToken = String(req.body?.viewToken || req.headers['x-view-token'] || '');
  if (!viewToken || !session.view_token_hash || !crypto.timingSafeEqual(Buffer.from(session.view_token_hash), Buffer.from(store.hash(`${viewToken}|${process.env.VIEW_HASH_SECRET || process.env.AUTH_SECRET || 'change-me'}`)))) return res.status(403).json({ error: 'View authorization failed' });
  if (session.counted) return res.json({ counted: true, duplicate: false });
  const rules = store.db.prepare('SELECT * FROM view_rules WHERE id = 1').get();
  const elapsed = (Date.now() - Date.parse(session.started_at)) / 1000;
  if (elapsed < rules.minimum_watch_seconds) return res.status(400).json({ error: `Watch at least ${rules.minimum_watch_seconds} seconds` });
  const recent = store.db.prepare("SELECT COUNT(*) AS count FROM view_sessions WHERE link_id = ? AND viewer_hash = ? AND started_at >= datetime('now', '-24 hours') AND counted = 1").get(session.link_id, session.viewer_hash);
  if (recent.count >= rules.max_views_per_viewer_24h) {
    store.db.prepare('UPDATE view_sessions SET qualified_at = ?, counted = 0 WHERE id = ?').run(store.now(), session.id);
    return res.json({ counted: false, duplicate: true });
  }
  const bucket = parseInt(store.hash(session.id).slice(0, 8), 16) % 100;
  if (bucket >= rules.eligible_percent) {
    store.db.prepare('UPDATE view_sessions SET qualified_at = ?, counted = 0 WHERE id = ?').run(store.now(), session.id);
    return res.json({ counted: false, filtered: true });
  }
  const link = store.db.prepare('SELECT creator_id FROM creator_links WHERE id = ?').get(session.link_id);
  const rate = store.db.prepare('SELECT cpm_cents FROM cpm_rates WHERE country = ?').get(session.country) || store.db.prepare("SELECT cpm_cents FROM cpm_rates WHERE country = 'ZZ'").get();
  const cpmCents = rate?.cpm_cents || 0;
  const amountMicros = cpmCents * 10;
  store.db.exec('BEGIN');
  try {
    store.db.prepare('UPDATE view_sessions SET qualified_at = ?, counted = 1 WHERE id = ?').run(store.now(), session.id);
    if (amountMicros > 0) store.db.prepare('INSERT INTO earnings (id,creator_id,link_id,view_id,country,cpm_cents,amount_micros,created_at) VALUES (?,?,?,?,?,?,?,?)').run(store.id(), link.creator_id, session.link_id, session.id, session.country, cpmCents, amountMicros, store.now());
    store.db.exec('COMMIT');
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
  res.json({ counted: true, country: session.country, cpmCents, amountMicros });
});

app.get('/api/creator/analytics', requireUser, (req, res) => {
  const summary = store.db.prepare(`SELECT COUNT(s.id) AS views, COALESCE(SUM(e.amount_micros),0) AS earningsMicros FROM view_sessions s JOIN creator_links l ON l.id=s.link_id LEFT JOIN earnings e ON e.view_id=s.id WHERE l.creator_id = ? AND s.counted = 1`).get(req.user.id);
  const countries = store.db.prepare(`SELECT s.country, COUNT(s.id) AS views, COALESCE(SUM(e.amount_micros),0) AS earningsMicros, COALESCE(MAX(e.cpm_cents),0) AS cpmCents FROM view_sessions s JOIN creator_links l ON l.id=s.link_id LEFT JOIN earnings e ON e.view_id=s.id WHERE l.creator_id = ? AND s.counted = 1 GROUP BY s.country ORDER BY views DESC`).all(req.user.id);
  res.json({ summary, countries });
});

function creatorBalance(creatorId) {
  const earned = store.db.prepare('SELECT COALESCE(SUM(amount_micros),0) AS amount FROM earnings WHERE creator_id=?').get(creatorId).amount;
  const reserved = store.db.prepare("SELECT COALESCE(SUM(amount_micros),0) AS amount FROM withdrawal_requests WHERE creator_id=? AND status IN ('pending','approved','paid')").get(creatorId).amount;
  return Math.max(0, earned - reserved);
}

app.get('/api/creator/withdrawals', requireUser, (req, res) => {
  const balanceMicros = creatorBalance(req.user.id);
  const withdrawals = store.db.prepare('SELECT id,amount_micros AS amountMicros,currency,method,status,note,requested_at AS requestedAt,reviewed_at AS reviewedAt,paid_at AS paidAt FROM withdrawal_requests WHERE creator_id=? ORDER BY requested_at DESC').all(req.user.id);
  res.json({ balanceMicros, minimumMicros: Number(process.env.MIN_WITHDRAWAL_USD_MICROS || 10000000), withdrawals });
});
app.post('/api/creator/withdrawals', requireUser, (req, res) => {
  const amountMicros = Number(req.body?.amountMicros);
  const method = sanitizeInput(req.body?.method);
  const minimumMicros = Number(process.env.MIN_WITHDRAWAL_USD_MICROS || 10000000);
  if (!Number.isSafeInteger(amountMicros) || amountMicros < minimumMicros || !method) return res.status(400).json({ error: 'A valid amount above the configured minimum and payout method are required' });
  const balanceMicros = creatorBalance(req.user.id);
  if (amountMicros > balanceMicros) return res.status(409).json({ error: 'Withdrawal exceeds the available creator balance', balanceMicros });
  const request = { id: store.id(), creatorId: req.user.id, amountMicros, method, requestedAt: store.now() };
  store.db.prepare('INSERT INTO withdrawal_requests (id,creator_id,amount_micros,method,status,requested_at) VALUES (?,?,?,?,?,?)').run(request.id, request.creatorId, request.amountMicros, request.method, 'pending', request.requestedAt);
  res.status(201).json({ withdrawal: { id: request.id, amountMicros, method, status: 'pending', requestedAt: request.requestedAt }, balanceMicros: creatorBalance(req.user.id) });
});

app.get('/api/admin/cpm', requireAdmin, (req, res) => res.json({ rates: store.db.prepare('SELECT country,cpm_cents AS cpmCents,updated_at AS updatedAt FROM cpm_rates ORDER BY country').all() }));
app.put('/api/admin/cpm/:country', requireAdmin, (req, res) => {
  const country = String(req.params.country).toUpperCase();
  const cpmCents = Number(req.body?.cpmCents);
  if (!/^[A-Z]{2}$/.test(country) || !Number.isInteger(cpmCents) || cpmCents < 0) return res.status(400).json({ error: 'Country must be ISO-3166 alpha-2 and CPM must be a non-negative integer in cents' });
  store.db.prepare('INSERT INTO cpm_rates(country,cpm_cents,updated_at) VALUES(?,?,?) ON CONFLICT(country) DO UPDATE SET cpm_cents=excluded.cpm_cents,updated_at=excluded.updated_at').run(country, cpmCents, store.now());
  res.json({ country, cpmCents });
});
app.get('/api/admin/view-rules', requireAdmin, (req, res) => res.json({ rules: store.db.prepare('SELECT eligible_percent AS eligiblePercent,max_views_per_viewer_24h AS maxViewsPerViewer24h,minimum_watch_seconds AS minimumWatchSeconds FROM view_rules WHERE id = 1').get() }));
app.put('/api/admin/view-rules', requireAdmin, (req, res) => {
  const eligiblePercent = Number(req.body?.eligiblePercent);
  const maxViews = Number(req.body?.maxViewsPerViewer24h);
  const minimum = Number(req.body?.minimumWatchSeconds);
  if (![eligiblePercent, maxViews, minimum].every(Number.isInteger) || eligiblePercent < 0 || eligiblePercent > 100 || maxViews < 1 || minimum < 5) return res.status(400).json({ error: 'Invalid view rules; minimum watch time must be at least 5 seconds' });
  store.db.prepare('UPDATE view_rules SET eligible_percent=?,max_views_per_viewer_24h=?,minimum_watch_seconds=?,updated_at=? WHERE id=1').run(eligiblePercent, maxViews, minimum, store.now());
  res.json({ eligiblePercent, maxViewsPerViewer24h: maxViews, minimumWatchSeconds: minimum });
});
app.get('/api/admin/users', requireAdmin, (req, res) => res.json({ users: store.db.prepare('SELECT id,email,role,status,telegram_user_id AS telegramUserId,created_at AS createdAt FROM users ORDER BY created_at DESC').all() }));
app.put('/api/admin/users/:id', requireAdmin, (req, res) => {
  const status = String(req.body?.status || '');
  if (!['active', 'suspended'].includes(status)) return res.status(400).json({ error: 'Invalid user status' });
  const result = store.db.prepare("UPDATE users SET status=? WHERE id=? AND role='creator'").run(status, req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Creator not found' });
  res.json({ user: store.db.prepare('SELECT id,email,role,status,telegram_user_id AS telegramUserId,created_at AS createdAt FROM users WHERE id=?').get(req.params.id) });
});
app.get('/api/admin/videos', requireAdmin, (req, res) => res.json({ videos: store.db.prepare(`SELECT v.id,v.title,v.status,v.owner_id AS ownerId,v.created_at AS createdAt,COALESCE(SUM(CASE WHEN s.counted = 1 THEN 1 ELSE 0 END),0) AS eligibleViews FROM videos v LEFT JOIN creator_links l ON l.video_id = v.id LEFT JOIN view_sessions s ON s.link_id = l.id GROUP BY v.id ORDER BY v.created_at DESC`).all() }));
app.get('/api/admin/overview', requireAdmin, (req, res) => {
  const users = store.db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='creator'").get().count;
  const videos = store.db.prepare('SELECT COUNT(*) AS count FROM videos').get().count;
  const qualifiedViews = store.db.prepare('SELECT COUNT(*) AS count FROM view_sessions WHERE counted=1').get().count;
  const earningsMicros = store.db.prepare('SELECT COALESCE(SUM(amount_micros),0) AS amount FROM earnings').get().amount;
  const pendingWithdrawals = store.db.prepare("SELECT COUNT(*) AS count FROM withdrawal_requests WHERE status='pending'").get().count;
  res.json({ users, videos, qualifiedViews, earningsMicros, pendingWithdrawals });
});
app.get('/api/admin/views', requireAdmin, (req, res) => {
  const requestedLimit = Number(req.query.limit || 100);
  const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 500) : 100;
  const views = store.db.prepare(`
    SELECT s.id, v.title, u.email AS creatorEmail, s.country, s.counted,
      s.started_at AS startedAt, s.qualified_at AS qualifiedAt,
      COALESCE(e.cpm_cents, 0) AS cpmCents,
      COALESCE(e.amount_micros, 0) AS amountMicros
    FROM view_sessions s
    JOIN creator_links l ON l.id = s.link_id
    JOIN videos v ON v.id = l.video_id
    JOIN users u ON u.id = l.creator_id
    LEFT JOIN earnings e ON e.view_id = s.id
    ORDER BY s.started_at DESC
    LIMIT ${limit}
  `).all();
  res.json({ views });
});
app.put('/api/admin/views/:id', requireAdmin, (req, res) => {
  const counted = req.body?.counted === true || req.body?.counted === 1 || req.body?.counted === '1';
  const session = store.db.prepare('SELECT * FROM view_sessions WHERE id=?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'View session not found' });
  const rules = store.db.prepare('SELECT minimum_watch_seconds AS minimumWatchSeconds FROM view_rules WHERE id=1').get();
  const elapsed = (Date.now() - Date.parse(session.started_at)) / 1000;
  if (counted && elapsed < rules.minimumWatchSeconds) return res.status(400).json({ error: `View must reach ${rules.minimumWatchSeconds} seconds before approval` });
  const timestamp = store.now();
  store.db.exec('BEGIN');
  try {
    if (!counted) {
      store.db.prepare('DELETE FROM earnings WHERE view_id=?').run(session.id);
      store.db.prepare('UPDATE view_sessions SET counted=0,qualified_at=COALESCE(qualified_at,?) WHERE id=?').run(timestamp, session.id);
    } else {
      const link = store.db.prepare('SELECT creator_id FROM creator_links WHERE id=?').get(session.link_id);
      const rate = store.db.prepare('SELECT cpm_cents FROM cpm_rates WHERE country=?').get(session.country)
        || store.db.prepare("SELECT cpm_cents FROM cpm_rates WHERE country='ZZ'").get();
      const cpmCents = rate?.cpm_cents || 0;
      const amountMicros = cpmCents * 10;
      store.db.prepare('UPDATE view_sessions SET counted=1,qualified_at=COALESCE(qualified_at,?) WHERE id=?').run(timestamp, session.id);
      if (amountMicros > 0) {
        store.db.prepare('INSERT OR REPLACE INTO earnings (id,creator_id,link_id,view_id,country,cpm_cents,amount_micros,created_at) VALUES (?,?,?,?,?,?,?,COALESCE((SELECT created_at FROM earnings WHERE view_id=?),?))').run(store.id(), link.creator_id, session.link_id, session.id, session.country, cpmCents, amountMicros, session.id, timestamp);
      }
    }
    store.db.exec('COMMIT');
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
  res.json({ counted });
});
app.delete('/api/admin/videos/:id', requireAdmin, async (req, res) => {
  if (!/^[a-f0-9-]+$/i.test(req.params.id)) return res.status(400).json({ error: 'Invalid video ID' });
  try {
    await bunny.deleteVideo(req.params.id);
    store.db.prepare('DELETE FROM videos WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (error) { res.status(502).json({ error: 'Unable to delete video from storage' }); }
});
app.get('/api/admin/subscriptions', requireAdmin, (req, res) => res.json({ subscriptions: store.db.prepare('SELECT * FROM subscriptions ORDER BY created_at DESC').all() }));
app.get('/api/admin/payments', requireAdmin, (req, res) => res.json({ payments: store.db.prepare('SELECT * FROM payments ORDER BY created_at DESC').all() }));
app.post('/api/admin/subscriptions/:id/cancel', requireAdmin, async (req, res) => {
  const subscription = store.db.prepare('SELECT * FROM subscriptions WHERE id=?').get(req.params.id);
  if (!subscription) return res.status(404).json({ error: 'Subscription not found' });
  if (!['pending', 'active'].includes(subscription.status)) return res.status(409).json({ error: `Subscription is already ${subscription.status}` });
  try {
    if (subscription.provider_subscription_id) {
      if (!razorpayConfigured()) return res.status(503).json({ error: 'Razorpay is not configured on the server' });
      await axios.post(`https://api.razorpay.com/v1/subscriptions/${encodeURIComponent(subscription.provider_subscription_id)}/cancel`, { cancel_at_cycle_end: 1 }, { auth: razorpayAuth() });
    }
    const cancelledAt = store.now();
    store.db.prepare("UPDATE subscriptions SET status='cancelled',cancelled_at=?,renews_at=NULL WHERE id=?").run(cancelledAt, subscription.id);
    res.json({ cancelled: true, subscriptionId: subscription.id });
  } catch (error) {
    console.error('Admin subscription cancellation failed:', error.response?.data || error.message);
    res.status(502).json({ error: 'Unable to cancel subscription with payment provider' });
  }
});
app.post('/api/admin/payments/:id/refund', requireAdmin, async (req, res) => {
  const payment = store.db.prepare('SELECT * FROM payments WHERE id=?').get(req.params.id);
  if (!payment) return res.status(404).json({ error: 'Payment not found' });
  if (payment.status !== 'paid') return res.status(409).json({ error: `Payment is ${payment.status}, not refundable` });
  if (payment.provider !== 'razorpay' || !payment.provider_payment_id || !razorpayConfigured()) return res.status(503).json({ error: 'Razorpay refund is not configured for this payment' });
  try {
    await axios.post(`https://api.razorpay.com/v1/payments/${encodeURIComponent(payment.provider_payment_id)}/refund`, {}, { auth: razorpayAuth() });
    const timestamp = store.now();
    store.db.prepare("UPDATE payments SET status='refunded',updated_at=? WHERE id=?").run(timestamp, payment.id);
    if (payment.subscription_id) store.db.prepare("UPDATE subscriptions SET status='refunded',renews_at=NULL WHERE id=? AND status IN ('pending','active','cancelled')").run(payment.subscription_id);
    res.json({ refunded: true, paymentId: payment.id });
  } catch (error) {
    console.error('Admin payment refund failed:', error.response?.data || error.message);
    res.status(502).json({ error: 'Unable to refund payment with provider' });
  }
});
app.get('/api/admin/plans', requireAdmin, (req, res) => res.json({ plans: store.db.prepare('SELECT id,name,price_minor AS priceMinor,currency,duration_days AS durationDays,video_ads_removed AS videoAdsRemoved,all_ads_removed AS allAdsRemoved,recurring,active FROM subscription_plans ORDER BY price_minor').all() }));
app.put('/api/admin/plans/:id', requireAdmin, (req, res) => {
  const priceMinor = Number(req.body?.priceMinor);
  const active = Number(req.body?.active);
  if (!Number.isSafeInteger(priceMinor) || priceMinor < 0 || ![0, 1].includes(active)) return res.status(400).json({ error: 'Invalid plan price or active state' });
  const result = store.db.prepare('UPDATE subscription_plans SET price_minor=?,active=? WHERE id=?').run(priceMinor, active, req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Plan not found' });
  res.json({ plan: store.db.prepare('SELECT id,name,price_minor AS priceMinor,currency,duration_days AS durationDays,video_ads_removed AS videoAdsRemoved,all_ads_removed AS allAdsRemoved,recurring,active FROM subscription_plans WHERE id=?').get(req.params.id) });
});
app.get('/api/admin/withdrawals', requireAdmin, (req, res) => res.json({ withdrawals: store.db.prepare('SELECT w.id,w.creator_id AS creatorId,u.email,w.amount_micros AS amountMicros,w.currency,w.method,w.status,w.note,w.requested_at AS requestedAt,w.reviewed_at AS reviewedAt,w.paid_at AS paidAt FROM withdrawal_requests w JOIN users u ON u.id=w.creator_id ORDER BY w.requested_at DESC').all() }));
app.get('/api/admin/tickets', requireAdmin, (req, res) => res.json({ tickets: store.db.prepare('SELECT t.id,t.user_id AS userId,u.email,t.subject,t.message,t.status,t.admin_note AS adminNote,t.created_at AS createdAt,t.updated_at AS updatedAt FROM support_tickets t JOIN users u ON u.id=t.user_id ORDER BY t.created_at DESC').all() }));
app.put('/api/admin/tickets/:id', requireAdmin, (req, res) => {
  const status = String(req.body?.status || '');
  if (!['open', 'in_progress', 'resolved', 'closed'].includes(status)) return res.status(400).json({ error: 'Invalid ticket status' });
  const result = store.db.prepare('UPDATE support_tickets SET status=?,admin_note=?,updated_at=? WHERE id=?').run(status, sanitizeInput(req.body?.adminNote), store.now(), req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Ticket not found' });
  res.json({ updated: true });
});
app.get('/api/admin/reports', requireAdmin, (req, res) => res.json({ reports: store.db.prepare('SELECT id,reporter_name AS reporterName,reporter_email AS reporterEmail,video_id AS videoId,video_url AS videoUrl,reason,status,admin_note AS adminNote,created_at AS createdAt,updated_at AS updatedAt FROM dmca_reports ORDER BY created_at DESC').all() }));
app.put('/api/admin/reports/:id', requireAdmin, (req, res) => {
  const status = String(req.body?.status || '');
  if (!['open', 'in_review', 'resolved', 'rejected'].includes(status)) return res.status(400).json({ error: 'Invalid report status' });
  const result = store.db.prepare('UPDATE dmca_reports SET status=?,admin_note=?,updated_at=? WHERE id=?').run(status, sanitizeInput(req.body?.adminNote), store.now(), req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Report not found' });
  res.json({ updated: true });
});
app.get('/api/admin/contact', requireAdmin, (req, res) => res.json({ messages: store.db.prepare('SELECT id,name,email,subject,message,status,created_at AS createdAt,updated_at AS updatedAt FROM contact_messages ORDER BY created_at DESC').all() }));
app.put('/api/admin/contact/:id', requireAdmin, (req, res) => {
  const status = String(req.body?.status || '');
  if (!['open', 'in_progress', 'resolved', 'closed'].includes(status)) return res.status(400).json({ error: 'Invalid contact status' });
  const result = store.db.prepare('UPDATE contact_messages SET status=?,updated_at=? WHERE id=?').run(status, store.now(), req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Contact message not found' });
  res.json({ updated: true });
});
app.get('/api/admin/events', requireAdmin, (req, res) => res.json({ events: store.db.prepare('SELECT id,title,description,starts_at AS startsAt,ends_at AS endsAt,reward_note AS rewardNote,active,created_at AS createdAt,updated_at AS updatedAt FROM platform_events ORDER BY created_at DESC').all() }));
app.post('/api/admin/events', requireAdmin, (req, res) => {
  const title = sanitizeInput(req.body?.title);
  const description = sanitizeInput(req.body?.description);
  if (!title || !description) return res.status(400).json({ error: 'Event title and description are required' });
  const timestamp = store.now();
  const id = store.id();
  store.db.prepare('INSERT INTO platform_events (id,title,description,starts_at,ends_at,reward_note,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run(id, title, description, req.body?.startsAt || null, req.body?.endsAt || null, sanitizeInput(req.body?.rewardNote), Number(req.body?.active) === 0 ? 0 : 1, timestamp, timestamp);
  res.status(201).json({ event: store.db.prepare('SELECT id,title,description,starts_at AS startsAt,ends_at AS endsAt,reward_note AS rewardNote,active FROM platform_events WHERE id=?').get(id) });
});
app.put('/api/admin/events/:id', requireAdmin, (req, res) => {
  const active = Number(req.body?.active);
  if (![0, 1].includes(active)) return res.status(400).json({ error: 'Invalid event active state' });
  const result = store.db.prepare('UPDATE platform_events SET active=?,updated_at=? WHERE id=?').run(active, store.now(), req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Event not found' });
  res.json({ updated: true });
});
app.get('/api/admin/settings', requireAdmin, (req, res) => res.json({ settings: { environment: process.env.NODE_ENV || 'development', domain: DOMAIN_URL, paymentProvider: process.env.PAYMENT_PROVIDER || 'not configured', bunnyConfigured: Boolean(process.env.BUNNY_CDN_HOST && (BUNNY_LOCAL_STORAGE || (process.env.BUNNY_STORAGE_PASSWORD && process.env.BUNNY_STORAGE_ZONE))), reputationChecksConfigured: Boolean(process.env.IPQUALITYSCORE_API_KEY), recurringPlansConfigured: Boolean(process.env.RAZORPAY_PLAN_MONTHLY && process.env.RAZORPAY_PLAN_PRIORITY) } }));
app.put('/api/admin/withdrawals/:id', requireAdmin, (req, res) => {
  const status = String(req.body?.status || '');
  if (!['approved', 'paid', 'rejected'].includes(status)) return res.status(400).json({ error: 'Invalid withdrawal status' });
  const current = store.db.prepare('SELECT status FROM withdrawal_requests WHERE id=?').get(req.params.id);
  if (!current) return res.status(404).json({ error: 'Withdrawal not found' });
  const allowed = { pending: ['approved', 'rejected'], approved: ['paid', 'rejected'], paid: [], rejected: [] };
  if (!allowed[current.status].includes(status)) return res.status(409).json({ error: `Cannot move withdrawal from ${current.status} to ${status}` });
  const timestamp = store.now();
  store.db.prepare('UPDATE withdrawal_requests SET status=?,note=?,reviewed_at=COALESCE(reviewed_at,?),paid_at=? WHERE id=?').run(status, sanitizeInput(req.body?.note), timestamp, status === 'paid' ? timestamp : null, req.params.id);
  res.json({ withdrawal: store.db.prepare('SELECT id,amount_micros AS amountMicros,currency,method,status,note,requested_at AS requestedAt,reviewed_at AS reviewedAt,paid_at AS paidAt FROM withdrawal_requests WHERE id=?').get(req.params.id) });
});
app.post('/api/subscriptions/checkout', requireUser, async (req, res) => {
  const plan = store.db.prepare('SELECT * FROM subscription_plans WHERE id = ? AND active = 1').get(String(req.body?.planId || ''));
  if (!plan) return res.status(404).json({ error: 'Subscription plan not found' });
  if (!razorpayConfigured()) return res.status(503).json({ error: 'Razorpay is not configured on the server' });
  const providerPlanId = plan.recurring ? process.env[`RAZORPAY_PLAN_${plan.id.toUpperCase().replace('-', '_')}`] : null;
  if (plan.recurring && !providerPlanId) return res.status(503).json({ error: `Razorpay recurring plan is not configured for ${plan.id}` });
  try {
    const subscriptionId = store.id();
    store.db.prepare('INSERT INTO subscriptions (id,user_id,plan_id,status,created_at) VALUES (?,?,?,?,?)').run(subscriptionId, req.user.id, plan.id, 'pending', store.now());
    if (plan.recurring) {
      const response = await axios.post('https://api.razorpay.com/v1/subscriptions', { plan_id: providerPlanId, total_count: 120, customer_notify: 1, notes: { nightboxSubscriptionId: subscriptionId, userId: req.user.id } }, { auth: razorpayAuth() });
      store.db.prepare('UPDATE subscriptions SET provider_subscription_id=? WHERE id=?').run(response.data.id, subscriptionId);
      return res.status(201).json({ mode: 'subscription', subscriptionId, provider: response.data, keyId: process.env.RAZORPAY_KEY_ID });
    }
    const response = await axios.post('https://api.razorpay.com/v1/orders', { amount: plan.price_minor, currency: plan.currency, receipt: subscriptionId, notes: { nightboxSubscriptionId: subscriptionId, userId: req.user.id } }, { auth: razorpayAuth() });
    store.db.prepare('INSERT INTO payments (id,user_id,subscription_id,provider,provider_payment_id,amount_minor,currency,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(store.id(), req.user.id, subscriptionId, 'razorpay', response.data.id, plan.price_minor, plan.currency, 'created', store.now(), store.now());
    res.status(201).json({ mode: 'order', subscriptionId, order: response.data, keyId: process.env.RAZORPAY_KEY_ID });
  } catch (error) {
    console.error('Razorpay checkout failed:', error.response?.data || error.message);
    res.status(502).json({ error: 'Unable to create payment with Razorpay' });
  }
});

app.post('/api/subscriptions/verify', requireUser, (req, res) => {
  const { subscriptionId, razorpayOrderId, razorpaySubscriptionId, razorpayPaymentId, razorpaySignature } = req.body || {};
  const subscription = store.db.prepare('SELECT * FROM subscriptions WHERE id=? AND user_id=?').get(subscriptionId, req.user.id);
  if (!subscription) return res.status(400).json({ error: 'Subscription not found' });
  if (razorpaySubscriptionId) {
    const valid = subscription.provider_subscription_id === razorpaySubscriptionId && signatureMatches(`${razorpayPaymentId}|${razorpaySubscriptionId}`, razorpaySignature, process.env.RAZORPAY_KEY_SECRET);
    if (!valid) return res.status(400).json({ error: 'Subscription payment verification failed' });
    res.json({ subscription: activateSubscription(subscriptionId, razorpayPaymentId, JSON.stringify(req.body)) });
    return;
  }
  const payment = store.db.prepare('SELECT * FROM payments WHERE provider_payment_id = ? AND user_id = ?').get(razorpayOrderId, req.user.id);
  if (!payment || payment.subscription_id !== subscriptionId || !signatureMatches(`${razorpayOrderId}|${razorpayPaymentId}`, razorpaySignature, process.env.RAZORPAY_KEY_SECRET)) return res.status(400).json({ error: 'Payment verification failed' });
  store.db.prepare('UPDATE payments SET provider_payment_id=?, updated_at=? WHERE id=?').run(razorpayPaymentId, store.now(), payment.id);
  res.json({ subscription: activateSubscription(subscriptionId, razorpayPaymentId, JSON.stringify(req.body)) });
});

app.post('/api/webhooks/razorpay', (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
  if (!signatureMatches(raw, req.headers['x-razorpay-signature'], process.env.RAZORPAY_WEBHOOK_SECRET)) return res.status(400).json({ error: 'Invalid webhook signature' });
  let event; try { event = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).json({ error: 'Invalid webhook payload' }); }
  const eventId = String(req.headers['x-razorpay-event-id'] || event.id || crypto.createHash('sha256').update(raw).digest('hex'));
  if (eventId) {
    const inserted = store.db.prepare('INSERT OR IGNORE INTO provider_events (id,provider,event_type,received_at,payload) VALUES (?,?,?,?,?)').run(eventId, 'razorpay', String(event.event || 'unknown'), store.now(), raw.toString('utf8'));
    if (!inserted.changes) return res.json({ received: true, duplicate: true });
  }
  const entity = event.payload?.payment?.entity || event.payload?.subscription?.entity;
  const paymentEntity = event.payload?.payment?.entity;
  const paymentId = paymentEntity?.id || entity?.payment_id || (event.event === 'payment.captured' ? entity?.id : null);
  const providerSubscriptionId = event.payload?.payment?.entity?.subscription_id || event.payload?.subscription?.entity?.id;
  const notedSubscriptionId = entity?.notes?.nightboxSubscriptionId || entity?.notes?.subscriptionId;
  const linkedSubscription = providerSubscriptionId ? store.db.prepare('SELECT id FROM subscriptions WHERE provider_subscription_id=?').get(String(providerSubscriptionId)) : null;
  const subscriptionId = notedSubscriptionId || linkedSubscription?.id;
  try {
    if (['payment.captured', 'subscription.charged'].includes(event.event) && subscriptionId) {
      activateSubscription(subscriptionId, paymentId, raw.toString('utf8'));
      upsertProviderPayment(subscriptionId, paymentId, entity, 'paid', raw.toString('utf8'));
    }
    if (event.event === 'payment.failed' && paymentId) {
      if (subscriptionId) upsertProviderPayment(subscriptionId, paymentId, entity, 'failed', raw.toString('utf8'));
      store.db.prepare("UPDATE payments SET status='failed', raw_event=?, updated_at=? WHERE provider_payment_id=?").run(raw.toString('utf8'), store.now(), paymentId);
      if (subscriptionId) store.db.prepare("UPDATE subscriptions SET status='failed', renews_at=NULL WHERE id=? AND status='pending'").run(subscriptionId);
    }
    if (event.event === 'refund.created' && paymentId) {
      if (subscriptionId) upsertProviderPayment(subscriptionId, paymentId, entity, 'refunded', raw.toString('utf8'));
      store.db.prepare("UPDATE payments SET status='refunded', raw_event=?, updated_at=? WHERE provider_payment_id=?").run(raw.toString('utf8'), store.now(), paymentId);
      if (subscriptionId) store.db.prepare("UPDATE subscriptions SET status='refunded', renews_at=NULL WHERE id=? AND status IN ('pending','active','cancelled')").run(subscriptionId);
    }
    if (['subscription.cancelled', 'subscription.completed'].includes(event.event) && subscriptionId) {
      const nextStatus = event.event === 'subscription.cancelled' ? 'cancelled' : 'expired';
      store.db.prepare('UPDATE subscriptions SET status=?,cancelled_at=COALESCE(cancelled_at,?),renews_at=NULL WHERE id=?').run(nextStatus, store.now(), subscriptionId);
    }
    res.json({ received: true });
  } catch (error) { console.error('Razorpay webhook handling failed:', error.message); res.status(500).json({ error: 'Webhook processing failed' }); }
});

app.post('/api/webhooks/:provider', (req, res) => res.status(404).json({ error: 'Unsupported payment provider' }));

app.get('/l/:slug', (req, res) => {
  const link = store.db.prepare('SELECT v.id FROM creator_links l JOIN videos v ON v.id = l.video_id WHERE l.slug = ?').get(req.params.slug);
  if (!link) return res.status(404).send('Link not found');
  res.redirect(`/watch/${encodeURIComponent(link.id)}?link=${encodeURIComponent(req.params.slug)}`);
});

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
    fileSize: 4 * 1024 * 1024 * 1024, // 4GB max
    files: 1, // Only 1 file at a time
  },
  fileFilter: (req, file, cb) => {
    // Telegram can report application/octet-stream, so retain extension-based
    // compatibility without accepting arbitrary non-video uploads.
    const allowedExtensions = new Set(['.mp4', '.m4v', '.mkv', '.webm', '.avi', '.flv', '.mov', '.wmv', '.3gp', '.mpeg', '.mpg', '.ts', '.ogv']);
    const extension = path.extname(file.originalname || '').toLowerCase();
    const mime = String(file.mimetype || '').toLowerCase();
    if (mime.startsWith('video/') || allowedExtensions.has(extension)) return cb(null, true);
    cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'video'));
  },
});

// POST /upload-file
app.post('/upload-file', (req, res, next) => {
  if (process.env.NODE_ENV === 'production' && !uploadOwner(req)) return res.status(401).json({ error: 'Creator authentication or bot API key is required for uploads' });
  next();
}, upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video file provided' });

  const filePath = req.file.path;
  const fileSize = req.file.size;
  const rawTitle = req.body.title || req.file.originalname || `Video_${Date.now()}`;
  const title = sanitizeInput(rawTitle);
  const owner = uploadOwner(req);
  const botName = String(req.headers['x-bot-name'] || 'upload').slice(0, 40);
  const botExternalId = String(req.headers['x-bot-external-id'] || '').slice(0, 120) || null;

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
      headerHex.startsWith('52494646') || // AVI/WebM variants
      headerHex.startsWith('000001ba') || // MPEG program stream
      headerHex.startsWith('000001b3') || // MPEG video
      headerHex.startsWith('3026b2758e66cf11') || // WMV/ASF
      headerStr.startsWith('oggs') // Ogg video
    );

    if (!isVideo) {
      bunny.cleanupTempFile(filePath);
      return res.status(400).json({ error: 'Invalid file format. Please upload a valid video (MP4, MKV, etc.).' });
    }
  } catch (err) {
    console.error('[UploadGuard] Magic byte check failed:', err);
    bunny.cleanupTempFile(filePath);
    return res.status(400).json({ error: 'Unable to validate uploaded video' });
  }


  console.log(`Upload received: ${title} (${Math.round(fileSize / 1024 / 1024)}MB)`);

  activeUploads++;

  try {
    const contentHash = await fileSha256(filePath);
    const existing = store.findVideoByHash(contentHash, owner?.id);
    if (existing) {
      const creatorLink = owner ? store.createLink(existing.id, owner.id) : null;
      if (owner && req.headers['x-bot-key']) store.db.prepare('INSERT INTO bot_events (id,user_id,bot_name,event_type,external_id,video_id,status,created_at) VALUES (?,?,?,?,?,?,?,?)').run(store.id(), owner.id, botName, 'upload', botExternalId, existing.id, 'duplicate', store.now());
      return res.json({ success: true, duplicate: true, videoId: existing.id, watchUrl: existing.watchUrl, embedUrl: existing.embedUrl, link: creatorLink ? `${DOMAIN_URL}/l/${creatorLink.slug}` : null, message: 'Exact duplicate detected; existing video reused.' });
    }
    const videoData = await bunny.createVideo(title);
    const videoId = videoData.guid;
    await bunny.uploadVideo(videoId, filePath);
    store.createVideo({ id: videoId, ownerId: owner?.id, title, contentHash, fileSize, watchUrl: bunny.getWatchUrl(videoId), embedUrl: bunny.getEmbedUrl(videoId) });
    const creatorLink = owner ? store.createLink(videoId, owner.id) : null;
    if (owner && req.headers['x-bot-key']) store.db.prepare('INSERT INTO bot_events (id,user_id,bot_name,event_type,external_id,video_id,status,created_at) VALUES (?,?,?,?,?,?,?,?)').run(store.id(), owner.id, botName, 'upload', botExternalId, videoId, 'created', store.now());

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
      link: creatorLink ? `${DOMAIN_URL}/l/${creatorLink.slug}` : null,
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
  if (process.env.NODE_ENV === 'production' && !uploadOwner(req)) return res.status(401).json({ error: 'Creator authentication or bot API key is required for uploads' });
  const { url, title: rawTitle } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });
  if (!/^https?:\/\/.+/i.test(url)) return res.status(400).json({ error: 'Invalid URL' });

  const title = sanitizeInput(rawTitle) || `Video_${Date.now()}`;
  const botName = String(req.headers['x-bot-name'] || 'url-upload').slice(0, 40);
  const botExternalId = String(req.headers['x-bot-external-id'] || '').slice(0, 120) || null;

  activeUploads++;

  try {
    const safeUrl = await validateRemoteUrl(url);
    const videoData = await bunny.createVideo(title);
    const videoId = videoData.guid;
    await bunny.uploadVideoFromUrl(videoId, safeUrl, TEMP_DIR);
    const owner = uploadOwner(req);
    store.createVideo({ id: videoId, ownerId: owner?.id, title, watchUrl: bunny.getWatchUrl(videoId), embedUrl: bunny.getEmbedUrl(videoId) });
    const creatorLink = owner ? store.createLink(videoId, owner.id) : null;
    if (owner && req.headers['x-bot-key']) store.db.prepare('INSERT INTO bot_events (id,user_id,bot_name,event_type,external_id,video_id,status,created_at) VALUES (?,?,?,?,?,?,?,?)').run(store.id(), owner.id, botName, 'url_upload', botExternalId, videoId, 'created', store.now());
    res.json({
      success: true,
      videoId,
      watchUrl: bunny.getWatchUrl(videoId),
      embedUrl: bunny.getEmbedUrl(videoId),
      link: creatorLink ? `${DOMAIN_URL}/l/${creatorLink.slug}` : null,
      message: 'Video uploaded from URL. Processing may take a few minutes.',
    });
  } catch (error) {
    console.error('URL upload error:', error.message);
    const message = String(error.message || '');
    const clientError = /invalid remote URL|private network|exceeds the 4GB upload limit/i.test(message);
    res.status(clientError ? 400 : 502).json({ error: clientError ? message : 'Failed to upload video from URL' });
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
          thumbnailUrl: v.thumbnailFileName ? `https://${process.env.BUNNY_CDN_HOST}/${String(process.env.BUNNY_STORAGE_PREFIX || 'nightbox').replace(/^\/+|\/+$/g, '')}/${v.guid}/${v.thumbnailFileName}` : null,
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
  if (!cdnHost || (!BUNNY_LOCAL_STORAGE && (!BUNNY_STORAGE_PASSWORD || !BUNNY_STORAGE_ZONE))) return res.status(503).json({ error: 'Video downloads are not configured on the server' });

  if (BUNNY_LOCAL_STORAGE) {
    const localPath = bunny.getLocalPath(videoId);
    if (!localPath || !fs.existsSync(localPath)) return res.status(404).json({ error: 'Video download not found' });
    const fileName = `${videoId}.mp4`;
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return res.download(localPath, fileName);
  }

  // Try multiple Bunny CDN URL formats in order of preference
  const urlsToTry = [`https://${cdnHost}/${videoId}.mp4`];

  for (const url of urlsToTry) {
    try {
      console.log(`[Download] Trying: ${url}`);
      const response = await axios({
        method: 'GET',
        url: url,
        responseType: 'stream',
        timeout: 300000, // 5 min timeout
        headers: {
          'AccessKey': BUNNY_STORAGE_PASSWORD,
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

// Readiness is stricter than liveness: production traffic should not be
// promoted until the storage, authentication, and monetization providers are configured.
app.get('/ready', (req, res) => {
  const production = process.env.NODE_ENV === 'production';
  let database = false;
  try {
    database = Number(store.db.prepare('SELECT 1 AS ok').get().ok) === 1;
  } catch (_) {}
  const checks = {
    database,
    publicDomain: Boolean(process.env.DOMAIN_URL && /^https:\/\//i.test(process.env.DOMAIN_URL)),
    webOrigins: allowedOrigins.length > 0 && allowedOrigins.every((origin) => /^https:\/\//i.test(origin) && !/localhost|127\.0\.0\.1/i.test(origin)),
    authSecrets: Boolean(process.env.AUTH_SECRET && process.env.IP_HASH_SECRET && process.env.VIEW_HASH_SECRET),
    adminApiKey: Boolean(process.env.ADMIN_API_KEY && process.env.ADMIN_API_KEY.length >= 32),
    trustedProxy: process.env.TRUST_PROXY === 'true',
    bunny: Boolean(process.env.BUNNY_CDN_HOST && (BUNNY_LOCAL_STORAGE || (process.env.BUNNY_STORAGE_PASSWORD && process.env.BUNNY_STORAGE_ZONE))),
    reputationChecks: Boolean(process.env.IPQUALITYSCORE_API_KEY),
    reputationFailClosed: process.env.BLOCK_ON_REPUTATION_FAILURE === 'true',
    payment: Boolean(razorpayConfigured() && process.env.RAZORPAY_WEBHOOK_SECRET),
    recurringPlans: Boolean(razorpayConfigured() && process.env.RAZORPAY_PLAN_MONTHLY && process.env.RAZORPAY_PLAN_PRIORITY),
  };
  const required = production ? Object.values(checks).every(Boolean) : checks.database;
  res.status(required ? 200 : 503).json({ status: required ? 'ready' : 'not_ready', environment: process.env.NODE_ENV || 'development', checks });
});

// Error handler
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large. Max 4GB.' });
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
  console.log(`🎬 Bunny Storage Zone: ${process.env.BUNNY_STORAGE_ZONE}`);
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
