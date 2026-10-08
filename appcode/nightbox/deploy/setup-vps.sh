#!/bin/bash
# ═══════════════════════════════════════════════
# VPS Deployment Script
# Set VIDEO_DOMAIN and TLS_EMAIL before running this script.
# ═══════════════════════════════════════════════

set -e

VIDEO_DOMAIN="${VIDEO_DOMAIN:?Set VIDEO_DOMAIN to the public video API hostname}"
TLS_EMAIL="${TLS_EMAIL:?Set TLS_EMAIL for certificate renewal notices}"
APP_ROOT="${APP_ROOT:-/opt/video-streaming}"
BACKEND_PORT="${PORT:-3000}"

echo "🚀 Starting VPS Deployment..."

# ──────────────────────────────────────────────
# 1. System Setup
# ──────────────────────────────────────────────
echo "📦 Updating system packages..."
apt update && apt upgrade -y

echo "📦 Installing required packages..."
apt install -y curl wget git nginx certbot python3-certbot-nginx python3-pip python3-venv

# ──────────────────────────────────────────────
# 2. Install Node.js 22 LTS (required by node:sqlite and the frontend)
# ──────────────────────────────────────────────
echo "📦 Installing Node.js 22..."
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt install -y nodejs
fi
echo "Node.js version: $(node --version)"
echo "npm version: $(npm --version)"

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$node_major" -lt 22 ]; then
    echo "Node.js 22 or newer is required" >&2
    exit 1
fi

# Install PM2 globally
npm install -g pm2

# ──────────────────────────────────────────────
# 3. Create app directory
# ──────────────────────────────────────────────
echo "📁 Setting up application directories..."
mkdir -p "$APP_ROOT/backend"
mkdir -p "$APP_ROOT/telegram-bots"
mkdir -p "$APP_ROOT/deploy"

# ──────────────────────────────────────────────
# 4. Deploy Backend
# ──────────────────────────────────────────────
echo "🖥️ Deploying backend..."
# Copy backend files (run from local machine, these go to /opt/video-streaming/backend/)
cd "$APP_ROOT/backend"
npm install --production

# ──────────────────────────────────────────────
# 5. Deploy Telegram Bots
# ──────────────────────────────────────────────
echo "🤖 Deploying Telegram bots..."
cd "$APP_ROOT/telegram-bots"
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
deactivate

# ──────────────────────────────────────────────
# 6. Configure Nginx
# ──────────────────────────────────────────────
echo "🌐 Configuring Nginx..."
NGINX_SITE="/etc/nginx/sites-available/${VIDEO_DOMAIN}"
ACME_ROOT="/var/www/certbot"
mkdir -p "$ACME_ROOT"

# Start with HTTP only so nginx can serve the ACME challenge before a
# certificate exists. The final TLS config is installed after certbot succeeds.
cat > "$NGINX_SITE" <<EOF
server {
    listen 80;
    server_name ${VIDEO_DOMAIN};
    location /.well-known/acme-challenge/ { root ${ACME_ROOT}; }
    location / {
        proxy_pass http://127.0.0.1:${BACKEND_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
ln -sf "/etc/nginx/sites-available/${VIDEO_DOMAIN}" "/etc/nginx/sites-enabled/${VIDEO_DOMAIN}"
rm -f /etc/nginx/sites-enabled/default

# Test nginx config
nginx -t

# ──────────────────────────────────────────────
# 7. SSL Certificate
# ──────────────────────────────────────────────
echo "🔒 Setting up SSL..."
certbot certonly --webroot -w "$ACME_ROOT" -d "$VIDEO_DOMAIN" --non-interactive --agree-tos --email "$TLS_EMAIL"

# Install the final TLS, upload-limit, and proxy configuration now that the
# certificate paths are valid.
sed -e "s/__VIDEO_DOMAIN__/${VIDEO_DOMAIN}/g" \
    -e "s/127.0.0.1:3000/127.0.0.1:${BACKEND_PORT}/g" \
    "$APP_ROOT/deploy/nginx-video.conf" > "$NGINX_SITE"

nginx -t

# Restart nginx
systemctl restart nginx

# ──────────────────────────────────────────────
# 8. Start Services with PM2
# ──────────────────────────────────────────────
echo "🚀 Starting services..."

# Never start a production process with implicit development defaults. The
# readiness endpoint below must also pass before this script reports success.
if [ ! -f "$APP_ROOT/backend/.env" ]; then
    echo "Missing $APP_ROOT/backend/.env; configure production secrets before starting" >&2
    exit 1
fi
set -a
# shellcheck disable=SC1091
source "$APP_ROOT/backend/.env"
set +a
export NODE_ENV=production

# Start backend
pm2 start "$APP_ROOT/backend/server.js" --name "video-backend" --update-env

sleep 2
curl --fail --silent --show-error "http://127.0.0.1:${BACKEND_PORT}/ready" >/dev/null

# Start the controller, all named service bots, and legacy compatibility bots
# from one ecosystem definition so no required bot is skipped.
cd "$APP_ROOT/telegram-bots"
pm2 start ecosystem.config.js

# Save PM2 config and set startup
pm2 save
pm2 startup

echo ""
echo "═══════════════════════════════════════════════"
echo "✅ Deployment Complete!"
echo "═══════════════════════════════════════════════"
echo ""
echo "🌐 API: https://${VIDEO_DOMAIN}"
echo "❤️  Health: https://${VIDEO_DOMAIN}/health"
echo ""
echo "📊 PM2 Status: pm2 status"
echo "📋 Backend Logs: pm2 logs video-backend"
echo "📋 Upload Bot Logs: pm2 logs upload-bot"
echo "📋 Convert Bot Logs: pm2 logs convert-bot"
echo ""
