const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const dataDir = path.resolve(process.env.NIGHTBOX_DATA_DIR || path.join(__dirname, 'data'));
fs.mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, 'nightbox.sqlite'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT,
    google_sub TEXT UNIQUE,
    role TEXT NOT NULL DEFAULT 'creator' CHECK (role IN ('creator', 'admin')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
    telegram_user_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS videos (
    id TEXT PRIMARY KEY,
    owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    watch_url TEXT NOT NULL,
    embed_url TEXT NOT NULL,
    content_hash TEXT,
    file_size INTEGER,
    status TEXT NOT NULL DEFAULT 'processing',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS creator_folders (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    parent_id TEXT REFERENCES creator_folders(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_creator_folders_root_name
    ON creator_folders(owner_id, name) WHERE parent_id IS NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_creator_folders_child_name
    ON creator_folders(owner_id, parent_id, name) WHERE parent_id IS NOT NULL;
  CREATE TABLE IF NOT EXISTS creator_files (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    folder_id TEXT REFERENCES creator_folders(id) ON DELETE SET NULL,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
    storage_key TEXT NOT NULL UNIQUE,
    content_hash TEXT,
    share_slug TEXT UNIQUE,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_creator_files_owner_folder
    ON creator_files(owner_id, folder_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS creator_storage_limits (
    creator_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    quota_bytes INTEGER NOT NULL CHECK (quota_bytes IN (2147483648,3221225472)),
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS creator_storage_reservations (
    id TEXT PRIMARY KEY,
    creator_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_creator_storage_reservations_creator
    ON creator_storage_reservations(creator_id, created_at);
  CREATE TABLE IF NOT EXISTS reward_milestones (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    threshold_views INTEGER NOT NULL CHECK (threshold_views > 0),
    reward_note TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reward_claims (
    id TEXT PRIMARY KEY,
    milestone_id TEXT NOT NULL REFERENCES reward_milestones(id) ON DELETE CASCADE,
    creator_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed','approved','rejected','fulfilled')),
    creator_note TEXT,
    admin_note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(milestone_id, creator_id)
  );
  CREATE INDEX IF NOT EXISTS idx_reward_claims_creator ON reward_claims(creator_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS creator_links (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    creator_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    slug TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS view_sessions (
    id TEXT PRIMARY KEY,
    link_id TEXT NOT NULL REFERENCES creator_links(id) ON DELETE CASCADE,
    viewer_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    viewer_hash TEXT NOT NULL,
    ip_hash TEXT NOT NULL,
    view_token_hash TEXT,
    country TEXT NOT NULL DEFAULT 'ZZ',
    started_at TEXT NOT NULL,
    qualified_at TEXT,
    counted INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_view_sessions_link ON view_sessions(link_id);
  CREATE INDEX IF NOT EXISTS idx_view_sessions_viewer ON view_sessions(viewer_hash, started_at);
  CREATE TABLE IF NOT EXISTS cpm_rates (
    country TEXT PRIMARY KEY,
    cpm_cents INTEGER NOT NULL CHECK (cpm_cents >= 0),
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS earnings (
    id TEXT PRIMARY KEY,
    creator_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    link_id TEXT NOT NULL REFERENCES creator_links(id) ON DELETE CASCADE,
    view_id TEXT NOT NULL UNIQUE REFERENCES view_sessions(id) ON DELETE CASCADE,
    country TEXT NOT NULL,
    cpm_cents INTEGER NOT NULL,
    amount_micros INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS view_rules (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    eligible_percent INTEGER NOT NULL DEFAULT 100 CHECK (eligible_percent BETWEEN 0 AND 100),
    max_views_per_viewer_24h INTEGER NOT NULL DEFAULT 1 CHECK (max_views_per_viewer_24h >= 1),
    max_views_per_ip_24h INTEGER NOT NULL DEFAULT 5 CHECK (max_views_per_ip_24h >= 1),
    minimum_watch_seconds INTEGER NOT NULL DEFAULT 5 CHECK (minimum_watch_seconds >= 1),
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS subscription_plans (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    price_minor INTEGER NOT NULL CHECK (price_minor >= 0),
    currency TEXT NOT NULL DEFAULT 'INR',
    duration_days INTEGER NOT NULL,
    video_ads_removed INTEGER NOT NULL DEFAULT 0,
    all_ads_removed INTEGER NOT NULL DEFAULT 0,
    recurring INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_id TEXT NOT NULL REFERENCES subscription_plans(id),
    status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'cancelled', 'expired', 'failed', 'refunded')),
    provider_subscription_id TEXT UNIQUE,
    started_at TEXT,
    expires_at TEXT,
    renews_at TEXT,
    cancelled_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subscription_id TEXT REFERENCES subscriptions(id) ON DELETE SET NULL,
    provider TEXT NOT NULL,
    provider_payment_id TEXT UNIQUE,
    amount_minor INTEGER NOT NULL,
    currency TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('created', 'paid', 'failed', 'refunded')),
    raw_event TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS creator_api_keys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT
  );
  CREATE TABLE IF NOT EXISTS bot_events (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    bot_name TEXT NOT NULL,
    event_type TEXT NOT NULL,
    external_id TEXT,
    video_id TEXT REFERENCES videos(id) ON DELETE SET NULL,
    status TEXT NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS withdrawal_requests (
    id TEXT PRIMARY KEY,
    creator_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount_micros INTEGER NOT NULL CHECK (amount_micros > 0),
    currency TEXT NOT NULL DEFAULT 'USD',
    method TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'paid', 'rejected')),
    note TEXT,
    requested_at TEXT NOT NULL,
    reviewed_at TEXT,
    paid_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_withdrawals_creator ON withdrawal_requests(creator_id, requested_at);
  CREATE INDEX IF NOT EXISTS idx_bot_events_user ON bot_events(user_id, created_at);
  CREATE TABLE IF NOT EXISTS support_tickets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
    admin_note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_support_tickets_user ON support_tickets(user_id, created_at);
  CREATE TABLE IF NOT EXISTS contact_messages (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    subject TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS dmca_reports (
    id TEXT PRIMARY KEY,
    reporter_name TEXT NOT NULL,
    reporter_email TEXT NOT NULL,
    video_id TEXT REFERENCES videos(id) ON DELETE SET NULL,
    video_url TEXT,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_review', 'resolved', 'rejected')),
    admin_note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS platform_events (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    starts_at TEXT,
    ends_at TEXT,
    reward_note TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS provider_events (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    event_type TEXT NOT NULL,
    received_at TEXT NOT NULL,
    payload TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ads_txt_content (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    content TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );
`);

db.prepare('INSERT OR IGNORE INTO ads_txt_content (id, content, updated_at) VALUES (1, ?, ?)').run('', new Date().toISOString());

for (const statement of [
  'ALTER TABLE videos ADD COLUMN content_hash TEXT',
  'ALTER TABLE videos ADD COLUMN file_size INTEGER',
  'ALTER TABLE view_sessions ADD COLUMN viewer_user_id TEXT REFERENCES users(id) ON DELETE SET NULL',
  'ALTER TABLE view_sessions ADD COLUMN view_token_hash TEXT',
  'ALTER TABLE view_rules ADD COLUMN max_views_per_ip_24h INTEGER NOT NULL DEFAULT 5 CHECK (max_views_per_ip_24h >= 1)',
  'ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT \'active\'',
  'ALTER TABLE users ADD COLUMN google_sub TEXT',
]) {
  try { db.exec(statement); } catch (error) {
    if (!String(error.message).includes('duplicate column name')) throw error;
  }
}

db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL');

try { db.exec('ALTER TABLE earnings RENAME COLUMN amount_cents TO amount_micros'); } catch (error) {
  if (!String(error.message).includes('no such column') && !String(error.message).includes('duplicate column')) throw error;
}

const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, expected] = stored.split(':');
  const actual = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

function signToken(user) {
  const secret = process.env.AUTH_SECRET || (process.env.NODE_ENV === 'production' ? null : 'local-development-secret-change-me');
  if (!secret) throw new Error('AUTH_SECRET is required in production');
  const payload = Buffer.from(JSON.stringify({ sub: user.id, role: user.role, exp: Date.now() + 7 * 86400000 })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, signature] = token.split('.');
  const secret = process.env.AUTH_SECRET || (process.env.NODE_ENV === 'production' ? null : 'local-development-secret-change-me');
  if (!secret) return null;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.exp || data.exp < Date.now()) return null;
    return db.prepare('SELECT id, email, role, status FROM users WHERE id = ?').get(data.sub) || null;
  } catch { return null; }
}

function seedPlans() {
  const plans = [
    ['daily', 'Daily', 1400, 1, 1, 0, 0],
    ['weekly', 'Weekly', 9900, 7, 0, 1, 0],
    ['28-day', '28-Day', 29900, 28, 1, 0, 0],
    ['monthly', 'Monthly', 69900, 30, 0, 1, 1],
    // Priority benefits are intentionally unset until the product rules are provided.
    ['priority', 'Priority', 129900, 30, 0, 0, 1],
  ];
  const stmt = db.prepare('INSERT OR IGNORE INTO subscription_plans (id,name,price_minor,duration_days,video_ads_removed,all_ads_removed,recurring) VALUES (?,?,?,?,?,?,?)');
  for (const plan of plans) stmt.run(...plan);
  // Existing databases may have been seeded with the old, invented Priority ad benefit.
  db.prepare('UPDATE subscription_plans SET video_ads_removed=0, all_ads_removed=0 WHERE id=?').run('priority');
  db.prepare('INSERT OR IGNORE INTO view_rules (id, updated_at) VALUES (1, ?)').run(now());
  db.prepare('UPDATE view_rules SET minimum_watch_seconds=5, updated_at=? WHERE id=1 AND minimum_watch_seconds < 5').run(now());
  db.prepare('INSERT OR IGNORE INTO cpm_rates (country, cpm_cents, updated_at) VALUES (?, ?, ?)').run('ZZ', 1000, now());
}
seedPlans();

module.exports = {
  db, id, now, hash, hashPassword, verifyPassword, signToken, verifyToken,
  createUser(email, password, role = 'creator') {
    const user = { id: id(), email: email.trim().toLowerCase(), role };
    db.prepare('INSERT INTO users (id,email,password_hash,role,created_at) VALUES (?,?,?,?,?)').run(user.id, user.email, hashPassword(password), role, now());
    return user;
  },
  linkGoogleUser(email, googleSub) {
    const normalizedEmail = email.trim().toLowerCase();
    let user = db.prepare('SELECT id,email,google_sub AS googleSub,role,status FROM users WHERE google_sub = ?').get(googleSub);
    if (user) return user;

    user = db.prepare('SELECT id,email,google_sub AS googleSub,role,status FROM users WHERE email = ?').get(normalizedEmail);
    if (user) {
      if (user.role !== 'creator') return user;
      if (user.googleSub && user.googleSub !== googleSub) throw new Error('Google identity is already linked to another account');
      if (!user.googleSub) db.prepare('UPDATE users SET google_sub = ? WHERE id = ? AND google_sub IS NULL').run(googleSub, user.id);
      return db.prepare('SELECT id,email,google_sub AS googleSub,role,status FROM users WHERE id = ?').get(user.id);
    }

    const newUserId = id();
    db.prepare('INSERT INTO users (id,email,password_hash,google_sub,role,status,created_at) VALUES (?,?,NULL,?,\'creator\',\'active\',?)')
      .run(newUserId, normalizedEmail, googleSub, now());
    return db.prepare('SELECT id,email,google_sub AS googleSub,role,status FROM users WHERE id = ?').get(newUserId);
  },
  findUser(email) { return db.prepare('SELECT id,email,password_hash,role,status FROM users WHERE email = ?').get(email.trim().toLowerCase()); },
  findUserById(userId) { return db.prepare('SELECT id,email,role,status,telegram_user_id FROM users WHERE id = ?').get(userId); },
  createVideo(video) { db.prepare('INSERT INTO videos (id,owner_id,title,watch_url,embed_url,content_hash,file_size,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(video.id, video.ownerId || null, video.title, video.watchUrl, video.embedUrl, video.contentHash || null, video.fileSize || null, video.status || 'processing', now()); },
  findVideoByHash(contentHash, ownerId) { return db.prepare('SELECT id,title,watch_url AS watchUrl,embed_url AS embedUrl FROM videos WHERE content_hash = ? AND (owner_id = ? OR owner_id IS NULL) ORDER BY created_at ASC LIMIT 1').get(contentHash, ownerId || null); },
  createLink(videoId, creatorId) {
    const link = { id: id(), slug: crypto.randomBytes(8).toString('base64url') };
    db.prepare('INSERT INTO creator_links (id,video_id,creator_id,slug,created_at) VALUES (?,?,?,?,?)').run(link.id, videoId, creatorId, link.slug, now());
    return link;
  },
};
