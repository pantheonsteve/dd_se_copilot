"""SQLite persistence for expansion playbooks."""

import hashlib
import json
import logging
import sqlite3
from datetime import datetime, timezone

from config import settings
from expansion_models import ExpansionResponse, ExpansionSummary

logger = logging.getLogger(__name__)

_CREATE_EXPANSION = """\
CREATE TABLE IF NOT EXISTS expansion_playbooks (
    id                 TEXT PRIMARY KEY,
    created_at         TEXT NOT NULL,
    company_name       TEXT NOT NULL,
    domain             TEXT DEFAULT '',
    playbook_json      TEXT NOT NULL,
    footprint_json     TEXT DEFAULT '{}',
    hypothesis_id      TEXT DEFAULT '',
    overview_id        TEXT DEFAULT '',
    stage_timings_json TEXT DEFAULT '{}',
    processing_time_ms INTEGER DEFAULT 0
)"""


def _get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(settings.expansion_db))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    conn = _get_conn()
    try:
        conn.execute(_CREATE_EXPANSION)
        conn.commit()
    finally:
        conn.close()
    logger.info("Expansion DB initialized at %s", settings.expansion_db)


init_db()


def _generate_id() -> str:
    ts = datetime.now(timezone.utc)
    stamp = ts.strftime("%Y%m%d-%H%M%S")
    short_hash = hashlib.sha256(ts.isoformat().encode()).hexdigest()[:4]
    return f"exp-{stamp}-{short_hash}"


def save_expansion_playbook(
    response: ExpansionResponse,
    hypothesis_id: str = "",
    overview_id: str = "",
    footprint_dict: dict | None = None,
) -> str:
    """Persist an expansion playbook. Returns the playbook ID."""
    pb_id = _generate_id()
    now = datetime.now(timezone.utc).isoformat()

    conn = _get_conn()
    try:
        conn.execute(
            """INSERT INTO expansion_playbooks
               (id, created_at, company_name, domain, playbook_json,
                footprint_json, hypothesis_id, overview_id,
                stage_timings_json, processing_time_ms)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                pb_id,
                now,
                response.company_name,
                response.domain,
                response.playbook.model_dump_json(),
                json.dumps(footprint_dict or {}),
                hypothesis_id,
                overview_id,
                json.dumps(response.stage_timings_ms),
                response.processing_time_ms,
            ),
        )
        conn.commit()
        logger.info("Saved expansion playbook %s for %s", pb_id, response.company_name)
    finally:
        conn.close()

    return pb_id


def list_expansion_playbooks() -> list[ExpansionSummary]:
    """Return summaries of all saved playbooks, newest first."""
    conn = _get_conn()
    try:
        rows = conn.execute(
            """SELECT id, created_at, company_name, domain,
                      playbook_json, processing_time_ms
               FROM expansion_playbooks ORDER BY created_at DESC"""
        ).fetchall()
        results = []
        for r in rows:
            total = 0
            try:
                pb = json.loads(r["playbook_json"] or "{}")
                total = pb.get("total_opportunities", 0)
            except (json.JSONDecodeError, KeyError):
                pass
            results.append(
                ExpansionSummary(
                    id=r["id"],
                    created_at=r["created_at"],
                    company_name=r["company_name"],
                    domain=r["domain"],
                    total_opportunities=total,
                    processing_time_ms=r["processing_time_ms"],
                )
            )
        return results
    finally:
        conn.close()


def get_expansion_playbook(pb_id: str) -> dict | None:
    """Load a full expansion playbook by ID."""
    conn = _get_conn()
    try:
        row = conn.execute(
            "SELECT * FROM expansion_playbooks WHERE id = ?", (pb_id,)
        ).fetchone()
        if not row:
            return None

        return {
            "id": row["id"],
            "created_at": row["created_at"],
            "company_name": row["company_name"],
            "domain": row["domain"],
            "playbook": json.loads(row["playbook_json"] or "{}"),
            "footprint": json.loads(row["footprint_json"] or "{}"),
            "hypothesis_id": row["hypothesis_id"],
            "overview_id": row["overview_id"],
            "stage_timings_ms": json.loads(row["stage_timings_json"] or "{}"),
            "processing_time_ms": row["processing_time_ms"],
        }
    finally:
        conn.close()


def find_playbook_by_company(company_name: str) -> dict | None:
    """Find the most recent playbook for a company (case-insensitive)."""
    conn = _get_conn()
    try:
        row = conn.execute(
            """SELECT * FROM expansion_playbooks
               WHERE LOWER(company_name) = LOWER(?)
               ORDER BY created_at DESC LIMIT 1""",
            (company_name,),
        ).fetchone()
        if not row:
            return None
        return {
            "id": row["id"],
            "created_at": row["created_at"],
            "company_name": row["company_name"],
            "domain": row["domain"],
            "playbook": json.loads(row["playbook_json"] or "{}"),
            "footprint": json.loads(row["footprint_json"] or "{}"),
            "hypothesis_id": row["hypothesis_id"],
            "overview_id": row["overview_id"],
            "stage_timings_ms": json.loads(row["stage_timings_json"] or "{}"),
            "processing_time_ms": row["processing_time_ms"],
        }
    finally:
        conn.close()


def delete_expansion_playbook(pb_id: str) -> bool:
    """Delete an expansion playbook by ID. Returns True if deleted."""
    conn = _get_conn()
    try:
        cur = conn.execute(
            "DELETE FROM expansion_playbooks WHERE id = ?", (pb_id,)
        )
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()
