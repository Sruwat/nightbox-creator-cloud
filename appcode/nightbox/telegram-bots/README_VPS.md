# NightBox Telegram bots

The production workflow deploys these four PM2 processes from this directory:

- `nightbox-connection-bot`: validates and stores a creator connection.
- `nightbox-terabox-bot`: downloads supported TeraBox links and uploads the resulting video.
- `nightbox-diskwala-bot`: uses yt-dlp for supported Diskwala links, then uploads the video.
- `nightbox-nightbox-to-nightbox-bot`: attaches an existing NightBox link to the connected creator and creates a separate earning link.
- `nightbox-nightheast-to-nightbox-bot`: downloads a Nightheast URL and creates a NightBox link for the connected creator.
- `nightbox-upload-bot`: accepts Telegram video/document uploads.

The connection bot and upload/conversion bots share creator keys in `state/creator_keys.sqlite3`. The state directory and database are permission-restricted. Deployment excludes `state/`, `.env`, virtualenvs, and Pyrogram session files from source cleanup so private runtime data is not overwritten.

## Required VPS environment

GitHub Actions maps repository secrets into these environment variables on the VPS; do not commit `.env`:

- `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`
- `TELEGRAM_BOT_TOKEN_CONNECTION`, `TELEGRAM_BOT_TOKEN_TERABOX`, `TELEGRAM_BOT_TOKEN_DISKWALA`, `TELEGRAM_BOT_TOKEN_NIGHTBOX_TO_NIGHTBOX`, `TELEGRAM_BOT_TOKEN_NIGHTHEAST_TO_NIGHTBOX`, `TELEGRAM_BOT_TOKEN_UPLOAD`
- `BACKEND_URL=http://127.0.0.1:3010`
- `TELEGRAM_REQUIRE_CONNECT=true`
- `TELEGRAM_STATE_DIR=/var/www/nightbox/nightbox-p4/telegram-bots/state`

Creators connect with `/connect nb_live_<creator-key>` and can remove the stored connection with `/disconnect`. A successful connection validates the key with the NightBox backend before saving it.

## Manual operations

From this directory, `bash deploy.sh` installs Python requirements and reloads only the four NightBox PM2 applications. It does not stop unrelated PM2 processes or delete Telegram session files. Inspect services with:

```bash
pm2 status nightbox-connection-bot nightbox-terabox-bot nightbox-diskwala-bot nightbox-nightbox-to-nightbox-bot nightbox-nightheast-to-nightbox-bot nightbox-upload-bot
pm2 logs nightbox-connection-bot
```

TeraBox fallback extractors and yt-dlp provider support depend on external services and source links. A running PM2 process alone does not prove every third-party link is convertible; representative links must be tested after deployment.
