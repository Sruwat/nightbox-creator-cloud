"""Telegram command-menu registration shared by the NightBox bots."""

import json
import logging
from urllib.request import Request, urlopen

log = logging.getLogger("nightbox-bot-menu")


def settings_keyboard():
    """Common inline controls so users do not need to type commands."""
    try:
        from pyrogram.types import InlineKeyboardButton, InlineKeyboardMarkup
        return InlineKeyboardMarkup([
            [InlineKeyboardButton("➕ Header", callback_data="nb:add_header"), InlineKeyboardButton("➕ Footer", callback_data="nb:add_footer")],
            [InlineKeyboardButton("🗑 Remove header", callback_data="nb:remove_header"), InlineKeyboardButton("🗑 Remove footer", callback_data="nb:remove_footer")],
            [InlineKeyboardButton("✅ Text ON", callback_data="nb:enable_text"), InlineKeyboardButton("🚫 Text OFF", callback_data="nb:disable_text")],
            [InlineKeyboardButton("𝗕 Bold ON", callback_data="nb:enable_bold"), InlineKeyboardButton("Normal text", callback_data="nb:disable_bold")],
            [InlineKeyboardButton("ℹ️ Text status", callback_data="nb:text_status"), InlineKeyboardButton("🔌 Disconnect", callback_data="nb:disconnect")],
        ])
    except Exception:
        return None


def register_bot_menu(token, commands):
    if not token:
        return
    request = Request(
        f"https://api.telegram.org/bot{token}/setMyCommands",
        data=json.dumps({"commands": commands}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=15) as response:
            result = json.loads(response.read().decode("utf-8"))
        if not result.get("ok"):
            raise RuntimeError(result.get("description", "Telegram rejected menu"))
    except Exception as error:
        log.warning("Telegram command menu registration failed: %s", error)


def service_commands(kind):
    commands = [
        {"command": "start", "description": "Start NightBox"},
        {"command": "status", "description": "Check bot status"},
        {"command": "connect", "description": "Connect creator account"},
    ]
    if kind != "CONNECTION":
        commands.extend([
            {"command": "add_header", "description": "Add text above links"},
            {"command": "add_footer", "description": "Add text below links"},
            {"command": "remove_header", "description": "Remove header text"},
            {"command": "remove_footer", "description": "Remove footer text"},
            {"command": "enable_text", "description": "Include original caption text"},
            {"command": "disable_text", "description": "Return media and link only"},
            {"command": "enable_bold", "description": "Use bold caption text"},
            {"command": "disable_bold", "description": "Use normal caption text"},
            {"command": "text_status", "description": "Show caption settings"},
        ])
    commands.append({"command": "disconnect", "description": "Disconnect creator account"})
    return commands


def convert_commands():
    return [
        {"command": "start", "description": "Start converter"},
        {"command": "connect", "description": "Connect creator account"},
        {"command": "add_header", "description": "Add text above links"},
        {"command": "add_footer", "description": "Add text below links"},
        {"command": "remove_header", "description": "Remove header text"},
        {"command": "remove_footer", "description": "Remove footer text"},
        {"command": "enable_text", "description": "Include original caption text"},
        {"command": "disable_text", "description": "Return media and link only"},
        {"command": "enable_bold", "description": "Use bold caption text"},
        {"command": "disable_bold", "description": "Use normal caption text"},
        {"command": "text_status", "description": "Show caption settings"},
        {"command": "disconnect", "description": "Disconnect creator account"},
    ]


def upload_commands():
    return [
        {"command": "start", "description": "Start upload bot"},
        {"command": "help", "description": "Show upload instructions"},
        {"command": "connect", "description": "Connect creator account"},
        {"command": "status", "description": "Check upload status"},
        {"command": "add_header", "description": "Add text above links"},
        {"command": "add_footer", "description": "Add text below links"},
        {"command": "remove_header", "description": "Remove header text"},
        {"command": "remove_footer", "description": "Remove footer text"},
        {"command": "enable_text", "description": "Include original caption text"},
        {"command": "disable_text", "description": "Return media and link only"},
        {"command": "enable_bold", "description": "Use bold caption text"},
        {"command": "disable_bold", "description": "Use normal caption text"},
        {"command": "text_status", "description": "Show caption settings"},
        {"command": "disconnect", "description": "Disconnect creator account"},
    ]
