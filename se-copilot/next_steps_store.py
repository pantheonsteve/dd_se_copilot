"""SQLite persistence for Next Steps plans."""

import hashlib
import json
import logging
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from config import settings
from next_steps_models import NextStepsResponse, NextStepsSummary

logger = logging.getLogger(__name__)

# Store next steps DB alongside the other DBs
_NEXT_STEPS_DB = settings.call_notes_db.parent / "next_steps.db"

_CREATE_NEXT_STEPS = """\
CREATE TABLE IF NOT EXISTS next_steps (
    id                      TEXT PRIMARY KEY,
    created_at              TEXT NOT NULL,
    company_name            TEXT NOT NULL,
    inferred_deal_stage     TEXT DEFAULT '',
    deal_stage_confidence   TEXT DEFAULT 'medium',
    next_steps_json         TEXT DEFAULT '[]',
    blocking_risks_json     TEXT DEFAULT '[]',
    missing_artifacts_json  TEXT DEFAULT '[]',
    recommended_focus       TEXT DEFAULT '',
    processing_time_ms      INTEGER DEFAULT 0
)"""


def _get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(_NEXT_STEPS_DB))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    conn = _get_conn()
    try:
        conn.execute(_CREATE_NEXT_STEPS)
        conn.commit()
    finally:
        conn.close()
    logger.info("Next Steps DB initialized at %s", _NEXT_STEPS_DB)


init_db()


def _generate_id() -> str:
    ts = datetime.now(timezone.utc)
    stamp = ts.strftime("%Y%m%d-%H%M%S")
    short_hash = hashlib.sha256(ts.isoformat().encode()).hexdigest()[:4]
    return f"ns-{stamp}-{short_hash}"


def save_next_steps(response: NextStepsResponse) -> str:
    """Persist a next steps plan. Returns the record ID."""
    record_id = _generate_id()
    now = datetime.now(timezone.utc).isoformat()

    conn = _get_conn()
    try:
        conn.execute(
            """INSERT INTO next_steps
               (id, created_at, company_name, inferred_deal_stage,
                deal_stage_confidence, next_steps_json, blocking_risks_json,
                missing_artifacts_json, recommended_focus, processing_time_ms)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                record_id,
                now,
                response.company_name,
                response.inferred_deal_stage,
                response.deal_stage_confidence,
                json.dumps([s.model_dump() for s in response.next_steps]),
                json.dumps(response.blocking_risks),
                json.dumps(response.missing_artifacts),
                response.recommended_focus,
                response.processing_time_ms,
            ),
        )
        conn.commit()
        logger.info("Saved next steps %s for %s", record_id, response.company_name)
    finally:
        conn.close()

    return record_id


def list_next_steps() -> list[NextStepsSummary]:
    """Return summaries of all saved next steps plans, newest first."""
    conn = _get_conn()
    try:
        rows = conn.execute(
            """SELECT id, created_at, company_name, inferred_deal_stage,
                      deal_stage_confidence, recommended_focus,
                      processing_time_ms, next_steps_json
               FROM next_steps ORDER BY created_at DESC"""
        ).fetchall()
        results = []
        for r in rows:
            steps = json.loads(r["next_steps_json"] or "[]")
            results.append(
                NextStepsSummary(
                    id=r["id"],
                    created_at=r["created_at"],
                    company_name=r["company_name"],
                    inferred_deal_stage=r["inferred_deal_stage"],
                    deal_stage_confidence=r["deal_stage_confidence"],
                    recommended_focus=r["recommended_focus"],
                    total_steps=len(steps),
                    processing_time_ms=r["processing_time_ms"],
                )
            )
        return results
    finally:
        conn.close()


def get_next_steps(record_id: str) -> dict | None:
    """Load a full next steps plan by ID."""
    conn = _get_conn()
    try:
        row = conn.execute(
            "SELECT * FROM next_steps WHERE id = ?", (record_id,)
        ).fetchone()
        if not row:
            return None
        return {
            "id": row["id"],
            "created_at": row["created_at"],
            "company_name": row["company_name"],
            "inferred_deal_stage": row["inferred_deal_stage"],
            "deal_stage_confidence": row["deal_stage_confidence"],
            "next_steps": json.loads(row["next_steps_json"] or "[]"),
            "blocking_risks": json.loads(row["blocking_risks_json"] or "[]"),
            "missing_artifacts": json.loads(row["missing_artifacts_json"] or "[]"),
            "recommended_focus": row["recommended_focus"],
            "processing_time_ms": row["processing_time_ms"],
        }
    finally:
        conn.close()


def find_next_steps_by_company(company_name: str) -> dict | None:
    """Find the most recent next steps plan for a company (case-insensitive)."""
    conn = _get_conn()
    try:
        row = conn.execute(
            """SELECT * FROM next_steps
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
            "inferred_deal_stage": row["inferred_deal_stage"],
            "deal_stage_confidence": row["deal_stage_confidence"],
            "next_steps": json.loads(row["next_steps_json"] or "[]"),
            "blocking_risks": json.loads(row["blocking_risks_json"] or "[]"),
            "missing_artifacts": json.loads(row["missing_artifacts_json"] or "[]"),
            "recommended_focus": row["recommended_focus"],
            "processing_time_ms": row["processing_time_ms"],
        }
    finally:
        conn.close()


def delete_next_steps(record_id: str) -> bool:
    """Delete a next steps plan by ID. Returns True if deleted."""
    conn = _get_conn()
    try:
        cur = conn.execute("DELETE FROM next_steps WHERE id = ?", (record_id,))
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()
