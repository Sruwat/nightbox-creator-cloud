import os
from dotenv import load_dotenv
from pyrogram import Client, filters
import logging

# Set up logging
logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO
)
logger = logging.getLogger(__name__)

# Load environment variables
load_dotenv()

API_ID = os.getenv("TELEGRAM_API_ID_HIDER")
API_HASH = os.getenv("TELEGRAM_API_HASH_HIDER")
BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN_HIDER")

if not all([API_ID, API_HASH, BOT_TOKEN]):
    logger.error("Missing required environment variables. Please set TELEGRAM_API_ID_HIDER, TELEGRAM_API_HASH_HIDER, and TELEGRAM_BOT_TOKEN_HIDER in .env")
    exit(1)

# Initialize bot
app = Client(
    "hider_bot",
    api_id=API_ID,
    api_hash=API_HASH,
    bot_token=BOT_TOKEN
)

@app.on_message(filters.group & (filters.new_chat_members | filters.left_chat_member | filters.service))
async def delete_join_leave_messages(client, message):
    """
    Deletes service messages including 'joined via invite link'.
    """
    try:
        await message.delete()
        logger.info(f"Deleted service/join/leave message in chat: {message.chat.title} ({message.chat.id})")
    except Exception as e:
        logger.error(f"Failed to delete message in chat {message.chat.id}: {e}")

@app.on_message(filters.command("start") & filters.private)
async def start_command(client, message):
    await message.reply_text(
        "Hello! I am a Join/Leave Hider Bot.\n"
        "Add me to your group and give me 'Delete Messages' admin rights, "
        "and I will automatically hide all join and leave service messages!"
    )

if __name__ == "__main__":
    logger.info("Starting Join/Leave Hider Bot...")
    app.run()
