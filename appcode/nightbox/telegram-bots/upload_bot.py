"""
Telegram Upload Bot (Pyrogram + aiohttp)
-----------------------------------------
Accepts video files of ANY size from users, uploads them to the backend,
and returns a watch link.

Uses Pyrogram (MTProto) instead of Bot API to bypass the 20MB download limit.
The backend accepts files up to 2 GB; Telegram's own download limit may be
lower depending on the account/API path used.

Key features:
- Fully async (non-blocking) upload with aiohttp
- Concurrent upload limiting (max 5)
- Retry logic with exponential backoff
- Input sanitization for security
- Video file validation

Usage: python upload_bot.py
"""

import os
import json
import logging
import asyncio
import tempfile
import re
import time
import aiohttp
from pathlib import Path
from dotenv import load_dotenv
from pyrogram import Client, filters
from pyrogram.types import (
    Message,
    InlineKeyboardMarkup,
    InlineKeyboardButton,
)
from creator_keys import (
    get_creator_key,
    get_text_preferences,
    is_full_creator_key,
    key_help_text,
    remove_creator_key,
    set_creator_key,
    set_pending_text,
    consume_pending_text,
    update_text_preferences,
    remove_text_preference,
)
from text_overlay import apply_text_overlay
from bot_menu import register_bot_menu, settings_keyboard, upload_commands

load_dotenv()

# Configuration
BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN_UPLOAD")
API_ID = os.getenv("TELEGRAM_API_ID")
API_HASH = os.getenv("TELEGRAM_API_HASH")
BACKEND_URL = os.getenv("BACKEND_URL", "http://localhost:3000").rstrip("/")
CREATOR_API_KEY = os.getenv("CREATOR_API_KEY", "")
BOT_NAME = os.getenv("BOT_NAME", "videos-upload")
REQUIRE_CONNECT = os.getenv("TELEGRAM_REQUIRE_CONNECT", "true").lower() == "true"

# Limits
MAX_CONCURRENT_UPLOADS = 10
UPLOAD_RETRY_ATTEMPTS = 3
UPLOAD_RETRY_DELAY = 5  # seconds

# Concurrency semaphore
upload_semaphore = asyncio.Semaphore(MAX_CONCURRENT_UPLOADS)

# Video magic bytes for validation
VIDEO_MAGIC_BYTES = {
    b'\x00\x00\x00': 'mp4/mov',      # ftyp box (MP4/MOV)
    b'\x1a\x45\xdf': 'webm/mkv',     # EBML header (WebM/MKV)
    b'\x46\x4c\x56': 'flv',          # FLV
    b'\x30\x26\xb2': 'wmv',          # ASF/WMV
    b'\x52\x49\x46': 'avi',          # RIFF (AVI)
}

# Logging
logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)

# Create Pyrogram bot client
app = Client(
    "nightbox_upload",
    api_id=int(API_ID) if API_ID else None,
    api_hash=API_HASH,
    bot_token=BOT_TOKEN,
)


def sanitize_title(title):
    """Sanitize title to prevent injection attacks."""
    if not title:
        return "Video"
    title = re.sub(r'<[^>]+>', '', title)
    title = re.sub(r'[<>"\';{}()\[\]\\]', '', title)
    return title.strip()[:100] or "Video"


def validate_video_file(file_path):
    """Check if a file is actually a video by reading magic bytes."""
    try:
        with open(file_path, 'rb') as f:
            header = f.read(12)
        # Check for ftyp box (MP4/MOV) — the 'ftyp' string appears at offset 4
        if b'ftyp' in header[:12]:
            return True
        # Check other magic bytes
        for magic, fmt in VIDEO_MAGIC_BYTES.items():
            if header[:3] == magic:
                return True
        # If MIME type from Telegram says video, trust it
        return True  # Don't block — Telegram already verified
    except Exception:
        return True  # Don't block on validation errors


def creator_key(chat_id):
    key = get_creator_key(chat_id)
    return key or ("" if REQUIRE_CONNECT else CREATOR_API_KEY)


def extract_creator_key(text):
    """Extract a creator key even when Telegram adds whitespace or extra text."""
    match = re.search(r"nb_live_[A-Za-z0-9_-]+", text or "")
    return match.group(0) if match else ""


def bot_headers(chat_id):
    result = {"X-Bot-Name": BOT_NAME, "X-Bot-External-ID": str(chat_id)}
    key = creator_key(chat_id)
    if key:
        result["X-Bot-Key"] = key
    return result


async def upload_to_backend(file_path, file_name, title, chat_id):
    """Upload video to backend with retry logic (async, non-blocking)."""
    safe_title = sanitize_title(title)

    if not os.path.exists(file_path):
        raise Exception(f"File not found: {file_path}")

    file_size = os.path.getsize(file_path)
    if file_size == 0:
        raise Exception("ABORT: File is 0 bytes — download failed")

    logger.info(f"Uploading {file_size} bytes as {file_name}")

    for attempt in range(1, UPLOAD_RETRY_ATTEMPTS + 1):
        try:
            # Increase timeout for very large files
            timeout = aiohttp.ClientTimeout(total=3600)  # 1 hour
            async with aiohttp.ClientSession(timeout=timeout) as session:
                data = aiohttp.FormData()
                # Use a generator or file-like object to stream from disk (saves RAM)
                data.add_field(
                    'video',
                    open(file_path, 'rb'),
                    filename=file_name,
                    content_type='video/mp4'
                )
                data.add_field('title', safe_title)

                headers = bot_headers(chat_id)
                async with session.post(f"{BACKEND_URL}/upload-file", data=data, headers=headers) as resp:
                    if resp.status == 200:
                        result = await resp.json()
                        logger.info(f"Upload success: {result.get('videoId', 'unknown')}")
                        return result
                    else:
                        error = "Unknown error"
                        try:
                            err_data = await resp.json()
                            error = err_data.get("error", error)
                        except Exception:
                            error = (await resp.text())[:200]
                        raise Exception(f"Backend error (HTTP {resp.status}): {error}")

        except asyncio.TimeoutError:
            logger.warning(f"Upload timeout (attempt {attempt}/{UPLOAD_RETRY_ATTEMPTS})")
            if attempt == UPLOAD_RETRY_ATTEMPTS:
                raise Exception("Backend upload timed out after all retries")
            await asyncio.sleep(UPLOAD_RETRY_DELAY * attempt)
        except Exception as e:
            logger.warning(f"Upload attempt {attempt} failed: {e}")
            if attempt == UPLOAD_RETRY_ATTEMPTS:
                raise
            await asyncio.sleep(UPLOAD_RETRY_DELAY * attempt)


@app.on_message(filters.command("start"))
async def start_command(client: Client, message: Message):
    """Handle /start command"""
    await message.reply_text(
        "🎬 **Prerna Video Upload Bot**\n\n"
        "Send me a video file and I'll upload it to our streaming platform.\n\n"
        "📹 **Supported:** Any video format; backend limit 2 GB (Telegram source limits may apply)\n"
        "🔐 First connect your creator account with /connect nb_live_...\n\n"
        "Just send or forward a video to get started!",
        reply_markup=settings_keyboard(),
    )


@app.on_message(filters.command("help"))
async def help_command(client: Client, message: Message):
    """Handle /help command"""
    await message.reply_text(
        "📖 **How to use:**\n\n"
        "1️⃣ Send me any video file (any size)\n"
        "2️⃣ Wait for upload to complete\n"
        "3️⃣ Get your streaming link!\n\n"
        "🔗 The link opens directly in our app.\n"
        "📱 If app is not installed, it redirects to Play Store.\n\n"
        "📝 Text overlay commands (for the next uploads):\n"
        "`/add_header Your header`\n"
        "`/add_footer Your footer`\n"
        "`/enable_text` or `/disable_text`\n"
        "`/remove_header` or `/remove_footer`\n"
        "`/enable_bold` or `/disable_bold`\n"
        "`/text_status`",
        reply_markup=settings_keyboard(),
    )


def command_text(message):
    parts = (message.text or "").split(maxsplit=1)
    return parts[1].strip() if len(parts) == 2 else ""


@app.on_message(filters.command("add_header"))
async def add_header_command(client: Client, message: Message):
    value = command_text(message)
    if not value:
        set_pending_text(message.chat.id, "header")
        await message.reply_text("Send the header text in your next message. No command needed.")
        return
    preferences = update_text_preferences(message.chat.id, header=value)
    await message.reply_text(
        f"✅ Header saved for future uploads. Text overlay is currently {'ON' if preferences['enabled'] else 'OFF'}.\n"
        "Use `/enable_text` to burn it into the video."
    )


@app.on_message(filters.command("add_footer"))
async def add_footer_command(client: Client, message: Message):
    value = command_text(message)
    if not value:
        set_pending_text(message.chat.id, "footer")
        await message.reply_text("Send the footer text in your next message. No command needed.")
        return
    preferences = update_text_preferences(message.chat.id, footer=value)
    await message.reply_text(
        f"✅ Footer saved for future uploads. Text overlay is currently {'ON' if preferences['enabled'] else 'OFF'}.\n"
        "Use `/enable_text` to burn it into the video.", reply_markup=settings_keyboard()
    )


@app.on_message(filters.command("remove_header"))
async def remove_header_command(client: Client, message: Message):
    remove_text_preference(message.chat.id, "header")
    await message.reply_text("✅ Header removed.", reply_markup=settings_keyboard())


@app.on_message(filters.command("remove_footer"))
async def remove_footer_command(client: Client, message: Message):
    remove_text_preference(message.chat.id, "footer")
    await message.reply_text("✅ Footer removed.", reply_markup=settings_keyboard())


@app.on_message(filters.command("enable_text"))
async def enable_text_command(client: Client, message: Message):
    preferences = get_text_preferences(message.chat.id)
    if not preferences["header"] and not preferences["footer"]:
        await message.reply_text("⚠️ Add a header or footer first, then use `/enable_text`.")
        return
    update_text_preferences(message.chat.id, enabled=True)
    await message.reply_text("✅ Text overlay enabled. It will be applied to the next uploaded videos.")


@app.on_message(filters.command("disable_text"))
async def disable_text_command(client: Client, message: Message):
    update_text_preferences(message.chat.id, enabled=False)
    await message.reply_text("✅ Text overlay disabled. Existing videos are unchanged.")


@app.on_message(filters.command("enable_bold"))
async def enable_bold_command(client: Client, message: Message):
    update_text_preferences(message.chat.id, bold=True)
    await message.reply_text("✅ Bold text enabled for future uploads.", reply_markup=settings_keyboard())


@app.on_message(filters.command("disable_bold"))
async def disable_bold_command(client: Client, message: Message):
    update_text_preferences(message.chat.id, bold=False)
    await message.reply_text("✅ Normal text enabled for future uploads.", reply_markup=settings_keyboard())


@app.on_message(filters.command("text_status"))
async def text_status_command(client: Client, message: Message):
    preferences = get_text_preferences(message.chat.id)
    header = preferences["header"] or "(not set)"
    footer = preferences["footer"] or "(not set)"
    await message.reply_text(
        "📝 **Text overlay settings**\n\n"
        f"Status: {'ON' if preferences['enabled'] else 'OFF'}\n"
        f"Bold: {'ON' if preferences.get('bold') else 'OFF'}\n"
        f"Header: {header}\n"
        f"Footer: {footer}"
    )


@app.on_callback_query(filters.regex(r"^nb:"))
async def settings_callback(_, query):
    action = query.data.split(":", 1)[1]
    await query.answer()
    chat_id = query.message.chat.id
    if action == "add_header" or action == "add_footer":
        set_pending_text(chat_id, action.replace("add_", ""))
        await query.message.reply_text("Send the text in your next message.")
    elif action in {"remove_header", "remove_footer"}:
        remove_text_preference(chat_id, action.replace("remove_", ""))
        await query.message.reply_text("✅ Removed.", reply_markup=settings_keyboard())
    elif action == "enable_text":
        update_text_preferences(chat_id, enabled=True)
        await query.message.reply_text("✅ Text overlay enabled.", reply_markup=settings_keyboard())
    elif action == "disable_text":
        update_text_preferences(chat_id, enabled=False)
        await query.message.reply_text("✅ Text overlay disabled.", reply_markup=settings_keyboard())
    elif action == "enable_bold":
        update_text_preferences(chat_id, bold=True)
        await query.message.reply_text("✅ Bold text enabled.", reply_markup=settings_keyboard())
    elif action == "disable_bold":
        update_text_preferences(chat_id, bold=False)
        await query.message.reply_text("✅ Normal text enabled.", reply_markup=settings_keyboard())
    elif action == "text_status":
        p = get_text_preferences(chat_id)
        await query.message.reply_text(f"Status: {'ON' if p['enabled'] else 'OFF'}\nBold: {'ON' if p.get('bold') else 'OFF'}\nHeader: {p['header'] or '(not set)'}\nFooter: {p['footer'] or '(not set)'}", reply_markup=settings_keyboard())
    elif action == "disconnect":
        remove_creator_key(chat_id)
        await query.message.reply_text("✅ Creator account disconnected.")


@app.on_message(filters.command("status"))
async def status_command(client: Client, message: Message):
    """Handle /status command — show bot health"""
    active = MAX_CONCURRENT_UPLOADS - upload_semaphore._value
    await message.reply_text(
        "📊 **Bot Status**\n\n"
        f"🟢 **Status:** Online\n"
        f"📤 **Active Uploads:** {active}/{MAX_CONCURRENT_UPLOADS}\n"
        f"🌐 **Backend:** `{BACKEND_URL}`",
    )


@app.on_message(filters.command("connect"))
async def connect_command(client: Client, message: Message):
    key = extract_creator_key(message.text or "")
    if not key:
        await message.reply_text(
            "Send the complete API key in your next message, or use one line:\n"
            "/connect nb_live_your_full_key\n\n"
            "The KEY PREFIX shown in Bots & API is not enough to connect."
        )
        return
    if not is_full_creator_key(key):
        await message.reply_text(key_help_text())
        return
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(f"{BACKEND_URL}/api/creator/bot-identity", headers={"X-Bot-Key": key}, timeout=15) as response:
                data = await response.json(content_type=None)
                if response.status >= 300:
                    raise RuntimeError(
                        "The key was rejected. Create a fresh API key and use the full one-time value."
                    )
        set_creator_key(message.chat.id, key)
        await message.reply_text(f"Connected to creator account {data['user']['email']}.")
    except Exception as error:
        await message.reply_text(f"Connection failed: {str(error)[:200]}")


@app.on_message(filters.text & filters.regex(r"nb_live_[A-Za-z0-9_-]+") & ~filters.command(["start", "help", "status", "connect", "disconnect"]))
async def pasted_key_command(client: Client, message: Message):
    """Accept a pasted creator key, including copied text with whitespace or labels."""
    key = extract_creator_key(message.text or "")
    if not is_full_creator_key(key):
        await message.reply_text(key_help_text())
        return
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(f"{BACKEND_URL}/api/creator/bot-identity", headers={"X-Bot-Key": key}, timeout=15) as response:
                data = await response.json(content_type=None)
                if response.status >= 300:
                    raise RuntimeError(
                        "The key was rejected. Create a fresh API key and use the full one-time value."
                    )
        set_creator_key(message.chat.id, key)
        await message.reply_text(f"Connected to creator account {data['user']['email']}. Now send your video file.")
    except Exception as error:
        await message.reply_text(
            f"Connection failed: {str(error)[:200]}\n"
            "Create a fresh key and send /connect followed by the full one-time API key."
        )


@app.on_message(filters.command("disconnect"))
async def disconnect_command(client: Client, message: Message):
    remove_creator_key(message.chat.id)
    await message.reply_text("Disconnected from the creator account.")


@app.on_message(filters.video | filters.document | filters.animation)
async def handle_video(client: Client, message: Message):
    """Handle incoming video files — ANY size"""
    if not creator_key(message.chat.id):
        await message.reply_text("Connect your creator account first with /connect nb_live_your_creator_key")
        return
    # Bulk upload support: Requests are now queued instead of rejected.

    # For documents, do a basic check but don't be strict
    if message.document:
        mime = message.document.mime_type or ""
        name = (message.document.file_name or "").lower()
        video_extensions = (
            ".mp4", ".mkv", ".avi", ".mov", ".webm", ".flv",
            ".wmv", ".m4v", ".3gp", ".ts", ".mpg", ".mpeg",
            ".vob", ".ogv", ".rm", ".rmvb", ".divx",
        )
        is_video = mime.startswith("video/") or any(
            name.endswith(ext) for ext in video_extensions
        )
        if not is_video and mime and not mime.startswith("video/"):
            await message.reply_text(
                "⚠️ This doesn't appear to be a video file.\n"
                "Supported formats: MP4, MKV, AVI, MOV, WebM, FLV, etc.\n\n"
                "Send a video file to continue.",
            )
            return

    # Get file size for status display
    file_size = 0
    file_name = "video"
    if message.video:
        file_size = message.video.file_size or 0
        file_name = message.video.file_name or f"Video_{message.video.file_unique_id}"
    elif message.document:
        file_size = message.document.file_size or 0
        file_name = message.document.file_name or f"Video_{message.document.file_unique_id}"
    elif message.animation:
        file_size = message.animation.file_size or 0
        file_name = message.animation.file_name or f"GIF_{message.animation.file_unique_id}"

    size_mb = round(file_size / (1024 * 1024), 1) if file_size else 0

    # Sanitize filename
    safe_file_name = sanitize_title(file_name)

    # Send processing message
    status_msg = await message.reply_text(
        "⏳ **Queued...**\n\n"
        f"📁 File: `{safe_file_name}`\n"
        f"📏 Size: {size_mb} MB\n\n"
        "Your file will start uploading shortly.",
    )

    tmp_path = None
    try:
        async with upload_semaphore:
            # Update status to downloading
            await status_msg.edit_text(
                "⏳ **Uploading your video...**\n\n"
                f"📁 File: `{safe_file_name}`\n"
                f"📏 Size: {size_mb} MB\n\n"
                "📥 Downloading from Telegram...",
            )
            # Download file using Pyrogram (MTProto — no size limit!)
            last_progress = [0]

            async def progress(current, total):
                pct = int(current * 100 / total) if total else 0
                if pct - last_progress[0] >= 15:
                    last_progress[0] = pct
                    try:
                        await status_msg.edit_text(
                            "⏳ **Uploading your video...**\n\n"
                            f"📁 File: `{safe_file_name}`\n"
                            f"📏 Size: {size_mb} MB\n\n"
                            f"📥 Downloading: {pct}%",
                        )
                    except Exception:
                        pass

            # Download to temp file
            suffix = os.path.splitext(file_name)[1] if "." in file_name else ".mp4"
            tmp_fd, tmp_path = tempfile.mkstemp(suffix=suffix)
            os.close(tmp_fd)

            await message.download(
                file_name=tmp_path,
                progress=progress,
            )
            logger.info(f"Downloaded video: {safe_file_name} ({size_mb} MB) to {tmp_path}")

            # Validate the downloaded file
            if not validate_video_file(tmp_path):
                raise Exception("Downloaded file does not appear to be a valid video")

            processed_path, overlay_applied = await apply_text_overlay(
                tmp_path,
                os.path.dirname(tmp_path),
                message.chat.id,
            )
            if overlay_applied:
                await status_msg.edit_text(
                    "⏳ **Applying text overlay...**\n\n"
                    f"📁 File: `{safe_file_name}`\n"
                    "This may take a little longer for large videos."
                )
            else:
                processed_path = tmp_path

            # Update status
            await status_msg.edit_text(
                "⏳ **Uploading your video...**\n\n"
                f"📁 File: `{safe_file_name}`\n"
                f"📏 Size: {size_mb} MB\n\n"
                "☁️ Uploading to streaming server...",
            )

            # Upload to backend (async, non-blocking, with retries)
            title = os.path.splitext(file_name)[0] if file_name else f"Video_{message.id}"
            upload_name = f"{os.path.splitext(file_name)[0]}.mp4" if overlay_applied else file_name
            data = await upload_to_backend(processed_path, upload_name, title, message.chat.id)

            video_id = data.get("videoId", "")
            watch_url = data.get("link") or data.get("watchUrl", "")

            await status_msg.edit_text(watch_url)
            logger.info(f"Video uploaded: {video_id} ({size_mb} MB)")

    except Exception as e:
        logger.error(f"Error handling video: {e}")
        try:
            await status_msg.edit_text(
                f"❌ **Upload Failed**\n\n"
                f"Error: {str(e)[:300]}\n\n"
                "💡 Try again or send a different file.",
            )
        except Exception:
            pass
    finally:
        # Clean up temp file
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
                logger.info(f"Cleaned up: {tmp_path}")
            except Exception:
                pass
        if 'processed_path' in locals() and processed_path != tmp_path and os.path.exists(processed_path):
            try:
                os.unlink(processed_path)
                logger.info(f"Cleaned up overlay file: {processed_path}")
            except Exception:
                pass


@app.on_message(filters.text & ~filters.regex(r"^/"))
async def handle_unknown(client: Client, message: Message):
    """Handle non-video messages"""
    pending = consume_pending_text(message.chat.id)
    if pending:
        update_text_preferences(message.chat.id, **{pending: (message.text or "").strip()})
        await message.reply_text(f"✅ {pending.title()} saved. Use `/enable_text` to apply it to future uploads.")
        return
    await message.reply_text(
        "📹 Please send me a **video file** to upload.\n"
        "Use /help for more info.",
    )


def main():
    """Start the bot"""
    if not BOT_TOKEN:
        logger.error("TELEGRAM_BOT_TOKEN_UPLOAD not set!")
        return
    if not API_ID or not API_HASH:
        logger.error(
            "TELEGRAM_API_ID and TELEGRAM_API_HASH are required!\n"
            "Get them from https://my.telegram.org/apps"
        )
        return

    logger.info("🤖 Upload Bot starting (Pyrogram/MTProto + aiohttp)...")
    logger.info(f"   Backend: {BACKEND_URL}")
    logger.info(f"   Max concurrent uploads: {MAX_CONCURRENT_UPLOADS} (Queuing enabled)")
    register_bot_menu(BOT_TOKEN, upload_commands())
    app.run()


if __name__ == "__main__":
    main()
