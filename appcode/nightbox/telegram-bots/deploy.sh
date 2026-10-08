#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
test -f .env || { echo "Missing telegram-bots/.env" >&2; exit 1; }
command -v pm2 >/dev/null || { echo "PM2 is not installed" >&2; exit 1; }

python3 -m venv venv
./venv/bin/pip install --disable-pip-version-check -r requirements.txt
chmod 600 .env
mkdir -p state
chmod 700 state

# Only start/reload the NightBox bot names from this ecosystem file.
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save
pm2 status nightbox-connection-bot nightbox-terabox-bot nightbox-diskwala-bot nightbox-upload-bot
