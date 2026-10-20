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
from bot_menu import register_bot_menu, service_commands, settings_keyboard

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
NIGHTBOX_BOT_INTEGRATION_KEY = os.getenv("NIGHTBOX_BOT_INTEGRATION_KEY", "")
MAX_URL_LENGTH = 2048
URL_RE = re.compile(r"https?://[^\s<>\"']+", re.IGNORECASE)
CREATOR_KEY_RE = re.compile(r"nb_live_[A-Za-z0-9_-]+")

if not TOKEN or not API_ID or not API_HASH:
    raise RuntimeError(f"Missing Telegram configuration for {KIND}")


def extract_creator_key(text):
    """Accept a complete key directly or embedded in copied/labelled text."""
    match = CREATOR_KEY_RE.search(text or "")
    return match.group(0) if match else ""

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


def telegram_user_id(message):
    sender = getattr(message, "from_user", None)
    value = getattr(sender, "id", None)
    return str(value) if value is not None else ""


async def link_telegram_creator(session, message, key):
    """Link the verified Telegram sender after the creator key is validated."""
    if KIND != "CONNECTION" or not NIGHTBOX_BOT_INTEGRATION_KEY:
        return False
    telegram_id = telegram_user_id(message)
    if not telegram_id:
        return False
    response = await session.post(
        f"{BACKEND_URL}/api/creator/telegram-link",
        headers={
            "X-Bot-Key": key,
            "X-NightBox-Bot-Key": NIGHTBOX_BOT_INTEGRATION_KEY,
            "X-Telegram-User-ID": telegram_id,
        },
        timeout=15,
    )
    data = await response.json(content_type=None)
    if response.status >= 300:
        raise RuntimeError(data.get("error", f"Telegram linking failed (HTTP {response.status})"))
    return True


async def connected_creator(session, chat_id):
    """Return the currently linked creator only when the stored key is valid."""
    key = key_for(chat_id)
    if not key:
        return None
    try:
        async with session.get(
            f"{BACKEND_URL}/api/creator/bot-identity",
            headers={"X-Bot-Key": key},
            timeout=10,
        ) as response:
            if response.status >= 300:
                return None
            data = await response.json(content_type=None)
            return data.get("user")
    except Exception:
        return None


@app.on_message(filters.command("start"))
async def start(_, message):
    if KIND == "CONNECTION":
        async with aiohttp.ClientSession() as session:
            user = await connected_creator(session, message.chat.id)
        if user:
            await message.reply_text(
                f"✅ Already connected to creator account {user['email']}.\n\n"
                "Your Telegram account is linked for automatic bot access.\n"
                "Use the matching NightBox service bot to upload or convert content.", reply_markup=settings_keyboard()
            )
            return
        await message.reply_text(f"{LABEL} is ready. Connect your creator account with /connect nb_live_your_creator_key.")
        return
    await message.reply_text(f"{LABEL} is ready. Send one or more supported remote video URLs to create NightLinks.", reply_markup=settings_keyboard())


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
            linked = await link_telegram_creator(session, message, key)
        set_creator_key(message.chat.id, key)
        suffix = " Telegram account linked for automatic bot access." if linked else ""
        await message.reply_text(f"Connected to creator account {data['user']['email']} for {LABEL}.{suffix}")
    except Exception as error:
        await message.reply_text(f"Connection failed: {str(error)[:200]}")


@app.on_message(filters.text & filters.regex(r"nb_live_[A-Za-z0-9_-]+") & ~filters.command(["start", "status", "connect", "disconnect"]))
async def pasted_key(_, message):
    """Accept a full key pasted after a standalone /connect message."""
    match = re.search(r"nb_live_[A-Za-z0-9_-]+", message.text or "")
    key = match.group(0) if match else ""
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
            linked = await link_telegram_creator(session, message, key)
        set_creator_key(message.chat.id, key)
        suffix = " Telegram account linked for automatic bot access." if linked else ""
        await message.reply_text(f"Connected to creator account {data['user']['email']} for {LABEL}.{suffix}")
    except Exception as error:
        await message.reply_text(
            f"Connection failed: {str(error)[:200]}\n"
            "Create a fresh key and send /connect followed by the full one-time API key."
        )


@app.on_message(filters.command("disconnect"))
async def disconnect(_, message):
    remove_creator_key(message.chat.id)
    await message.reply_text(f"Disconnected from {LABEL}.")


def command_text(message):
    parts = (message.text or "").split(maxsplit=1)
    return parts[1].strip() if len(parts) == 2 else ""


@app.on_message(filters.command("add_header"))
async def add_header(_, message):
    value = command_text(message)
    if not value:
        set_pending_text(message.chat.id, "header")
        await message.reply_text("Send the header text in your next message. No command needed.")
        return
    preferences = update_text_preferences(message.chat.id, header=value)
    await message.reply_text(
        f"✅ Header saved. Text overlay is currently {'ON' if preferences['enabled'] else 'OFF'}.\n"
        "Use `/enable_text`, then send the video in NightBox Upload."
    )


@app.on_message(filters.command("add_footer"))
async def add_footer(_, message):
    value = command_text(message)
    if not value:
        set_pending_text(message.chat.id, "footer")
        await message.reply_text("Send the footer text in your next message. No command needed.")
        return
    preferences = update_text_preferences(message.chat.id, footer=value)
    await message.reply_text(
        f"✅ Footer saved. Text overlay is currently {'ON' if preferences['enabled'] else 'OFF'}.\n"
        "Use `/enable_text`, then send the video in NightBox Upload.", reply_markup=settings_keyboard()
    )


@app.on_message(filters.command("remove_header"))
async def remove_header(_, message):
    remove_text_preference(message.chat.id, "header")
    await message.reply_text("✅ Header removed.", reply_markup=settings_keyboard())


@app.on_message(filters.command("remove_footer"))
async def remove_footer(_, message):
    remove_text_preference(message.chat.id, "footer")
    await message.reply_text("✅ Footer removed.", reply_markup=settings_keyboard())


@app.on_message(filters.command("enable_text"))
async def enable_text(_, message):
    preferences = get_text_preferences(message.chat.id)
    if not preferences["header"] and not preferences["footer"]:
        await message.reply_text("⚠️ Add a header or footer first, then use `/enable_text`.")
        return
    update_text_preferences(message.chat.id, enabled=True)
    await message.reply_text("✅ Text overlay enabled for your next uploads/conversions.")


@app.on_message(filters.command("disable_text"))
async def disable_text(_, message):
    update_text_preferences(message.chat.id, enabled=False)
    await message.reply_text("✅ Text overlay disabled. Existing videos are unchanged.")


@app.on_message(filters.command("enable_bold"))
async def enable_bold(_, message):
    update_text_preferences(message.chat.id, bold=True)
    await message.reply_text("✅ Bold text enabled.", reply_markup=settings_keyboard())


@app.on_message(filters.command("disable_bold"))
async def disable_bold(_, message):
    update_text_preferences(message.chat.id, bold=False)
    await message.reply_text("✅ Normal text enabled.", reply_markup=settings_keyboard())


@app.on_message(filters.command("text_status"))
async def text_status(_, message):
    preferences = get_text_preferences(message.chat.id)
    await message.reply_text(
        "📝 **Text overlay settings**\n\n"
        f"Status: {'ON' if preferences['enabled'] else 'OFF'}\n"
        f"Bold: {'ON' if preferences.get('bold') else 'OFF'}\n"
        f"Header: {preferences['header'] or '(not set)'}\n"
        f"Footer: {preferences['footer'] or '(not set)'}"
    )


@app.on_callback_query(filters.regex(r"^nb:"))
async def settings_callback(_, query):
    action = query.data.split(":", 1)[1]
    await query.answer()
    chat_id = query.message.chat.id
    if action in {"add_header", "add_footer"}:
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


@app.on_message(filters.text & ~filters.command(["start", "status", "connect", "disconnect"]))
async def remote_upload(_, message):
    pending = consume_pending_text(message.chat.id)
    if pending:
        update_text_preferences(message.chat.id, **{pending: (message.text or "").strip()})
        await message.reply_text(f"✅ {pending.title()} saved. Use `/enable_text` to apply it to future uploads.")
        return
    if KIND == "CONNECTION":
        await message.reply_text(
            "This is the account-connection bot. Your /connect is handled here.\n\n"
            "Use the matching service bot next:\n"
            "• NightBox Upload — send a video file\n"
            "• NightBox to NightBox — send a NightBox link\n"
            "• Nightheast to NightBox — send a Nightheast link plus access code"
        )
        return
    if not key_for(message.chat.id):
        await message.reply_text("Connect your creator account first with /connect nb_live_your_creator_key")
        return
    urls = [url[:MAX_URL_LENGTH] for url in URL_RE.findall(message.text or "")]
    if not urls:
        await message.reply_text("Send one or more http(s) video URLs.")
        return
    progress = await message.reply_text(f"Processing {len(urls)} link(s) with {LABEL}...")
    results = []
    async with aiohttp.ClientSession() as session:
        for index, url in enumerate(urls, start=1):
            try:
                payload = {"url": url, "title": f"{LABEL} upload"}
                async with session.post(f"{BACKEND_URL}/upload-from-url", json=payload, headers=headers(message.chat.id), timeout=3600) as response:
                    data = await response.json(content_type=None)
                    if response.status >= 300:
                        raise RuntimeError(data.get("error", f"HTTP {response.status}"))
                link = data.get("link") or data.get("watchUrl")
                results.append(f"✅ {index}. {link or 'Processing in dashboard'}")
            except Exception as error:
                log.exception("service upload failed")
                results.append(f"❌ {index}. {str(error)[:180]}")
    await progress.edit_text("\n".join(results))


if __name__ == "__main__":
    register_bot_menu(TOKEN, service_commands(KIND))
    app.run()
