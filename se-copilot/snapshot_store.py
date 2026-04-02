"""SQLite persistence for cached deal snapshots."""

import hashlib
import json
import logging
import sqlite3
from datetime import datetime, timezone

from config import settings

logger = logging.getLogger(__name__)

_SNAPSHOT_DB = settings.companies_db.parent / "deal_snapshots.db"

_CREATE_TABLE = """\
CREATE TABLE IF NOT EXISTS deal_snapshots (
    id            TEXT PRIMARY KEY,
    created_at    TEXT NOT NULL,
    company_name  TEXT NOT NULL,
    snapshot_json TEXT NOT NULL
)"""

_CREATE_IDX = """\
CREATE INDEX IF NOT EXISTS idx_snapshot_company
    ON deal_snapshots (LOWER(company_name), created_at DESC)"""


def _get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(_SNAPSHOT_DB))
    conn.execute("PRAGMA journal_mode=WAL")
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
    logger.info("Deal snapshots DB initialized at %s", _SNAPSHOT_DB)


init_db()


def _generate_id() -> str:
    ts = datetime.now(timezone.utc)
    stamp = ts.strftime("%Y%m%d-%H%M%S")
    short_hash = hashlib.sha256(ts.isoformat().encode()).hexdigest()[:4]
    return f"snap-{stamp}-{short_hash}"


def save_snapshot(company_name: str, snapshot_data: dict) -> dict:
    """Persist a deal snapshot. Returns the stored record."""
    snapshot_id = _generate_id()
    now = datetime.now(timezone.utc).isoformat()
    blob = json.dumps(snapshot_data, default=str)
    conn = _get_conn()
    try:
        conn.execute(
            "INSERT INTO deal_snapshots (id, created_at, company_name, snapshot_json) VALUES (?, ?, ?, ?)",
            (snapshot_id, now, company_name.strip(), blob),
        )
        conn.commit()
        logger.info("Saved deal snapshot %s for '%s'", snapshot_id, company_name)
    finally:
        conn.close()
    return {"id": snapshot_id, "created_at": now, "company_name": company_name.strip(), **snapshot_data}


def get_latest_snapshot(company_name: str) -> dict | None:
    """Return the most recent snapshot for a company, or None."""
    conn = _get_conn()
    try:
        row = conn.execute(
            "SELECT id, created_at, company_name, snapshot_json FROM deal_snapshots "
            "WHERE LOWER(company_name) = LOWER(?) ORDER BY created_at DESC LIMIT 1",
            (company_name,),
        ).fetchone()
        if not row:
            return None
        data = json.loads(row["snapshot_json"])
        return {"id": row["id"], "created_at": row["created_at"], "company_name": row["company_name"], **data}
    finally:
        conn.close()
