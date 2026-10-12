"""Shared, permission-restricted creator-key storage for NightBox bots."""
import os
import re
import sqlite3
from contextlib import closing
from pathlib import Path


STATE_DIR = Path(os.getenv("TELEGRAM_STATE_DIR", "./state"))
DB_PATH = STATE_DIR / "creator_keys.sqlite3"
FULL_KEY_MIN_LENGTH = 30


def is_full_creator_key(value):
    """Return True for a complete creator secret, not a dashboard prefix."""
    return bool(
        value
        and len(value) >= FULL_KEY_MIN_LENGTH
        and re.fullmatch(r"nb_live_[A-Za-z0-9_-]+", value)
    )


def key_help_text():
    return (
        "This is a key prefix, not the complete API key. Open Bots & API, "
        "create a new key, then copy the full ONE-TIME API KEY or the full "
        "Copy connect command."
    )


def _connection():
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    try:
        STATE_DIR.chmod(0o700)
    except OSError:
        pass
    connection = sqlite3.connect(DB_PATH, timeout=15)
    connection.execute("PRAGMA busy_timeout = 15000")
    connection.execute(
        "CREATE TABLE IF NOT EXISTS creator_keys (chat_id TEXT PRIMARY KEY, api_key TEXT NOT NULL)"
    )
    connection.execute(
        "CREATE TABLE IF NOT EXISTS text_preferences ("
        "chat_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, "
        "header TEXT NOT NULL DEFAULT '', footer TEXT NOT NULL DEFAULT ''"
        ")"
    )
    connection.commit()
    try:
        DB_PATH.chmod(0o600)
    except OSError:
        pass
    return connection


def get_creator_key(chat_id):
    with closing(_connection()) as connection:
        with connection:
            row = connection.execute(
                "SELECT api_key FROM creator_keys WHERE chat_id = ?", (str(chat_id),)
            ).fetchone()
    return row[0] if row else ""


def set_creator_key(chat_id, api_key):
    with closing(_connection()) as connection:
        with connection:
            connection.execute(
                "INSERT INTO creator_keys(chat_id, api_key) VALUES(?, ?) "
                "ON CONFLICT(chat_id) DO UPDATE SET api_key = excluded.api_key",
                (str(chat_id), api_key),
            )


def remove_creator_key(chat_id):
    with closing(_connection()) as connection:
        with connection:
            connection.execute("DELETE FROM creator_keys WHERE chat_id = ?", (str(chat_id),))


def get_text_preferences(chat_id):
    with closing(_connection()) as connection:
        row = connection.execute(
            "SELECT enabled, header, footer FROM text_preferences WHERE chat_id = ?",
            (str(chat_id),),
        ).fetchone()
    if not row:
        return {"enabled": False, "header": "", "footer": ""}
    return {"enabled": bool(row[0]), "header": row[1] or "", "footer": row[2] or ""}


def update_text_preferences(chat_id, *, enabled=None, header=None, footer=None):
    current = get_text_preferences(chat_id)
    values = {
        "enabled": current["enabled"] if enabled is None else bool(enabled),
        "header": current["header"] if header is None else str(header),
        "footer": current["footer"] if footer is None else str(footer),
    }
    with closing(_connection()) as connection:
        with connection:
            connection.execute(
                "INSERT INTO text_preferences(chat_id, enabled, header, footer) VALUES(?,?,?,?) "
                "ON CONFLICT(chat_id) DO UPDATE SET enabled=excluded.enabled, "
                "header=excluded.header, footer=excluded.footer",
                (str(chat_id), int(values["enabled"]), values["header"], values["footer"]),
            )
    return values
