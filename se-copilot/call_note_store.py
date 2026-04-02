"""SQLite persistence for call notes and their AI-generated summaries."""

import hashlib
import logging
import sqlite3
from datetime import datetime, timezone

from config import settings

logger = logging.getLogger(__name__)

_CREATE_CALL_NOTES = """\
CREATE TABLE IF NOT EXISTS call_notes (
    id                TEXT PRIMARY KEY,
    created_at        TEXT NOT NULL,
    title             TEXT DEFAULT '',
    company_id        TEXT DEFAULT '',
    company_name      TEXT DEFAULT '',
    raw_transcript    TEXT NOT NULL,
    summary_markdown  TEXT DEFAULT '',
    processing_time_ms INTEGER DEFAULT 0
)"""


def _get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(settings.call_notes_db))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    conn = _get_conn()
    try:
        conn.execute(_CREATE_CALL_NOTES)
        conn.commit()
    finally:
        conn.close()
    logger.info("Call Notes DB initialized at %s", settings.call_notes_db)


init_db()


def _generate_id() -> str:
    ts = datetime.now(timezone.utc)
    stamp = ts.strftime("%Y%m%d-%H%M%S")
    short_hash = hashlib.sha256(ts.isoformat().encode()).hexdigest()[:4]
    return f"{stamp}-{short_hash}"


def save_call_note(
    raw_transcript: str,
    summary_markdown: str,
    title: str = "",
    company_id: str = "",
    company_name: str = "",
    processing_time_ms: int = 0,
) -> dict:
    """Persist a call note. Returns the full record dict."""
    note_id = _generate_id()
    now = datetime.now(timezone.utc).isoformat()
    conn = _get_conn()
    try:
        conn.execute(
            """INSERT INTO call_notes
               (id, created_at, title, company_id, company_name,
                raw_transcript, summary_markdown, processing_time_ms)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                note_id,
                now,
                title.strip(),
                company_id.strip(),
                company_name.strip(),
                raw_transcript,
                summary_markdown,
                processing_time_ms,
            ),
        )
        conn.commit()
        logger.info("Saved call note %s (company=%s)", note_id, company_name or "none")
    finally:
        conn.close()

    return {
        "id": note_id,
        "created_at": now,
        "title": title.strip(),
        "company_id": company_id.strip(),
        "company_name": company_name.strip(),
        "raw_transcript": raw_transcript,
        "summary_markdown": summary_markdown,
        "processing_time_ms": processing_time_ms,
    }


def list_call_notes() -> list[dict]:
    """Return summaries of all saved call notes, newest first."""
    conn = _get_conn()
    try:
        rows = conn.execute(
            """SELECT id, created_at, title, company_id, company_name,
                      processing_time_ms, summary_markdown
               FROM call_notes ORDER BY created_at DESC"""
        ).fetchall()
        results = []
        for r in rows:
            summary_preview = (r["summary_markdown"] or "")[:200]
            results.append({
                "id": r["id"],
                "created_at": r["created_at"],
                "title": r["title"],
                "company_id": r["company_id"],
                "company_name": r["company_name"],
                "processing_time_ms": r["processing_time_ms"],
                "summary_preview": summary_preview,
            })
        return results
    finally:
        conn.close()


def get_call_note(note_id: str) -> dict | None:
    """Load a full call note by ID."""
    conn = _get_conn()
    try:
        row = conn.execute(
            "SELECT * FROM call_notes WHERE id = ?", (note_id,)
        ).fetchone()
        if not row:
            return None
        return {
            "id": row["id"],
            "created_at": row["created_at"],
            "title": row["title"],
            "company_id": row["company_id"],
            "company_name": row["company_name"],
            "raw_transcript": row["raw_transcript"],
            "summary_markdown": row["summary_markdown"],
            "processing_time_ms": row["processing_time_ms"],
        }
    finally:
        conn.close()


def delete_call_note(note_id: str) -> bool:
    """Delete a call note by ID. Returns True if deleted."""
    conn = _get_conn()
    try:
        cur = conn.execute("DELETE FROM call_notes WHERE id = ?", (note_id,))
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()
