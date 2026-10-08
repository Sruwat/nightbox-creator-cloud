"""NightBox remote-source service bot.

Run one instance per service by setting BOT_KIND, BOT_LABEL and its token in
the environment. Every upload is attributed through CREATOR_API_KEY.
"""
import asyncio
import json
import logging
import os
import re
import tempfile
from pathlib import Path

import aiohttp
from dotenv import load_dotenv
from pyrogram import Client, filters
from creator_keys import get_creator_key, remove_creator_key, set_creator_key

load_dotenv()
logging.basicConfig(format="%(asctime)s %(levelname)s %(message)s", level=logging.INFO)
log = logging.getLogger("nightbox-service-bot")

KIND = os.getenv("BOT_KIND", "service").upper().replace("-", "_")
LABEL = os.getenv("BOT_LABEL", KIND.title())
TOKEN = os.getenv(f"TELEGRAM_BOT_TOKEN_{KIND}") or os.getenv("TELEGRAM_BOT_TOKEN_SERVICE")
API_ID = os.getenv("TELEGRAM_API_ID")
API_HASH = os.getenv("TELEGRAM_API_HASH")
BACKEND_URL = os.getenv("BACKEND_URL", "http://localhost:3000").rstrip("/")
CREATOR_API_KEY = os.getenv("CREATOR_API_KEY", "")
REQUIRE_CONNECT = os.getenv("TELEGRAM_REQUIRE_CONNECT", "true").lower() == "true"
MAX_URL_LENGTH = 2048
URL_RE = re.compile(r"https?://[^\s<>\"']+", re.IGNORECASE)

if not TOKEN or not API_ID or not API_HASH:
    raise RuntimeError(f"Missing Telegram configuration for {KIND}")

app = Client(f"nightbox_{KIND.lower()}", api_id=int(API_ID), api_hash=API_HASH, bot_token=TOKEN)


def key_for(chat_id):
    key = get_creator_key(chat_id)
    if key:
        return key
    return "" if REQUIRE_CONNECT else CREATOR_API_KEY


def headers(chat_id):
    result = {"X-Bot-Name": KIND.lower()}
    key = key_for(chat_id)
    if key:
        result["X-Bot-Key"] = key
    result["X-Bot-External-ID"] = str(chat_id)
    return result


@app.on_message(filters.command("start"))
async def start(_, message):
    if KIND == "CONNECTION":
        await message.reply_text(f"{LABEL} is ready. Connect your creator account with /connect nb_live_your_creator_key.")
        return
    await message.reply_text(f"{LABEL} is ready. Send a supported remote video URL to create a NightLink.")


@app.on_message(filters.command("status"))
async def status(_, message):
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(f"{BACKEND_URL}/health", timeout=10) as response:
                await message.reply_text(f"{LABEL}: backend HTTP {response.status}")
    except Exception:
        await message.reply_text(f"{LABEL}: backend unavailable")


@app.on_message(filters.command("connect"))
async def connect(_, message):
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
        await message.reply_text(f"Connected to creator account {data['user']['email']} for {LABEL}.")
    except Exception as error:
        await message.reply_text(f"Connection failed: {str(error)[:200]}")


@app.on_message(filters.command("disconnect"))
async def disconnect(_, message):
    remove_creator_key(message.chat.id)
    await message.reply_text(f"Disconnected from {LABEL}.")


@app.on_message(filters.text & ~filters.command(["start", "status", "connect", "disconnect"]))
async def remote_upload(_, message):
    if KIND == "CONNECTION":
        await message.reply_text("Use /connect to link your creator account. This bot is for account connection only.")
        return
    if not key_for(message.chat.id):
        await message.reply_text("Connect your creator account first with /connect nb_live_your_creator_key")
        return
    match = URL_RE.search(message.text or "")
    if not match:
        await message.reply_text("Send one http(s) video URL.")
        return
    url = match.group(0)[:MAX_URL_LENGTH]
    progress = await message.reply_text(f"Processing with {LABEL}...")
    try:
        payload = {"url": url, "title": f"{LABEL} upload"}
        async with aiohttp.ClientSession() as session:
            async with session.post(f"{BACKEND_URL}/upload-from-url", json=payload, headers=headers(message.chat.id), timeout=3600) as response:
                data = await response.json(content_type=None)
                if response.status >= 300:
                    raise RuntimeError(data.get("error", f"HTTP {response.status}"))
        link = data.get("link") or data.get("watchUrl")
        await progress.edit_text(f"Upload complete.\n\n{link or 'Video is processing; check your dashboard.'}")
    except Exception as error:
        log.exception("service upload failed")
        await progress.edit_text(f"Upload failed: {str(error)[:300]}")


if __name__ == "__main__":
    app.run()
