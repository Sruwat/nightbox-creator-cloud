"""Telegram command-menu registration shared by the NightBox bots."""

import json
import logging
from urllib.request import Request, urlopen

log = logging.getLogger("nightbox-bot-menu")


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
            {"command": "enable_text", "description": "Enable text overlay"},
            {"command": "disable_text", "description": "Disable text overlay"},
            {"command": "text_status", "description": "Show text settings"},
        ])
    commands.append({"command": "disconnect", "description": "Disconnect creator account"})
    return commands


def convert_commands():
    return [
        {"command": "start", "description": "Start converter"},
        {"command": "connect", "description": "Connect creator account"},
        {"command": "add_header", "description": "Add text above links"},
        {"command": "add_footer", "description": "Add text below links"},
        {"command": "enable_text", "description": "Enable text overlay"},
        {"command": "disable_text", "description": "Disable text overlay"},
        {"command": "text_status", "description": "Show text settings"},
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
        {"command": "enable_text", "description": "Enable text overlay"},
        {"command": "disable_text", "description": "Disable text overlay"},
        {"command": "text_status", "description": "Show text settings"},
        {"command": "disconnect", "description": "Disconnect creator account"},
    ]
