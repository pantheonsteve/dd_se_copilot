"""SQLite-backed conversation persistence for the RAG chat interface.

Each agent gets its own SQLite database at data/<agent>/conversations.db.
Stores conversation metadata and individual messages with full history.
"""

import hashlib
import json
import logging
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from config import CONVERSATIONS_DB

logger = logging.getLogger(__name__)

_MAX_TITLE_LENGTH = 60


def _connect() -> sqlite3.Connection:
    CONVERSATIONS_DB.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(CONVERSATIONS_DB))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def _ensure_tables(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS conversations (
            id          TEXT PRIMARY KEY,
            agent       TEXT NOT NULL,
            title       TEXT,
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS messages (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            role            TEXT NOT NULL,
            content         TEXT NOT NULL,
            sources         TEXT,
            elapsed         REAL,
            created_at      TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_messages_conv
            ON messages(conversation_id, id);
    """)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _generate_id() -> str:
    ts = datetime.now(timezone.utc)
    stamp = ts.strftime("%Y%m%d-%H%M%S")
    short_hash = hashlib.sha256(ts.isoformat().encode()).hexdigest()[:6]
    return f"{stamp}-{short_hash}"


def _init() -> sqlite3.Connection:
    conn = _connect()
    _ensure_tables(conn)
    return conn


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def create_conversation(agent_name: str, title: str | None = None) -> str:
    """Create a new conversation and return its ID."""
    conn = _init()
    conv_id = _generate_id()
    now = _now_iso()
    try:
        conn.execute(
            "INSERT INTO conversations (id, agent, title, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (conv_id, agent_name, title, now, now),
        )
        conn.commit()
    finally:
        conn.close()
    return conv_id


def list_conversations() -> list[dict]:
    """Return conversation summaries, most recent first."""
    conn = _init()
    try:
        rows = conn.execute("""
            SELECT c.id, c.title, c.created_at, c.updated_at,
                   COUNT(m.id) AS message_count,
                   (SELECT content FROM messages
                    WHERE conversation_id = c.id AND role = 'user'
                    ORDER BY id LIMIT 1) AS preview
            FROM conversations c
            LEFT JOIN messages m ON m.conversation_id = c.id
            GROUP BY c.id
            ORDER BY c.updated_at DESC
        """).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def get_conversation(conversation_id: str) -> dict | None:
    """Load a conversation with all its messages."""
    conn = _init()
    try:
        row = conn.execute(
            "SELECT * FROM conversations WHERE id = ?",
            (conversation_id,),
        ).fetchone()
        if row is None:
            return None

        conv = dict(row)
        msg_rows = conn.execute(
            "SELECT role, content, sources, elapsed, created_at "
            "FROM messages WHERE conversation_id = ? ORDER BY id",
            (conversation_id,),
        ).fetchall()
        conv["messages"] = [
            {
                **dict(m),
                "sources": json.loads(m["sources"]) if m["sources"] else [],
            }
            for m in msg_rows
        ]
        return conv
    finally:
        conn.close()


def get_recent_messages(conversation_id: str, limit: int = 10) -> list[dict]:
    """Return the last *limit* messages for building LLM context."""
    conn = _init()
    try:
        rows = conn.execute(
            "SELECT role, content FROM messages "
            "WHERE conversation_id = ? ORDER BY id DESC LIMIT ?",
            (conversation_id, limit),
        ).fetchall()
        return [dict(r) for r in reversed(rows)]
    finally:
        conn.close()


def add_message(
    conversation_id: str,
    role: str,
    content: str,
    sources: list[str] | None = None,
    elapsed: float | None = None,
) -> None:
    """Append a message to a conversation and bump updated_at."""
    conn = _init()
    now = _now_iso()
    try:
        conn.execute(
            "INSERT INTO messages (conversation_id, role, content, sources, elapsed, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (conversation_id, role, content,
             json.dumps(sources) if sources else None,
             elapsed, now),
        )
        conn.execute(
            "UPDATE conversations SET updated_at = ? WHERE id = ?",
            (now, conversation_id),
        )
        conn.commit()
    finally:
        conn.close()


def auto_title(conversation_id: str) -> str | None:
    """Set the conversation title from the first user message if no title exists."""
    conn = _init()
    try:
        row = conn.execute(
            "SELECT title FROM conversations WHERE id = ?",
            (conversation_id,),
        ).fetchone()
        if row is None or row["title"]:
            return row["title"] if row else None

        msg = conn.execute(
            "SELECT content FROM messages "
            "WHERE conversation_id = ? AND role = 'user' ORDER BY id LIMIT 1",
            (conversation_id,),
        ).fetchone()
        if msg is None:
            return None

        title = msg["content"].strip()
        if len(title) > _MAX_TITLE_LENGTH:
            title = title[:_MAX_TITLE_LENGTH].rsplit(" ", 1)[0] + "..."

        conn.execute(
            "UPDATE conversations SET title = ? WHERE id = ?",
            (title, conversation_id),
        )
        conn.commit()
        return title
    finally:
        conn.close()


def update_title(conversation_id: str, title: str) -> bool:
    """Manually set a conversation title. Returns False if conversation not found."""
    conn = _init()
    try:
        cur = conn.execute(
            "UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?",
            (title, _now_iso(), conversation_id),
        )
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def delete_conversation(conversation_id: str) -> bool:
    """Delete a conversation and all its messages. Returns False if not found."""
    conn = _init()
    try:
        cur = conn.execute(
            "DELETE FROM conversations WHERE id = ?",
            (conversation_id,),
        )
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()
