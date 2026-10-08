#!/usr/bin/env bash
set -euo pipefail

RELEASE=/home/nightbox-deploy/release
APP=/var/www/nightbox/nightbox-p4
BACKEND="$APP/backend"

test -f "$RELEASE/backend/Dockerfile"
test -f "$APP/backend/.env"

install -d -m 0755 "$APP/web"
rsync -a --delete "$RELEASE/web/" "$APP/web/"
rsync -a --delete \
  --exclude='.env' \
  --exclude='data/' \
  --exclude='temp/' \
  --exclude='media/' \
  --exclude='node_modules/' \
  "$RELEASE/backend/" "$BACKEND/"

docker build -t nightbox-p4-backend:local-origin "$BACKEND"
docker rm -f nightbox-p4-backend >/dev/null 2>&1 || true
docker run -d --name nightbox-p4-backend --restart unless-stopped \
  -p 127.0.0.1:3010:3000 \
  --env-file "$BACKEND/.env" \
  -v /var/lib/nightbox-p4/temp:/app/temp \
  -v /var/lib/nightbox-p4/data:/app/data \
  -v /var/lib/nightbox-p4/media:/app/media \
  nightbox-p4-backend:local-origin >/dev/null

sleep 3
curl --fail --silent --show-error http://127.0.0.1:3010/health >/dev/null
