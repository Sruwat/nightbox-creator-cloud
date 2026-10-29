"""
Telegram Convert Link Bot (Pyrogram + yt-dlp + aiohttp)
PREMIUM VERSION - Supports NDUS Cookie for Perfect TeraBox Downloads
"""
import aiohttp
import aiofiles
import json
import subprocess
import shutil
import tempfile
import logging
import re
import os
import asyncio
import time
from urllib.parse import parse_qs, urlparse
from dotenv import load_dotenv
from pyrogram import Client, filters
from pyrogram.types import Message, InlineKeyboardMarkup, InlineKeyboardButton
from creator_keys import (
    get_creator_key,
    get_text_preferences,
    is_full_creator_key,
    key_help_text,
    remove_creator_key,
    remove_text_preference,
    set_creator_key,
    set_pending_text,
    consume_pending_text,
    update_text_preferences,
)
from bot_menu import convert_commands, register_bot_menu, settings_keyboard

load_dotenv()

BOT_KIND = os.getenv("BOT_KIND", "TERABOX").upper()
BOT_TOKEN = os.getenv(f"TELEGRAM_BOT_TOKEN_{BOT_KIND}")
API_ID = os.getenv("TELEGRAM_API_ID")
API_HASH = os.getenv("TELEGRAM_API_HASH")
BACKEND_URL = os.getenv("BACKEND_URL", "http://localhost:3000").rstrip("/")
CREATOR_API_KEY = os.getenv("CREATOR_API_KEY", "")
BOT_NAME = os.getenv("BOT_NAME", BOT_KIND.lower())
REQUIRE_CONNECT = os.getenv("TELEGRAM_REQUIRE_CONNECT", "true").lower() == "true"
STATE_FALLBACK_KEY = os.getenv("CREATOR_API_KEY", "")
# The two link-conversion bots can resolve the destination creator from the
# verified Telegram sender ID. Creator API keys remain supported as a legacy
# fallback, but users no longer need to paste nb_live_* keys into Telegram.
AUTO_CREATOR_IDENTITY = (
    os.getenv("TELEGRAM_AUTO_CREATOR_IDENTITY", "false").lower() == "true"
    and BOT_KIND in {"NIGHTHEAST_TO_NIGHTBOX", "NIGHTBOX_TO_NIGHTBOX"}
)
NIGHTBOX_BOT_INTEGRATION_KEY = os.getenv("NIGHTBOX_BOT_INTEGRATION_KEY", "")
# Keep the bot-specific names, while also accepting the resolver contract's
# documented names so a shared deployment environment works without renaming
# the secret on either service.
NIGHTHEAST_API_URL = (
    os.getenv("NIGHTHEAST_API_URL")
    or os.getenv("NIGHTHEAST_API_BASE_URL")
    or "https://api.nightheast.com/api/integrations/nightbox"
).rstrip("/")
NIGHTHEAST_INTEGRATION_KEY = (
    os.getenv("NIGHTHEAST_INTEGRATION_KEY")
    or os.getenv("NIGHTBOX_INTEGRATION_KEY")
    or ""
)
# NightBox is an authenticated in-house integration. The Nightheast resolver
# reserves this code for the common exclusive feed, so it can be used as a
# single controlled fallback when a forwarded creator code is stale/mismatched
# or when a user sends only the Nightheast URL.
NIGHTHEAST_FALLBACK_ACCESS_CODE = os.getenv("NIGHTHEAST_FALLBACK_ACCESS_CODE", "143143").strip()

# --- CRITICAL: TERABOX COOKIE ---
TERABOX_NDUS = os.getenv("TERABOX_NDUS") # Get this from your browser cookies

MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024
MAX_CONCURRENT_DOWNLOADS = 3
MIN_VIDEO_SIZE = 300_000

download_semaphore = asyncio.Semaphore(MAX_CONCURRENT_DOWNLOADS)
URL_PATTERN = re.compile(r'https?://[^\s<>"\')\]]+', re.IGNORECASE)
NIGHTHEAST_URL_PATTERN = re.compile(
    r"https?://(?:www\.)?nightheast\.com/video/([A-Za-z0-9_-]+)", re.IGNORECASE
)
ACCESS_CODE_PATTERN = re.compile(
    r"(?:access\s*code|access\s*key|code)\s*[:#-]?\s*([A-Za-z0-9_-]{4,32})",
    re.IGNORECASE,
)

BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

logging.basicConfig(format="%(asctime)s - %(levelname)s - %(message)s", level=logging.INFO)
logger = logging.getLogger(__name__)

if not BOT_TOKEN or not API_ID or not API_HASH:
    raise RuntimeError(f"TELEGRAM_BOT_TOKEN_{BOT_KIND}, TELEGRAM_API_ID and TELEGRAM_API_HASH are required")

app = Client(f"nightbox_{BOT_KIND.lower()}", api_id=int(API_ID), api_hash=API_HASH, bot_token=BOT_TOKEN)


def creator_key(chat_id):
    return get_creator_key(chat_id) or ("" if REQUIRE_CONNECT else STATE_FALLBACK_KEY)


def telegram_user_id(message):
    """Return the sender identity used to select the linked creator account."""
    sender = getattr(message, "from_user", None)
    value = getattr(sender, "id", None)
    return str(value) if value is not None else ""


def backend_headers(chat_id, telegram_id=""):
    headers = {"X-Bot-Name": BOT_NAME, "X-Bot-External-ID": str(chat_id)}
    key = creator_key(chat_id)
    if key:
        headers["X-Bot-Key"] = key
    if AUTO_CREATOR_IDENTITY and NIGHTBOX_BOT_INTEGRATION_KEY and telegram_id:
        headers["X-NightBox-Bot-Key"] = NIGHTBOX_BOT_INTEGRATION_KEY
        headers["X-Telegram-User-ID"] = str(telegram_id)
    return headers


def extract_creator_key(text):
    """Extract a creator key from copied text, including surrounding whitespace."""
    match = re.search(r"nb_live_[A-Za-z0-9_-]+", text or "")
    return match.group(0) if match else ""


def extract_nightheast_video_id(url):
    match = NIGHTHEAST_URL_PATTERN.search(url or "")
    return match.group(1) if match else ""


def extract_access_code(text):
    match = ACCESS_CODE_PATTERN.search(text or "")
    return match.group(1) if match else ""

# ── VALIDATION ──

def validate_video_file(file_path):
    if not os.path.exists(file_path): return False, "File missing"
    fsize = os.path.getsize(file_path)
    if fsize < MIN_VIDEO_SIZE: return False, f"Too small ({fsize} bytes)"
    
    with open(file_path, 'rb') as f: sample = f.read(16384)
    s_low = sample.lower()
    if any(x in s_low for x in [b'<html', b'<!doc', b'<script', b'{"errno"']):
        return False, "Detected HTML/JSON (Nonsense file)"
    
    is_video = (
        b'ftyp' in sample[:24] or 
        sample[:4] == b'\x1a\x45\xdf\xa3' or 
        sample[:3] == b'\x46\x4c\x56' or 
        sample[:4] == b'\x52\x49\x46\x46'
    )
    if not is_video: return False, "Not a valid video format"
    return True, "OK"

# ── TERABOX EXTRACTION (ADVANCED) ──

async def extract_terabox_with_cookie(url):
    """The gold standard: Uses NDUS cookie to get direct links from TeraBox API."""
    if not TERABOX_NDUS: return None
    logger.info("Using NDUS Cookie for extraction...")
    
    cookies = {"ndus": TERABOX_NDUS}
    async with aiohttp.ClientSession(cookies=cookies, headers=BROWSER_HEADERS) as session:
        # 1. Resolve short link
        async with session.get(url, allow_redirects=True) as resp:
            final_url = str(resp.url)
        
        surl = None
        match = re.search(r'surl=([a-zA-Z0-9_-]+)', final_url)
        if match: surl = match.group(1)
        elif "/s/" in final_url: surl = final_url.split("/s/")[-1].split("?")[0]
        
        if not surl: return None
        
        # 2. Get file info from TeraBox internal API
        api_url = f"https://www.1024terabox.com/api/shorturlinfo?shorturl={surl}&root=1"
        async with session.get(api_url) as resp:
            data = await resp.json()
            if data.get("errno") == 0 and data.get("list"):
                item = data["list"][0]
                return {
                    "dlink": item.get("dlink"),
                    "title": item.get("server_filename"),
                    "cookie_mode": True
                }
    return None

async def extract_terabox_api_fallback(url):
    """Fallback to working public APIs."""
    apis = [
        f"https://terabox-dl.qtcloud.workers.dev/api/get-info?url={url}",
        "https://teraboxvideodownloader.top/api/fetch"
    ]
    async with aiohttp.ClientSession(headers=BROWSER_HEADERS) as session:
        for api in apis:
            try:
                if "fetch" in api:
                    resp = await session.post(api, json={"url": url})
                else:
                    resp = await session.get(api)
                
                if resp.status == 200:
                    data = await resp.json()
                    dlink = data.get("download_link") or data.get("downloadLink") or data.get("dlink")
                    if dlink: return {"dlink": dlink, "title": data.get("title", "Video")}
            except Exception: continue
    return None

async def download_terabox(url, tmp_dir):
    logger.info(f"Extracting: {url}")
    # Try Cookie first (Premium speed)
    res = await extract_terabox_with_cookie(url)
    # Then Fallback APIs
    if not res: res = await extract_terabox_api_fallback(url)
    
    if not res or not res.get("dlink"):
        raise Exception("TeraBox extraction failed. Please provide a valid NDUS cookie in .env")

    dlink = res["dlink"]
    title = res.get("title", "video")
    
    # Download
    headers = {**BROWSER_HEADERS}
    cookies = {"ndus": TERABOX_NDUS} if res.get("cookie_mode") else {}
    
    async with aiohttp.ClientSession(headers=headers, cookies=cookies) as session:
        async with session.get(dlink, allow_redirects=True) as resp:
            if resp.status != 200: raise Exception(f"Download failed (HTTP {resp.status})")
            
            fpath = os.path.join(tmp_dir, f"video_{os.getpid()}.mp4")
            async with aiofiles.open(fpath, "wb") as f:
                async for chunk in resp.content.iter_chunked(1024*1024):
                    await f.write(chunk)
            
            valid, reason = validate_video_file(fpath)
            if not valid:
                os.unlink(fpath)
                raise Exception(f"File invalid: {reason}")
            
            return {"path": fpath, "title": title, "size": os.path.getsize(fpath)}

# ── OTHER DOWNLOADS (yt-dlp) ──

async def download_generic(url, tmp_dir):
    output = os.path.join(tmp_dir, "%(title).80s.%(ext)s")
    cmd = ["yt-dlp", "--no-warnings", "-f", "best[ext=mp4]/best", "-o", output, url]
    try:
        def _run():
            return subprocess.run(cmd, capture_output=True, text=True, timeout=1200)

        result = await asyncio.to_thread(_run)
        files = [f for f in os.listdir(tmp_dir) if not f.endswith((".part", ".ytdl"))]
        if result.returncode != 0 or not files:
            detail = (result.stderr or result.stdout or "").strip().splitlines()
            reason = detail[-1][:240] if detail else "download returned no media file"
            if BOT_KIND == "NIGHTHEAST_TO_NIGHTBOX" and "Unsupported URL" in reason:
                raise Exception(
                    "Nightheast share pages open in the app and are not direct download URLs. "
                    "Forward the actual video message to this bot instead."
                )
            raise Exception(f"yt-dlp failed: {reason}")
        fpath = os.path.join(tmp_dir, files[0])
        valid, reason = validate_video_file(fpath)
        if not valid: 
            os.unlink(fpath)
            raise Exception(reason)
        return {"path": fpath, "title": files[0], "size": os.path.getsize(fpath)}
    except Exception as e: raise Exception(f"yt-dlp error: {e}")


async def download_nightheast(url, message_text, tmp_dir):
    """Resolve a Nightheast app link through the authenticated integration API."""
    if not NIGHTHEAST_API_URL or not NIGHTHEAST_INTEGRATION_KEY:
        raise Exception(
            "Nightheast resolver is not configured on the bot. "
            "Set NIGHTHEAST_API_URL and NIGHTHEAST_INTEGRATION_KEY on the VPS."
        )

    video_id = extract_nightheast_video_id(url)
    access_code = extract_access_code(message_text)
    if not access_code:
        parsed = urlparse(url)
        query = parse_qs(parsed.query)
        access_code = (
            (query.get("accessCode") or query.get("access_code") or query.get("code") or [""])[0]
        )
    if not video_id:
        raise Exception("Invalid Nightheast video link.")

    resolver_url = NIGHTHEAST_API_URL
    if not resolver_url.endswith("/resolve"):
        resolver_url = f"{resolver_url}/resolve"
    headers = {
        "X-Nightheast-Integration-Key": NIGHTHEAST_INTEGRATION_KEY,
        "Accept": "application/json",
    }
    # A trusted Nightheast integration may resolve by the share URL alone.
    # Older resolver deployments still require accessCode and will return a
    # clear authorization error instead of silently downloading anything.
    payload = {"videoId": video_id, "accessCode": access_code or NIGHTHEAST_FALLBACK_ACCESS_CODE}

    async def resolve(request_payload):
        async with session.post(resolver_url, json=request_payload, headers=headers) as response:
            try:
                data = await response.json(content_type=None)
            except (aiohttp.ContentTypeError, json.JSONDecodeError):
                body = (await response.text())[:240]
                raise Exception(
                    f"Nightheast resolver returned an invalid response (HTTP {response.status}): {body}"
                )
            return response.status, data

    # Resolver responses should be quick, but the returned media can be large.
    # Keep connection/read timeouts bounded without imposing a 60-second total
    # limit on a multi-gigabyte download.
    async with aiohttp.ClientSession(
        timeout=aiohttp.ClientTimeout(total=900, connect=20, sock_read=60)
    ) as session:
        status, data = await resolve(payload)
        if not isinstance(data, dict):
            raise Exception("Nightheast resolver returned an invalid response object.")

        # A forwarded Nightheast code can be old or belong to a rotated
        # creator-code record. Retry once with the trusted in-house fallback;
        # never loop or hide 404/503 media errors.
        if (
            status == 401
            and access_code
            and NIGHTHEAST_FALLBACK_ACCESS_CODE
            and access_code != NIGHTHEAST_FALLBACK_ACCESS_CODE
        ):
            status, data = await resolve({"videoId": video_id, "accessCode": NIGHTHEAST_FALLBACK_ACCESS_CODE})

        if status >= 300 or data.get("success") is False:
            detail = data.get("error") or data.get("message") or f"HTTP {status}"
            raise Exception(f"Nightheast resolver rejected the link: {str(detail)[:240]}")

        nested = data.get("data") if isinstance(data.get("data"), dict) else {}
        result = data.get("result") if isinstance(data.get("result"), dict) else {}
        download_url = (
            data.get("downloadUrl")
            or data.get("download_url")
            or data.get("videoUrl")
            or data.get("video_url")
            or data.get("mediaUrl")
            or data.get("media_url")
            or data.get("url")
            or nested.get("downloadUrl")
            or nested.get("download_url")
            or nested.get("videoUrl")
            or nested.get("video_url")
            or nested.get("mediaUrl")
            or nested.get("media_url")
            or nested.get("url")
            or result.get("downloadUrl")
            or result.get("download_url")
            or result.get("videoUrl")
            or result.get("video_url")
            or result.get("mediaUrl")
            or result.get("media_url")
            or result.get("url")
        )
        if not download_url or not str(download_url).startswith(("http://", "https://")):
            raise Exception("Nightheast resolver returned no downloadable video URL.")

        title = str(
            data.get("title")
            or nested.get("title")
            or result.get("title")
            or f"nightheast_{video_id}.mp4"
        )
        title = re.sub(r"[^A-Za-z0-9._ -]", "_", os.path.basename(title))[:120] or f"nightheast_{video_id}.mp4"
        if "." not in title:
            title += ".mp4"
        target = os.path.join(tmp_dir, title)
        async with session.get(str(download_url), allow_redirects=True) as media:
            if media.status >= 300:
                raise Exception(f"Nightheast media download failed (HTTP {media.status}).")
            content_length = int(media.headers.get("Content-Length") or 0)
            if content_length > MAX_FILE_SIZE:
                raise Exception("Nightheast video exceeds the 2 GB upload limit.")
            written = 0
            with open(target, "wb") as output:
                async for chunk in media.content.iter_chunked(1024 * 1024):
                    written += len(chunk)
                    if written > MAX_FILE_SIZE:
                        raise Exception("Nightheast video exceeds the 2 GB upload limit.")
                    output.write(chunk)

    valid, reason = validate_video_file(target)
    if not valid:
        if os.path.exists(target):
            os.unlink(target)
        raise Exception(f"Nightheast resolver returned an invalid video: {reason}")
    return {"path": target, "title": title, "size": os.path.getsize(target)}

# ── UPLOAD & PROCESS ──

async def upload_video(fpath, title, chat_id, telegram_id=""):
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=1800)) as session:
        data = aiohttp.FormData()
        with open(fpath, 'rb') as video_file:
            data.add_field('video', video_file, filename=os.path.basename(fpath), content_type='video/mp4')
            data.add_field('title', title)
            headers = backend_headers(chat_id, telegram_id)
            async with session.post(f"{BACKEND_URL}/upload-file", data=data, headers=headers) as resp:
                if resp.status == 200: return await resp.json()
                err = await resp.text()
                raise Exception(f"Upload error: {err[:100]}")

async def import_nightbox_link(url, chat_id, telegram_id=""):
    headers = backend_headers(chat_id, telegram_id)
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=60)) as session:
        async with session.post(f"{BACKEND_URL}/api/creator/import-link", json={"url": url}, headers=headers) as resp:
            data = await resp.json(content_type=None)
            if resp.status >= 300: raise Exception(data.get("error", f"Import error (HTTP {resp.status})"))
            return data

@app.on_message(filters.command("start"))
async def start_command(_, message):
    if AUTO_CREATOR_IDENTITY:
        action = "send a NightBox link to create your own earning link" if BOT_KIND == "NIGHTBOX_TO_NIGHTBOX" else "send a Nightheast link (the access code can be included in the message when required)"
        await message.reply_text(f"{BOT_KIND.replace('_', ' ').title()} is ready. Just {action}.", reply_markup=settings_keyboard())
        return
    action = "send a NightBox link to create your own earning link" if BOT_KIND == "NIGHTBOX_TO_NIGHTBOX" else "send a supported share URL"
    await message.reply_text(
        f"{BOT_KIND.replace('_', ' ').title()} is ready. Connect with /connect nb_live_your_creator_key, then {action}.\n\n"
        "Use the buttons below for text settings, or type the commands manually.", reply_markup=settings_keyboard()
    )


def command_text(message):
    parts = (message.text or "").split(maxsplit=1)
    return parts[1].strip() if len(parts) == 2 else ""


@app.on_message(filters.command("add_header"))
async def add_header_command(_, message):
    value = command_text(message)
    if not value:
        set_pending_text(message.chat.id, "header")
        await message.reply_text("Send the header text in your next message. No command needed.")
        return
    preferences = update_text_preferences(message.chat.id, header=value)
    await message.reply_text(
        f"✅ Header saved for future conversions. Caption text is currently {'ON' if preferences['enabled'] else 'OFF'}.\n"
        "Use `/enable_text` to include the original caption; media stays unchanged."
    )


@app.on_message(filters.command("add_footer"))
async def add_footer_command(_, message):
    value = command_text(message)
    if not value:
        set_pending_text(message.chat.id, "footer")
        await message.reply_text("Send the footer text in your next message. No command needed.")
        return
    preferences = update_text_preferences(message.chat.id, footer=value)
    await message.reply_text(
        f"✅ Footer saved for future conversions. Caption text is currently {'ON' if preferences['enabled'] else 'OFF'}.\n"
        "Use `/enable_text` to include the original caption; media stays unchanged."
    )


@app.on_message(filters.command("remove_header"))
async def remove_header_command(_, message):
    remove_text_preference(message.chat.id, "header")
    await message.reply_text("✅ Header removed.", reply_markup=settings_keyboard())


@app.on_message(filters.command("remove_footer"))
async def remove_footer_command(_, message):
    remove_text_preference(message.chat.id, "footer")
    await message.reply_text("✅ Footer removed.", reply_markup=settings_keyboard())


@app.on_message(filters.command("enable_text"))
async def enable_text_command(_, message):
    preferences = get_text_preferences(message.chat.id)
    if not preferences["header"] and not preferences["footer"]:
        await message.reply_text("⚠️ Add a header or footer first, then use `/enable_text`.")
        return
    update_text_preferences(message.chat.id, enabled=True, link_only=False)
    await message.reply_text("✅ Caption text enabled. Converted media stays unchanged.")


@app.on_message(filters.command("disable_text"))
async def disable_text_command(_, message):
    update_text_preferences(message.chat.id, enabled=False, link_only=True)
    await message.reply_text("✅ Original caption disabled. Media, header/footer and link will remain.")


@app.on_message(filters.command("enable_bold"))
async def enable_bold_command(_, message):
    update_text_preferences(message.chat.id, bold=True)
    await message.reply_text("✅ Bold text enabled for future conversions.", reply_markup=settings_keyboard())


@app.on_message(filters.command("disable_bold"))
async def disable_bold_command(_, message):
    update_text_preferences(message.chat.id, bold=False)
    await message.reply_text("✅ Normal text enabled for future conversions.", reply_markup=settings_keyboard())


@app.on_message(filters.command("text_status"))
async def text_status_command(_, message):
    preferences = get_text_preferences(message.chat.id)
    await message.reply_text(
        "📝 **Caption text settings**\n\n"
        f"Status: {'ON' if preferences['enabled'] else 'OFF'}\n"
        f"Bold: {'ON' if preferences.get('bold') else 'OFF'}\n"
        f"Header: {preferences['header'] or '(not set)'}\n"
        f"Footer: {preferences['footer'] or '(not set)'}"
    )


@app.on_callback_query(filters.regex(r"^nb:"))
async def settings_callback(_, query):
    action = query.data.split(":", 1)[1]
    await query.answer()
    if action == "add_header":
        set_pending_text(query.message.chat.id, "header")
        await query.message.reply_text("Send the header text in your next message.")
    elif action == "add_footer":
        set_pending_text(query.message.chat.id, "footer")
        await query.message.reply_text("Send the footer text in your next message.")
    elif action in {"remove_header", "remove_footer"}:
        remove_text_preference(query.message.chat.id, action.replace("remove_", ""))
        await query.message.reply_text("✅ Removed.", reply_markup=settings_keyboard())
    elif action == "enable_text":
        update_text_preferences(query.message.chat.id, enabled=True, link_only=False)
        await query.message.reply_text("✅ Caption text enabled. Media stays unchanged.", reply_markup=settings_keyboard())
    elif action == "disable_text":
        update_text_preferences(query.message.chat.id, enabled=False, link_only=True)
        await query.message.reply_text("✅ Original caption disabled. Media, header/footer and link will remain.", reply_markup=settings_keyboard())
    elif action == "enable_bold":
        update_text_preferences(query.message.chat.id, bold=True)
        await query.message.reply_text("✅ Bold text enabled.", reply_markup=settings_keyboard())
    elif action == "disable_bold":
        update_text_preferences(query.message.chat.id, bold=False)
        await query.message.reply_text("✅ Normal text enabled.", reply_markup=settings_keyboard())
    elif action == "text_status":
        preferences = get_text_preferences(query.message.chat.id)
        await query.message.reply_text(
            f"📝 Text: {'ON' if preferences['enabled'] else 'OFF'} · Bold: {'ON' if preferences.get('bold') else 'OFF'}\n"
            f"Header: {preferences['header'] or '(not set)'}\nFooter: {preferences['footer'] or '(not set)'}",
            reply_markup=settings_keyboard(),
        )
    elif action == "disconnect":
        remove_creator_key(query.message.chat.id)
        await query.message.reply_text("Disconnected.")


@app.on_message(filters.command("connect"))
async def connect_command(_, message):
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


@app.on_message(filters.text & filters.regex(r"nb_live_[A-Za-z0-9_-]+") & ~filters.command(["start", "status", "connect", "disconnect"]))
async def pasted_key_command(_, message):
    """Accept a pasted creator key, including copied text with labels or whitespace."""
    key = extract_creator_key(message.text or "")
    if not is_full_creator_key(key):
        await message.reply_text(key_help_text())
        return
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(
                f"{BACKEND_URL}/api/creator/bot-identity",
                headers={"X-Bot-Key": key},
                timeout=15,
            ) as response:
                data = await response.json(content_type=None)
                if response.status >= 300:
                    raise RuntimeError(
                        "The key was rejected. Create a fresh API key and use the full one-time value."
                    )
        set_creator_key(message.chat.id, key)
        await message.reply_text(
            f"Connected to creator account {data['user']['email']}. Now send your link or video."
        )
    except Exception as error:
        await message.reply_text(
            f"Connection failed: {str(error)[:200]}\n"
            "Create a fresh key and send /connect followed by the full one-time API key."
        )


@app.on_message(filters.command("disconnect"))
async def disconnect_command(_, message):
    remove_creator_key(message.chat.id)
    await message.reply_text("Disconnected from the creator account.")


@app.on_message((filters.text | filters.media) & ~filters.regex(r"^/"))
async def handle(c, m):
    pending = consume_pending_text(m.chat.id)
    if pending and m.text:
        update_text_preferences(m.chat.id, **{pending: m.text.strip()})
        await m.reply_text(f"✅ {pending.title()} saved. Use `/enable_text` to apply it to future conversions.")
        return
    telegram_id = telegram_user_id(m)
    if not AUTO_CREATOR_IDENTITY and not creator_key(m.chat.id):
        await m.reply_text("Connect your creator account first with /connect nb_live_your_creator_key")
        return
    if AUTO_CREATOR_IDENTITY and not NIGHTBOX_BOT_INTEGRATION_KEY:
        await m.reply_text("This bot is not connected to the NightBox creator directory yet. Please contact support.")
        return
    text = m.text or m.caption or ""
    urls = URL_PATTERN.findall(text)
    tmp = tempfile.mkdtemp()
    has_video_media = bool(m.video or m.document or m.animation)
    if not urls and not has_video_media:
        if BOT_KIND == "NIGHTHEAST_TO_NIGHTBOX":
            await m.reply_text(
                "Send the Nightheast link with its access code, or forward the actual video message."
            )
        return

    status = await m.reply_text(
        "\u23f3 **Processing forwarded video...**" if has_video_media else "\u23f3 **Processing link...**"
    )
    
    try:
        if has_video_media:
            file_name = (
                getattr(m.video, "file_name", None)
                or getattr(m.document, "file_name", None)
                or getattr(m.animation, "file_name", None)
                or f"forwarded_video_{m.id}.mp4"
            )
            file_name = re.sub(r"[^A-Za-z0-9._ -]", "_", os.path.basename(file_name))[:120] or f"forwarded_video_{m.id}.mp4"
            media_path = await m.download(file_name=os.path.join(tmp, file_name))
            valid, reason = validate_video_file(media_path)
            if not valid:
                raise Exception(f"Forwarded media is not a valid video: {reason}")
            info = {"path": media_path, "title": file_name, "size": os.path.getsize(media_path)}
        elif BOT_KIND == "NIGHTBOX_TO_NIGHTBOX":
            # Convert every NightBox link in the message and ignore unrelated URLs.
            valid_urls = []
            ignored = 0
            for candidate in urls:
                parsed = urlparse(candidate)
                if parsed.hostname and parsed.hostname.lower() in {"nightbox.in", "www.nightbox.in", "api.nightbox.in"} and re.fullmatch(r"/(?:l|watch)/[^/]+", parsed.path):
                    valid_urls.append(candidate)
                else:
                    ignored += 1
            if not valid_urls:
                raise Exception("No valid NightBox /l/ or /watch/ link found. Other links were ignored.")
            replacements = {}
            errors = []
            for index, url in enumerate(valid_urls, 1):
                await status.edit_text(f"⏳ Converting NightBox link {index}/{len(valid_urls)}...")
                try:
                    res = await import_nightbox_link(url, m.chat.id, telegram_id)
                    replacement = res.get('link', '')
                    if not replacement:
                        raise Exception("Backend did not return a NightBox link")
                    replacements[url] = replacement
                except Exception as error:
                    errors.append(str(error)[:180])
            if errors:
                await status.edit_text("❌ " + "\n❌ ".join(errors))
                return
            preferences = get_text_preferences(m.chat.id)
            header = preferences.get("header", "").strip()
            footer = preferences.get("footer", "").strip()
            if preferences.get("link_only"):
                converted_text = "\n".join(part for part in [header, *replacements.values(), footer] if part)
            else:
                original_text = m.caption if (m.photo or m.video or m.document or m.animation) else (m.text or "")
                body = original_text
                for source, replacement in replacements.items():
                    body = body.replace(source, replacement)
                converted_text = "\n".join(part for part in [header, body, footer] if part)
            await status.delete()
            if m.photo or m.video or m.document or m.animation:
                await m.copy(chat_id=m.chat.id, caption=converted_text or None)
            else:
                await m.reply_text(converted_text)
            return
        else:
            url = urls[0]
            async with download_semaphore:
                if BOT_KIND == "NIGHTHEAST_TO_NIGHTBOX" and extract_nightheast_video_id(url):
                    await status.edit_text("⏳ Contacting Nightheast resolver and downloading media...")
                    info = await asyncio.wait_for(download_nightheast(url, text, tmp), timeout=900)
                elif any(x in url.lower() for x in ["terabox", "1024"]) and BOT_KIND == "TERABOX":
                    info = await asyncio.wait_for(download_terabox(url, tmp), timeout=1200)
                else:
                    info = await asyncio.wait_for(download_generic(url, tmp), timeout=1200)
            
        await status.edit_text("\u2601 **Uploading to server...**")
        res = await upload_video(info["path"], info["title"], m.chat.id, telegram_id)
        watch = res.get("link") or res.get("watchUrl", "")
        if not watch:
            raise Exception("Backend did not return a NightBox link")

        # Keep the user's original post intact. Replace only the source URL so
        # captions, blank lines, spacing, access codes and surrounding text are
        # returned exactly as they were sent.
        source_text = (
            m.caption
            if (m.photo or m.video or m.document or m.animation)
            else (m.text or "")
        )
        preferences = get_text_preferences(m.chat.id)
        header = preferences.get("header", "").strip()
        footer = preferences.get("footer", "").strip()
        body = source_text.replace(urls[0], watch) if urls else source_text
        if preferences.get("link_only"):
            converted_text = "\n".join(part for part in [header, watch, footer] if part)
        else:
            converted_text = "\n".join(part for part in [header, body or watch, footer] if part)

        await status.delete()
        if m.photo or m.video or m.document or m.animation:
            await m.copy(chat_id=m.chat.id, caption=converted_text or watch)
        else:
            await m.reply_text(converted_text or watch)
    except Exception as e:
        logger.error(e)
        await status.edit_text(f"\u274c **Error:** {str(e)}")
    finally:
        if os.path.exists(tmp): shutil.rmtree(tmp)

if __name__ == "__main__":
    logger.info("Premium Convert Bot starting...")
    register_bot_menu(BOT_TOKEN, convert_commands())
    app.run()
