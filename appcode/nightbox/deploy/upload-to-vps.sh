#!/bin/bash
# ═══════════════════════════════════════════════
# Upload files to VPS
# Run this from your local machine
# ═══════════════════════════════════════════════

VPS_HOST="${VPS_HOST:?Set VPS_HOST to the server hostname or IP}"
VPS_USER="${VPS_USER:-root}"
REMOTE_DIR="${REMOTE_DIR:-/opt/video-streaming}"

echo "📤 Uploading files to VPS..."

# Ensure all destinations exist before copying files and deployment templates.
ssh "${VPS_USER}@${VPS_HOST}" "mkdir -p '${REMOTE_DIR}/backend' '${REMOTE_DIR}/telegram-bots' '${REMOTE_DIR}/deploy'"

# Upload backend
echo "Uploading backend..."
scp -r ../backend/* "${VPS_USER}@${VPS_HOST}:${REMOTE_DIR}/backend/"

# Upload telegram bots
echo "Uploading telegram bots..."
scp -r ../telegram-bots/* "${VPS_USER}@${VPS_HOST}:${REMOTE_DIR}/telegram-bots/"

# Upload deploy scripts
echo "Uploading deploy config..."
scp nginx-video.conf "${VPS_USER}@${VPS_HOST}:${REMOTE_DIR}/deploy/"
scp setup-vps.sh "${VPS_USER}@${VPS_HOST}:${REMOTE_DIR}/deploy/"

echo ""
echo "✅ Files uploaded!"
echo ""
echo "Now SSH into the VPS and run:"
echo "  ssh ${VPS_USER}@${VPS_HOST}"
echo "  cd ${REMOTE_DIR}"
echo "  VIDEO_DOMAIN=video.example.com TLS_EMAIL=ops@example.com bash ${REMOTE_DIR}/deploy/setup-vps.sh"
