#!/bin/bash
# ═══════════════════════════════════════════════
# Upload files to VPS
# Run this from your local machine
# ═══════════════════════════════════════════════

VPS_IP="67.211.219.103"
VPS_USER="root"
REMOTE_DIR="/opt/video-streaming"

echo "📤 Uploading files to VPS..."

# Upload backend
echo "Uploading backend..."
scp -r ../backend/* ${VPS_USER}@${VPS_IP}:${REMOTE_DIR}/backend/

# Upload telegram bots
echo "Uploading telegram bots..."
scp -r ../telegram-bots/* ${VPS_USER}@${VPS_IP}:${REMOTE_DIR}/telegram-bots/

# Upload deploy scripts
echo "Uploading deploy config..."
scp nginx-video.conf ${VPS_USER}@${VPS_IP}:${REMOTE_DIR}/deploy/

echo ""
echo "✅ Files uploaded!"
echo ""
echo "Now SSH into the VPS and run:"
echo "  ssh ${VPS_USER}@${VPS_IP}"
echo "  bash ${REMOTE_DIR}/deploy/setup-vps.sh"
