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
from urllib.parse import urlparse
from dotenv import load_dotenv
from pyrogram import Client, filters
from pyrogram.types import Message, InlineKeyboardMarkup, InlineKeyboardButton
from creator_keys import get_creator_key, is_full_creator_key, key_help_text, remove_creator_key, set_creator_key

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
    if not video_id:
        raise Exception("Invalid Nightheast video link.")
    if not access_code:
        raise Exception("Nightheast access code is required. Send the link with 'Access code: 123456'.")

    resolver_url = NIGHTHEAST_API_URL
    if not resolver_url.endswith("/resolve"):
        resolver_url = f"{resolver_url}/resolve"
    headers = {
        "X-Nightheast-Integration-Key": NIGHTHEAST_INTEGRATION_KEY,
        "Accept": "application/json",
    }
    payload = {"videoId": video_id, "accessCode": access_code}

    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=60)) as session:
        async with session.post(resolver_url, json=payload, headers=headers) as response:
            try:
                data = await response.json(content_type=None)
            except (aiohttp.ContentTypeError, json.JSONDecodeError):
                body = (await response.text())[:240]
                raise Exception(
                    f"Nightheast resolver returned an invalid response (HTTP {response.status}): {body}"
                )
            if not isinstance(data, dict):
                raise Exception("Nightheast resolver returned an invalid response object.")
            if response.status >= 300 or data.get("success") is False:
                detail = data.get("error") or data.get("message") or f"HTTP {response.status}"
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

async def upload_video(fpath, title, chat_id):
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=1800)) as session:
        data = aiohttp.FormData()
        with open(fpath, 'rb') as video_file:
            data.add_field('video', video_file, filename=os.path.basename(fpath), content_type='video/mp4')
            data.add_field('title', title)
            headers = {"X-Bot-Name": BOT_NAME, "X-Bot-External-ID": str(chat_id)}
            key = creator_key(chat_id)
            if key:
                headers["X-Bot-Key"] = key
            async with session.post(f"{BACKEND_URL}/upload-file", data=data, headers=headers) as resp:
                if resp.status == 200: return await resp.json()
                err = await resp.text()
                raise Exception(f"Upload error: {err[:100]}")

async def import_nightbox_link(url, chat_id):
    headers = {"X-Bot-Name": BOT_NAME, "X-Bot-External-ID": str(chat_id), "X-Bot-Key": creator_key(chat_id)}
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=60)) as session:
        async with session.post(f"{BACKEND_URL}/api/creator/import-link", json={"url": url}, headers=headers) as resp:
            data = await resp.json(content_type=None)
            if resp.status >= 300: raise Exception(data.get("error", f"Import error (HTTP {resp.status})"))
            return data

@app.on_message(filters.command("start"))
async def start_command(_, message):
    action = "send a NightBox link to create your own earning link" if BOT_KIND == "NIGHTBOX_TO_NIGHTBOX" else "send a supported share URL"
    await message.reply_text(f"{BOT_KIND.replace('_', ' ').title()} is ready. Connect with /connect nb_live_your_creator_key, then {action}.")


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
    if not creator_key(m.chat.id):
        await m.reply_text("Connect your creator account first with /connect nb_live_your_creator_key")
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
            url = urls[0]
            res = await import_nightbox_link(url, m.chat.id)
            await status.edit_text(f"✅ **NightBox link added to your dashboard!**\n\n🔗 `{res.get('link', '')}`")
            return
        else:
            url = urls[0]
            async with download_semaphore:
                if BOT_KIND == "NIGHTHEAST_TO_NIGHTBOX" and extract_nightheast_video_id(url):
                    info = await download_nightheast(url, text, tmp)
                elif any(x in url.lower() for x in ["terabox", "1024"]) and BOT_KIND == "TERABOX":
                    info = await download_terabox(url, tmp)
                else:
                    info = await download_generic(url, tmp)
            
        await status.edit_text("\u2601 **Uploading to server...**")
        res = await upload_video(info["path"], info["title"], m.chat.id)
        watch = res.get("link") or res.get("watchUrl", "")
            
        kb = InlineKeyboardMarkup([[InlineKeyboardButton("▶️ Watch Online", url=watch)]])
        await m.reply_text(f"\u2705 **Conversion Success!**\n📏 {round(info['size']/1048576,1)} MB\n🔗 **Your earning link:** `{watch}`", reply_markup=kb)
        await status.delete()
    except Exception as e:
        logger.error(e)
        await status.edit_text(f"\u274c **Error:** {str(e)}")
    finally:
        if os.path.exists(tmp): shutil.rmtree(tmp)

if __name__ == "__main__":
    logger.info("Premium Convert Bot starting...")
    app.run()
