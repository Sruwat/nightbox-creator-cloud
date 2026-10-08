"""NightBox main Telegram controller bot."""
import os
from dotenv import load_dotenv
from pyrogram import Client, filters

load_dotenv()
TOKEN = os.getenv("TELEGRAM_BOT_TOKEN_MAIN")
API_ID = os.getenv("TELEGRAM_API_ID")
API_HASH = os.getenv("TELEGRAM_API_HASH")
if not TOKEN or not API_ID or not API_HASH:
    raise RuntimeError("TELEGRAM_BOT_TOKEN_MAIN, TELEGRAM_API_ID and TELEGRAM_API_HASH are required")

app = Client("nightbox_main", api_id=int(API_ID), api_hash=API_HASH, bot_token=TOKEN)
services = {
    "Videos Upload": os.getenv("TELEGRAM_USERNAME_VIDEOS_UPLOAD", ""),
    "NightBox to NightBox": os.getenv("TELEGRAM_USERNAME_NIGHTBOX_TO_NIGHTBOX", ""),
    "Nightheast to NightBox": os.getenv("TELEGRAM_USERNAME_NIGHTHEAST_TO_NIGHTBOX", ""),
    "TeraBox": os.getenv("TELEGRAM_USERNAME_TERABOX", ""),
    "Diskwala": os.getenv("TELEGRAM_USERNAME_DISKWALA", ""),
    "FleZin": os.getenv("TELEGRAM_USERNAME_FLEZIN", ""),
    "VidBunker": os.getenv("TELEGRAM_USERNAME_VIDBUNKER", ""),
}


@app.on_message(filters.command("start"))
async def start(_, message):
    lines = ["NightBox services", "", "Choose a service bot by username:", "", "Create a creator API key in Bots & API, then send /connect <key> to the selected service bot."]
    lines.extend(f"{label}: @{username}" if username else f"{label}: not configured" for label, username in services.items())
    await message.reply_text("\n".join(lines))


@app.on_message(filters.command("help"))
async def help_command(_, message):
    await message.reply_text("Send /start to see the configured upload and conversion service bots.")


if __name__ == "__main__":
    app.run()
