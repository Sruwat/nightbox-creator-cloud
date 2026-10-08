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
from creator_keys import get_creator_key, remove_creator_key, set_creator_key

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

# --- CRITICAL: TERABOX COOKIE ---
TERABOX_NDUS = os.getenv("TERABOX_NDUS") # Get this from your browser cookies

MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024
MAX_CONCURRENT_DOWNLOADS = 3
MIN_VIDEO_SIZE = 300_000

download_semaphore = asyncio.Semaphore(MAX_CONCURRENT_DOWNLOADS)
URL_PATTERN = re.compile(r'https?://[^\s<>"\')\]]+', re.IGNORECASE)

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
        def _run(): return subprocess.run(cmd, capture_output=True, text=True, timeout=1200)
        await asyncio.to_thread(_run)
        files = [f for f in os.listdir(tmp_dir) if not f.endswith((".part", ".ytdl"))]
        if not files: raise Exception("yt-dlp failed")
        fpath = os.path.join(tmp_dir, files[0])
        valid, reason = validate_video_file(fpath)
        if not valid: 
            os.unlink(fpath)
            raise Exception(reason)
        return {"path": fpath, "title": files[0], "size": os.path.getsize(fpath)}
    except Exception as e: raise Exception(f"yt-dlp error: {e}")

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
    parts = (message.text or "").split(maxsplit=1)
    key = parts[1].strip() if len(parts) == 2 else ""
    if not key.startswith("nb_live_"):
        await message.reply_text("Use /connect nb_live_your_creator_key")
        return
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(f"{BACKEND_URL}/api/creator/bot-identity", headers={"X-Bot-Key": key}, timeout=15) as response:
                data = await response.json(content_type=None)
                if response.status >= 300:
                    raise RuntimeError(data.get("error", f"HTTP {response.status}"))
        set_creator_key(message.chat.id, key)
        await message.reply_text(f"Connected to creator account {data['user']['email']}.")
    except Exception as error:
        await message.reply_text(f"Connection failed: {str(error)[:200]}")


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
    if not urls: return
    
    url = urls[0]
    status = await m.reply_text("\u23f3 **Processing link...**")
    tmp = tempfile.mkdtemp()
    
    try:
        if BOT_KIND == "NIGHTBOX_TO_NIGHTBOX":
            res = await import_nightbox_link(url, m.chat.id)
            await status.edit_text(f"✅ **NightBox link added to your dashboard!**\n\n🔗 `{res.get('link', '')}`")
            return
        async with download_semaphore:
            if any(x in url.lower() for x in ["terabox", "1024"]) and BOT_KIND == "TERABOX":
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
