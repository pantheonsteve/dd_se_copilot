"""SQLite persistence for explicitly defined companies and resource links."""

import hashlib
import logging
import sqlite3
from datetime import datetime, timezone

from config import settings

logger = logging.getLogger(__name__)

_CREATE_COMPANIES = """\
CREATE TABLE IF NOT EXISTS companies (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    domain     TEXT DEFAULT '',
    notes      TEXT DEFAULT '',
    created_at TEXT NOT NULL
)"""

_CREATE_COMPANY_RESOURCES = """\
CREATE TABLE IF NOT EXISTS company_resources (
    company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    resource_type TEXT NOT NULL,
    resource_id   TEXT NOT NULL,
    linked_at     TEXT NOT NULL,
    PRIMARY KEY (company_id, resource_type, resource_id)
)"""

_CREATE_COMPANY_NOTES = """\
CREATE TABLE IF NOT EXISTS company_notes (
    id         TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL,
    note_date  TEXT NOT NULL DEFAULT ''
)"""


def _get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(settings.companies_db))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    conn = _get_conn()
    try:
        conn.execute(_CREATE_COMPANIES)
        conn.execute(_CREATE_COMPANY_RESOURCES)
        conn.execute(_CREATE_COMPANY_NOTES)
        # Migration: add note_date column to existing tables
        try:
            conn.execute("ALTER TABLE company_notes ADD COLUMN note_date TEXT NOT NULL DEFAULT ''")
            conn.execute(
                "UPDATE company_notes SET note_date = SUBSTR(created_at, 1, 10) WHERE note_date = ''"
            )
        except sqlite3.OperationalError:
            pass  # column already exists
        conn.commit()
    finally:
        conn.close()
    logger.info("Companies DB initialized at %s", settings.companies_db)


init_db()


def _generate_id() -> str:
    ts = datetime.now(timezone.utc)
    stamp = ts.strftime("%Y%m%d-%H%M%S")
    short_hash = hashlib.sha256(ts.isoformat().encode()).hexdigest()[:4]
    return f"{stamp}-{short_hash}"


# ---------------------------------------------------------------------------
# Company CRUD
# ---------------------------------------------------------------------------


def create_company(name: str, domain: str = "", notes: str = "") -> dict:
    """Create a new company. Returns the full company dict."""
    company_id = _generate_id()
    now = datetime.now(timezone.utc).isoformat()
    conn = _get_conn()
    try:
        conn.execute(
            "INSERT INTO companies (id, name, domain, notes, created_at) VALUES (?, ?, ?, ?, ?)",
            (company_id, name.strip(), domain.strip(), notes.strip(), now),
        )
        conn.commit()
        logger.info("Created company %s: %s", company_id, name)
    finally:
        conn.close()
    return {"id": company_id, "name": name.strip(), "domain": domain.strip(),
            "notes": notes.strip(), "created_at": now}


def list_companies() -> list[dict]:
    """Return all defined companies, newest first."""
    conn = _get_conn()
    try:
        rows = conn.execute(
            "SELECT id, name, domain, notes, created_at FROM companies ORDER BY created_at DESC"
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def get_company(company_id: str) -> dict | None:
    """Load a company by ID, including its linked resources."""
    conn = _get_conn()
    try:
        row = conn.execute(
            "SELECT id, name, domain, notes, created_at FROM companies WHERE id = ?",
            (company_id,),
        ).fetchone()
        if not row:
            return None
        company = dict(row)
        resources = conn.execute(
            "SELECT resource_type, resource_id, linked_at FROM company_resources WHERE company_id = ? ORDER BY linked_at DESC",
            (company_id,),
        ).fetchall()
        company["resources"] = [dict(r) for r in resources]
        return company
    finally:
        conn.close()


def update_company(company_id: str, name: str | None = None, domain: str | None = None, notes: str | None = None) -> dict | None:
    """Update company metadata. Returns the updated company or None if not found."""
    conn = _get_conn()
    try:
        existing = conn.execute("SELECT * FROM companies WHERE id = ?", (company_id,)).fetchone()
        if not existing:
            return None
        new_name = name.strip() if name is not None else existing["name"]
        new_domain = domain.strip() if domain is not None else existing["domain"]
        new_notes = notes.strip() if notes is not None else existing["notes"]
        conn.execute(
            "UPDATE companies SET name = ?, domain = ?, notes = ? WHERE id = ?",
            (new_name, new_domain, new_notes, company_id),
        )
        conn.commit()
        return {"id": company_id, "name": new_name, "domain": new_domain,
                "notes": new_notes, "created_at": existing["created_at"]}
    finally:
        conn.close()


def delete_company(company_id: str) -> bool:
    """Delete a company and its resource links. Returns True if deleted."""
    conn = _get_conn()
    try:
        cur = conn.execute("DELETE FROM companies WHERE id = ?", (company_id,))
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Resource linking
# ---------------------------------------------------------------------------

_VALID_RESOURCE_TYPES = {
    "hypothesis",
    "report",
    "demo_plan",
    "expansion_playbook",
    "call_note",
    "precall_brief",
    "homerun_opportunity",
}


def link_resource(company_id: str, resource_type: str, resource_id: str) -> dict:
    """Link a resource to a company. Returns the link record."""
    if resource_type not in _VALID_RESOURCE_TYPES:
        raise ValueError(f"Invalid resource_type: {resource_type}. Must be one of {_VALID_RESOURCE_TYPES}")
    now = datetime.now(timezone.utc).isoformat()
    conn = _get_conn()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO company_resources (company_id, resource_type, resource_id, linked_at) VALUES (?, ?, ?, ?)",
            (company_id, resource_type, resource_id, now),
        )
        conn.commit()
        logger.info("Linked %s/%s to company %s", resource_type, resource_id, company_id)
    finally:
        conn.close()
    return {"company_id": company_id, "resource_type": resource_type,
            "resource_id": resource_id, "linked_at": now}


def unlink_resource(company_id: str, resource_type: str, resource_id: str) -> bool:
    """Remove a resource link. Returns True if a link was removed."""
    conn = _get_conn()
    try:
        cur = conn.execute(
            "DELETE FROM company_resources WHERE company_id = ? AND resource_type = ? AND resource_id = ?",
            (company_id, resource_type, resource_id),
        )
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def list_resources(company_id: str) -> list[dict]:
    """All linked resource records for a company."""
    conn = _get_conn()
    try:
        rows = conn.execute(
            "SELECT resource_type, resource_id, linked_at FROM company_resources WHERE company_id = ? ORDER BY linked_at DESC",
            (company_id,),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def get_all_linked_resource_ids() -> set[tuple[str, str]]:
    """Return a set of (resource_type, resource_id) for all linked resources across all companies."""
    conn = _get_conn()
    try:
        rows = conn.execute("SELECT resource_type, resource_id FROM company_resources").fetchall()
        return {(r["resource_type"], r["resource_id"]) for r in rows}
    finally:
        conn.close()


def find_company_for_resource(resource_type: str, resource_id: str) -> dict | None:
    """Look up which company a resource belongs to."""
    conn = _get_conn()
    try:
        row = conn.execute(
            """SELECT c.id, c.name, c.domain, cr.linked_at
               FROM company_resources cr JOIN companies c ON cr.company_id = c.id
               WHERE cr.resource_type = ? AND cr.resource_id = ?""",
            (resource_type, resource_id),
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Company notes
# ---------------------------------------------------------------------------


def create_note(company_id: str, title: str, content: str, note_date: str | None = None) -> dict:
    """Create a note attached to a company. Returns the full note dict."""
    note_id = _generate_id()
    now = datetime.now(timezone.utc).isoformat()
    effective_date = note_date.strip() if note_date else now[:10]
    conn = _get_conn()
    try:
        conn.execute(
            "INSERT INTO company_notes (id, company_id, title, content, created_at, note_date) VALUES (?, ?, ?, ?, ?, ?)",
            (note_id, company_id, title.strip(), content.strip(), now, effective_date),
        )
        conn.commit()
        logger.info("Created note %s for company %s", note_id, company_id)
    finally:
        conn.close()
    return {"id": note_id, "company_id": company_id, "title": title.strip(),
            "content": content.strip(), "created_at": now, "note_date": effective_date}


def list_notes(company_id: str) -> list[dict]:
    """Return all notes for a company, newest by note_date first."""
    conn = _get_conn()
    try:
        rows = conn.execute(
            "SELECT id, company_id, title, content, created_at, note_date FROM company_notes WHERE company_id = ? ORDER BY note_date DESC, created_at DESC",
            (company_id,),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def get_note(note_id: str) -> dict | None:
    """Load a single note by ID."""
    conn = _get_conn()
    try:
        row = conn.execute(
            "SELECT id, company_id, title, content, created_at, note_date FROM company_notes WHERE id = ?",
            (note_id,),
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def delete_note(note_id: str) -> bool:
    """Delete a note. Returns True if deleted."""
    conn = _get_conn()
    try:
        cur = conn.execute("DELETE FROM company_notes WHERE id = ?", (note_id,))
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def update_note_date(note_id: str, note_date: str) -> dict | None:
    """Update the effective date of a note. Returns the updated note or None."""
    conn = _get_conn()
    try:
        existing = conn.execute(
            "SELECT id, company_id, title, content, created_at, note_date FROM company_notes WHERE id = ?",
            (note_id,),
        ).fetchone()
        if not existing:
            return None
        conn.execute(
            "UPDATE company_notes SET note_date = ? WHERE id = ?",
            (note_date.strip(), note_id),
        )
        conn.commit()
        result = dict(existing)
        result["note_date"] = note_date.strip()
        return result
    finally:
        conn.close()


def get_all_notes_text(company_id: str) -> str:
    """Concatenate all note content for a company into a single string."""
    notes = list_notes(company_id)
    if not notes:
        return ""
    return "\n\n---\n\n".join(
        f"## {n['title']}\n{n['content']}" for n in notes
    )
