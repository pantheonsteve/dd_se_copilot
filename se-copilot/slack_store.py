"""SQLite persistence for Slack channel summaries attached to companies."""

import hashlib
import logging
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from config import settings

logger = logging.getLogger(__name__)

_SLACK_DB = settings.companies_db.parent / "slack_summaries.db"

_CREATE_TABLE = """\
CREATE TABLE IF NOT EXISTS slack_summaries (
    id           TEXT PRIMARY KEY,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    company_name TEXT NOT NULL,
    channel_name TEXT DEFAULT '',
    summary_text TEXT NOT NULL DEFAULT ''
)"""

_CREATE_IDX = """\
CREATE INDEX IF NOT EXISTS idx_slack_company
    ON slack_summaries (LOWER(company_name), created_at DESC)"""


def _get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(_SLACK_DB))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    conn = _get_conn()
    try:
        conn.execute(_CREATE_TABLE)
        conn.execute(_CREATE_IDX)
        conn.commit()
    finally:
        conn.close()
    logger.info("Slack summaries DB initialized at %s", _SLACK_DB)


init_db()


def _generate_id() -> str:
    ts = datetime.now(timezone.utc)
    stamp = ts.strftime("%Y%m%d-%H%M%S")
    short_hash = hashlib.sha256(ts.isoformat().encode()).hexdigest()[:4]
    return f"slk-{stamp}-{short_hash}"


def save_slack_summary(
    company_name: str,
    summary_text: str,
    channel_name: str = "",
) -> dict:
    """Create a new Slack summary. Returns the full record."""
    record_id = _generate_id()
    now = datetime.now(timezone.utc).isoformat()
    conn = _get_conn()
    try:
        conn.execute(
            """INSERT INTO slack_summaries
               (id, created_at, updated_at, company_name, channel_name, summary_text)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (record_id, now, now, company_name.strip(), channel_name.strip(), summary_text.strip()),
        )
        conn.commit()
        logger.info("Saved Slack summary %s for %s", record_id, company_name)
    finally:
        conn.close()
    return {
        "id": record_id,
        "created_at": now,
        "updated_at": now,
        "company_name": company_name.strip(),
        "channel_name": channel_name.strip(),
        "summary_text": summary_text.strip(),
    }


def update_slack_summary(record_id: str, summary_text: str, channel_name: str | None = None) -> dict | None:
    """Update the text (and optionally channel name) of an existing summary."""
    now = datetime.now(timezone.utc).isoformat()
    conn = _get_conn()
    try:
        row = conn.execute("SELECT * FROM slack_summaries WHERE id = ?", (record_id,)).fetchone()
        if not row:
            return None
        new_channel = channel_name.strip() if channel_name is not None else row["channel_name"]
        conn.execute(
            "UPDATE slack_summaries SET summary_text = ?, channel_name = ?, updated_at = ? WHERE id = ?",
            (summary_text.strip(), new_channel, now, record_id),
        )
        conn.commit()
        return {
            "id": record_id,
            "created_at": row["created_at"],
            "updated_at": now,
            "company_name": row["company_name"],
            "channel_name": new_channel,
            "summary_text": summary_text.strip(),
        }
    finally:
        conn.close()


def list_slack_summaries_for_company(company_name: str) -> list[dict]:
    """Return all summaries for a company, newest first."""
    conn = _get_conn()
    try:
        rows = conn.execute(
            """SELECT id, created_at, updated_at, company_name, channel_name,
                      summary_text
               FROM slack_summaries
               WHERE LOWER(company_name) = LOWER(?)
               ORDER BY created_at DESC""",
            (company_name,),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def get_slack_summary(record_id: str) -> dict | None:
    conn = _get_conn()
    try:
        row = conn.execute(
            "SELECT * FROM slack_summaries WHERE id = ?", (record_id,)
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def delete_slack_summary(record_id: str) -> bool:
    conn = _get_conn()
    try:
        cur = conn.execute("DELETE FROM slack_summaries WHERE id = ?", (record_id,))
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def list_all_slack_summaries() -> list[dict]:
    """Return all summaries across all companies, newest first."""
    conn = _get_conn()
    try:
        rows = conn.execute(
            """SELECT id, created_at, company_name, channel_name
               FROM slack_summaries ORDER BY created_at DESC"""
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()
