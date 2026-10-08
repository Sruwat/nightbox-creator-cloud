#!/bin/bash
# ═══════════════════════════════════════════════
# VPS Deployment Script
# Server: 67.211.219.103
# Domain: video.premnaupin.in
# ═══════════════════════════════════════════════

set -e

echo "🚀 Starting VPS Deployment..."

# ──────────────────────────────────────────────
# 1. System Setup
# ──────────────────────────────────────────────
echo "📦 Updating system packages..."
apt update && apt upgrade -y

echo "📦 Installing required packages..."
apt install -y curl wget git nginx certbot python3-certbot-nginx python3-pip python3-venv

# ──────────────────────────────────────────────
# 2. Install Node.js 20 LTS
# ──────────────────────────────────────────────
echo "📦 Installing Node.js 20..."
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt install -y nodejs
fi
echo "Node.js version: $(node --version)"
echo "npm version: $(npm --version)"

# Install PM2 globally
npm install -g pm2

# ──────────────────────────────────────────────
# 3. Create app directory
# ──────────────────────────────────────────────
echo "📁 Setting up application directories..."
mkdir -p /opt/video-streaming/backend
mkdir -p /opt/video-streaming/telegram-bots

# ──────────────────────────────────────────────
# 4. Deploy Backend
# ──────────────────────────────────────────────
echo "🖥️ Deploying backend..."
# Copy backend files (run from local machine, these go to /opt/video-streaming/backend/)
cd /opt/video-streaming/backend
npm install --production

# ──────────────────────────────────────────────
# 5. Deploy Telegram Bots
# ──────────────────────────────────────────────
echo "🤖 Deploying Telegram bots..."
cd /opt/video-streaming/telegram-bots
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
deactivate

# ──────────────────────────────────────────────
# 6. Configure Nginx
# ──────────────────────────────────────────────
echo "🌐 Configuring Nginx..."
cp /opt/video-streaming/deploy/nginx-video.conf /etc/nginx/sites-available/video.premnaupin.in
ln -sf /etc/nginx/sites-available/video.premnaupin.in /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

# Test nginx config
nginx -t

# ──────────────────────────────────────────────
# 7. SSL Certificate
# ──────────────────────────────────────────────
echo "🔒 Setting up SSL..."
# First, temporarily start nginx with HTTP only for certbot
# Modify the config to listen on 80 only first
certbot --nginx -d video.premnaupin.in --non-interactive --agree-tos --email admin@premnaupin.in

# Restart nginx
systemctl restart nginx

# ──────────────────────────────────────────────
# 8. Start Services with PM2
# ──────────────────────────────────────────────
echo "🚀 Starting services..."

# Start backend
pm2 start /opt/video-streaming/backend/server.js --name "video-backend" --env production

# Start upload bot
pm2 start /opt/video-streaming/telegram-bots/venv/bin/python \
    --name "upload-bot" \
    -- /opt/video-streaming/telegram-bots/upload_bot.py

# Start convert bot
pm2 start /opt/video-streaming/telegram-bots/venv/bin/python \
    --name "convert-bot" \
    -- /opt/video-streaming/telegram-bots/convert_bot.py

# Save PM2 config and set startup
pm2 save
pm2 startup

echo ""
echo "═══════════════════════════════════════════════"
echo "✅ Deployment Complete!"
echo "═══════════════════════════════════════════════"
echo ""
echo "🌐 Website: https://video.premnaupin.in"
echo "❤️  Health:  https://video.premnaupin.in/health"
echo ""
echo "📊 PM2 Status: pm2 status"
echo "📋 Backend Logs: pm2 logs video-backend"
echo "📋 Upload Bot Logs: pm2 logs upload-bot"
echo "📋 Convert Bot Logs: pm2 logs convert-bot"
echo ""
