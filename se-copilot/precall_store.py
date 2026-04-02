"""SQLite persistence for Pre-Call Briefs."""

import hashlib
import json
import logging
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from config import settings

logger = logging.getLogger(__name__)

_PRECALL_DB = settings.call_notes_db.parent / "precall_briefs.db"
_PRECALL_DIR = settings.call_notes_db.parent / "precall_briefs"

_CREATE_TABLE = """\
CREATE TABLE IF NOT EXISTS precall_briefs (
    id                  TEXT PRIMARY KEY,
    created_at          TEXT NOT NULL,
    company_name        TEXT NOT NULL,
    call_type           TEXT DEFAULT '',
    company_id          TEXT DEFAULT '',
    north_star          TEXT DEFAULT '',
    brief_json          TEXT DEFAULT '{}',
    processing_time_ms  INTEGER DEFAULT 0
)"""


def _get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(_PRECALL_DB))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    conn = _get_conn()
    try:
        conn.execute(_CREATE_TABLE)
        conn.commit()
    finally:
        conn.close()
    logger.info("Pre-Call Briefs DB initialized at %s", _PRECALL_DB)


init_db()


def _generate_id() -> str:
    ts = datetime.now(timezone.utc)
    stamp = ts.strftime("%Y%m%d-%H%M%S")
    short_hash = hashlib.sha256(ts.isoformat().encode()).hexdigest()[:4]
    return f"pcb-{stamp}-{short_hash}"


def save_precall_brief(
    brief: dict,
    company_id: str = "",
    processing_time_ms: int = 0,
) -> str:
    """Persist a pre-call brief. Returns the record ID."""
    record_id = _generate_id()
    now = datetime.now(timezone.utc).isoformat()
    conn = _get_conn()
    try:
        conn.execute(
            """INSERT INTO precall_briefs
               (id, created_at, company_name, call_type, company_id,
                north_star, brief_json, processing_time_ms)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                record_id,
                now,
                brief.get("company_name", ""),
                brief.get("call_type", ""),
                company_id,
                brief.get("north_star", ""),
                json.dumps(brief),
                processing_time_ms,
            ),
        )
        conn.commit()
        logger.info("Saved pre-call brief %s for %s", record_id, brief.get("company_name"))
    finally:
        conn.close()
    return record_id


def list_precall_briefs() -> list[dict]:
    """Return summaries of all saved briefs, newest first."""
    conn = _get_conn()
    try:
        rows = conn.execute(
            """SELECT id, created_at, company_name, call_type,
                      north_star, processing_time_ms
               FROM precall_briefs ORDER BY created_at DESC"""
        ).fetchall()
        return [
            {
                "id": r["id"],
                "created_at": r["created_at"],
                "company_name": r["company_name"],
                "call_type": r["call_type"],
                "north_star": r["north_star"],
                "processing_time_ms": r["processing_time_ms"],
            }
            for r in rows
        ]
    finally:
        conn.close()


def get_precall_brief(record_id: str) -> dict | None:
    """Load a full brief by ID."""
    conn = _get_conn()
    try:
        row = conn.execute(
            "SELECT * FROM precall_briefs WHERE id = ?", (record_id,)
        ).fetchone()
        if not row:
            return None
        brief = json.loads(row["brief_json"] or "{}")
        brief["id"] = row["id"]
        brief["created_at"] = row["created_at"]
        brief["processing_time_ms"] = row["processing_time_ms"]
        return brief
    finally:
        conn.close()


def find_briefs_by_company(company_name: str) -> list[dict]:
    """Find all briefs for a company (case-insensitive), newest first."""
    conn = _get_conn()
    try:
        rows = conn.execute(
            """SELECT id, created_at, company_name, call_type,
                      north_star, processing_time_ms
               FROM precall_briefs
               WHERE LOWER(company_name) = LOWER(?)
               ORDER BY created_at DESC""",
            (company_name,),
        ).fetchall()
        return [
            {
                "id": r["id"],
                "created_at": r["created_at"],
                "company_name": r["company_name"],
                "call_type": r["call_type"],
                "north_star": r["north_star"],
                "processing_time_ms": r["processing_time_ms"],
            }
            for r in rows
        ]
    finally:
        conn.close()


def delete_precall_brief(record_id: str) -> bool:
    """Delete a brief by ID. Returns True if deleted."""
    conn = _get_conn()
    try:
        cur = conn.execute("DELETE FROM precall_briefs WHERE id = ?", (record_id,))
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def get_precall_dir() -> Path:
    _PRECALL_DIR.mkdir(parents=True, exist_ok=True)
    return _PRECALL_DIR
