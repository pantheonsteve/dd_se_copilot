"""Persistence layer for Release Notes Digests — SQLite-backed store."""

from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path

from config import settings
from release_digest_models import ReleaseDigestResponse, ReleaseDigestSummary

DB_PATH = Path(settings.model_fields["companies_db"].default).parent / "release_digests.db"


def _get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


def _ensure_table() -> None:
    with _get_conn() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS release_digests (
                id TEXT PRIMARY KEY,
                company_name TEXT NOT NULL,
                created_at TEXT NOT NULL,
                headline TEXT NOT NULL DEFAULT '',
                featured_count INTEGER NOT NULL DEFAULT 0,
                total_releases_reviewed INTEGER NOT NULL DEFAULT 0,
                processing_time_ms INTEGER NOT NULL DEFAULT 0,
                data_json TEXT NOT NULL
            )
        """)
        conn.commit()


_ensure_table()


def save_digest(digest: ReleaseDigestResponse) -> str:
    digest_id = str(uuid.uuid4())[:8]
    created_at = datetime.now(timezone.utc).isoformat()
    with _get_conn() as conn:
        conn.execute(
            """INSERT INTO release_digests
               (id, company_name, created_at, headline, featured_count,
                total_releases_reviewed, processing_time_ms, data_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                digest_id,
                digest.company_name,
                created_at,
                digest.headline,
                len(digest.featured_releases),
                digest.total_releases_reviewed,
                digest.processing_time_ms,
                json.dumps(digest.model_dump()),
            ),
        )
        conn.commit()
    return digest_id


def list_digests() -> list[ReleaseDigestSummary]:
    with _get_conn() as conn:
        rows = conn.execute(
            "SELECT id, company_name, created_at, headline, featured_count, "
            "total_releases_reviewed, processing_time_ms FROM release_digests "
            "ORDER BY created_at DESC"
        ).fetchall()
    return [
        ReleaseDigestSummary(
            id=r["id"],
            company_name=r["company_name"],
            created_at=r["created_at"],
            headline=r["headline"],
            featured_count=r["featured_count"],
            total_releases_reviewed=r["total_releases_reviewed"],
            processing_time_ms=r["processing_time_ms"],
        )
        for r in rows
    ]


def get_digest(digest_id: str) -> dict | None:
    with _get_conn() as conn:
        row = conn.execute(
            "SELECT data_json, created_at FROM release_digests WHERE id = ?", (digest_id,)
        ).fetchone()
    if row is None:
        return None
    data = json.loads(row["data_json"])
    data["id"] = digest_id
    data["created_at"] = row["created_at"]
    return data


def find_digests_by_company(company_name: str) -> list[dict]:
    with _get_conn() as conn:
        rows = conn.execute(
            "SELECT id, company_name, created_at, headline, featured_count, "
            "total_releases_reviewed, processing_time_ms FROM release_digests "
            "WHERE LOWER(company_name) = LOWER(?) ORDER BY created_at DESC",
            (company_name,),
        ).fetchall()
    return [dict(r) for r in rows]


def delete_digest(digest_id: str) -> bool:
    with _get_conn() as conn:
        cur = conn.execute("DELETE FROM release_digests WHERE id = ?", (digest_id,))
        conn.commit()
    return cur.rowcount > 0
