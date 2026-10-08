"""Shared, permission-restricted creator-key storage for NightBox bots."""
import os
import sqlite3
from contextlib import closing
from pathlib import Path


STATE_DIR = Path(os.getenv("TELEGRAM_STATE_DIR", "./state"))
DB_PATH = STATE_DIR / "creator_keys.sqlite3"


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
