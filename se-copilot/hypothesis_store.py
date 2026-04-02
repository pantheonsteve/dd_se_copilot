"""SQLite persistence for sales hypotheses."""

import hashlib
import json
import logging
import sqlite3
from datetime import datetime, timezone

from config import settings
from models import HypothesisResponse, HypothesisSummary

logger = logging.getLogger(__name__)

_CREATE_HYPOTHESES = """\
CREATE TABLE IF NOT EXISTS hypotheses (
    id                TEXT PRIMARY KEY,
    created_at        TEXT NOT NULL,
    company_name      TEXT NOT NULL,
    domain            TEXT DEFAULT '',
    is_public         INTEGER DEFAULT 0,
    confidence_level  TEXT DEFAULT 'low',
    hypothesis_markdown TEXT NOT NULL,
    research_json     TEXT DEFAULT '{}',
    sources_json      TEXT DEFAULT '[]',
    stage_timings_json TEXT DEFAULT '{}',
    processing_time_ms INTEGER DEFAULT 0
)"""


def _get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(settings.hypotheses_db))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    conn = _get_conn()
    try:
        conn.execute(_CREATE_HYPOTHESES)
        conn.commit()
    finally:
        conn.close()
    logger.info("Hypotheses DB initialized at %s", settings.hypotheses_db)


init_db()


def _generate_id() -> str:
    ts = datetime.now(timezone.utc)
    stamp = ts.strftime("%Y%m%d-%H%M%S")
    short_hash = hashlib.sha256(ts.isoformat().encode()).hexdigest()[:4]
    return f"{stamp}-{short_hash}"


def save_hypothesis(response: HypothesisResponse) -> str:
    """Persist a hypothesis. Returns the hypothesis ID."""
    hyp_id = _generate_id()
    now = datetime.now(timezone.utc).isoformat()

    conn = _get_conn()
    try:
        conn.execute(
            """INSERT INTO hypotheses
               (id, created_at, company_name, domain, is_public, confidence_level,
                hypothesis_markdown, research_json, sources_json, stage_timings_json,
                processing_time_ms)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                hyp_id,
                now,
                response.company_name,
                response.domain,
                1 if response.is_public else 0,
                response.confidence_level,
                response.hypothesis_markdown,
                json.dumps(response.research_summary),
                json.dumps(response.data_sources),
                json.dumps(response.stage_timings_ms),
                response.processing_time_ms,
            ),
        )
        conn.commit()
        logger.info("Saved hypothesis %s for %s", hyp_id, response.company_name)
    finally:
        conn.close()

    return hyp_id


def list_hypotheses() -> list[HypothesisSummary]:
    """Return summaries of all saved hypotheses, newest first."""
    conn = _get_conn()
    try:
        rows = conn.execute(
            """SELECT id, created_at, company_name, domain, is_public,
                      confidence_level, processing_time_ms
               FROM hypotheses ORDER BY created_at DESC"""
        ).fetchall()
        return [
            HypothesisSummary(
                id=r["id"],
                created_at=r["created_at"],
                company_name=r["company_name"],
                domain=r["domain"],
                is_public=bool(r["is_public"]),
                confidence_level=r["confidence_level"],
                processing_time_ms=r["processing_time_ms"],
            )
            for r in rows
        ]
    finally:
        conn.close()


def get_hypothesis(hyp_id: str) -> dict | None:
    """Load a full hypothesis by ID."""
    conn = _get_conn()
    try:
        row = conn.execute(
            "SELECT * FROM hypotheses WHERE id = ?", (hyp_id,)
        ).fetchone()
        if not row:
            return None

        return {
            "id": row["id"],
            "created_at": row["created_at"],
            "company_name": row["company_name"],
            "domain": row["domain"],
            "is_public": bool(row["is_public"]),
            "confidence_level": row["confidence_level"],
            "hypothesis_markdown": row["hypothesis_markdown"],
            "research_summary": json.loads(row["research_json"] or "{}"),
            "data_sources": json.loads(row["sources_json"] or "[]"),
            "stage_timings_ms": json.loads(row["stage_timings_json"] or "{}"),
            "processing_time_ms": row["processing_time_ms"],
        }
    finally:
        conn.close()


def find_hypothesis_by_company(company_name: str) -> dict | None:
    """Find the most recent hypothesis for a company by name (case-insensitive)."""
    conn = _get_conn()
    try:
        row = conn.execute(
            """SELECT * FROM hypotheses
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
            "is_public": bool(row["is_public"]),
            "confidence_level": row["confidence_level"],
            "hypothesis_markdown": row["hypothesis_markdown"],
            "research_summary": json.loads(row["research_json"] or "{}"),
            "data_sources": json.loads(row["sources_json"] or "[]"),
            "stage_timings_ms": json.loads(row["stage_timings_json"] or "{}"),
            "processing_time_ms": row["processing_time_ms"],
        }
    finally:
        conn.close()


def delete_hypothesis(hyp_id: str) -> bool:
    """Delete a hypothesis by ID. Returns True if deleted."""
    conn = _get_conn()
    try:
        cur = conn.execute("DELETE FROM hypotheses WHERE id = ?", (hyp_id,))
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()
