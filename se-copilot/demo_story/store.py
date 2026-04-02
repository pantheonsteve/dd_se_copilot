"""SQLite persistence for demo plans and their individual Tell-Show-Tell loops."""

import hashlib
import json
import logging
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from config import settings

from .data import PERSONA_DEFAULTS
from .models import DemoFormInput, DemoPlanResponse, DemoPlanSummary

logger = logging.getLogger(__name__)

_CREATE_PLANS = """\
CREATE TABLE IF NOT EXISTS plans (
    id                TEXT PRIMARY KEY,
    created_at        TEXT NOT NULL,
    company_name      TEXT NOT NULL,
    persona           TEXT NOT NULL,
    demo_mode         TEXT NOT NULL,
    incumbent_tooling TEXT DEFAULT '',
    title             TEXT NOT NULL,
    markdown          TEXT NOT NULL,
    form_input_json   TEXT NOT NULL,
    context_plan_json TEXT DEFAULT '',
    sources_json      TEXT DEFAULT '',
    processing_time_ms INTEGER DEFAULT 0,
    pdf_path          TEXT DEFAULT ''
)"""

_CREATE_LOOPS = """\
CREATE TABLE IF NOT EXISTS loops (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id             TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    loop_number         INTEGER NOT NULL,
    title               TEXT DEFAULT '',
    pain_point          TEXT DEFAULT '',
    primary_product     TEXT DEFAULT '',
    supporting_products TEXT DEFAULT '',
    tell_setup          TEXT DEFAULT '',
    show_demo           TEXT DEFAULT '',
    tell_connection     TEXT DEFAULT '',
    discovery_questions TEXT DEFAULT '',
    transition          TEXT DEFAULT '',
    full_markdown       TEXT DEFAULT ''
)"""


def _get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(settings.demo_plans_db))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.row_factory = sqlite3.Row
    return conn


def _column_exists(conn: sqlite3.Connection, table: str, column: str) -> bool:
    cols = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return any(c["name"] == column for c in cols)


def init_db() -> None:
    conn = _get_conn()
    try:
        conn.execute(_CREATE_PLANS)
        conn.execute(_CREATE_LOOPS)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_loops_plan ON loops(plan_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_loops_product ON loops(primary_product)")

        if not _column_exists(conn, "plans", "slides_json"):
            conn.execute("ALTER TABLE plans ADD COLUMN slides_json TEXT DEFAULT ''")

        if not _column_exists(conn, "loops", "page_url"):
            conn.execute("ALTER TABLE loops ADD COLUMN page_url TEXT DEFAULT ''")
        if not _column_exists(conn, "loops", "url_pattern"):
            conn.execute("ALTER TABLE loops ADD COLUMN url_pattern TEXT DEFAULT ''")
        if not _column_exists(conn, "loops", "page_urls_json"):
            conn.execute("ALTER TABLE loops ADD COLUMN page_urls_json TEXT DEFAULT '[]'")

        conn.commit()
    finally:
        conn.close()
    logger.info("Demo plans DB initialized at %s", settings.demo_plans_db)


init_db()


def _generate_id() -> str:
    ts = datetime.now(timezone.utc)
    stamp = ts.strftime("%Y%m%d-%H%M%S")
    short_hash = hashlib.sha256(ts.isoformat().encode()).hexdigest()[:4]
    return f"{stamp}-{short_hash}"


def _persona_title(persona_key: str) -> str:
    data = PERSONA_DEFAULTS.get(persona_key, {})
    return data.get("title", persona_key.replace("_", " ").title())


# ---------------------------------------------------------------------------
# Loop parser — extracts structured fields from each #### LOOP section
# ---------------------------------------------------------------------------

_LOOP_HEADER_RE = re.compile(r"^#{3,4}\s+(LOOP\s+.+)$", re.MULTILINE)
_FIELD_RE = {
    "pain_point": re.compile(
        r"\*\*Pain Point Addressed:\*\*\s*(.+)", re.IGNORECASE
    ),
    "primary_product": re.compile(
        r"\*\*Primary Product:\*\*\s*(.+)", re.IGNORECASE
    ),
    "supporting_products": re.compile(
        r"\*\*Supporting Products?:\*\*\s*(.+)", re.IGNORECASE
    ),
}

_PHASE_MARKERS = [
    ("tell_setup", re.compile(r"^\*\*TELL\s*\(Setup", re.IGNORECASE | re.MULTILINE)),
    ("show_demo", re.compile(r"^\*\*SHOW\s*\(Live", re.IGNORECASE | re.MULTILINE)),
    ("tell_connection", re.compile(r"^\*\*TELL\s*\(Connection", re.IGNORECASE | re.MULTILINE)),
    ("discovery_questions", re.compile(r"^\*\*DISCOVERY", re.IGNORECASE | re.MULTILINE)),
    ("transition", re.compile(r"^\*\*TRANSITION", re.IGNORECASE | re.MULTILINE)),
]


def _extract_phase(md: str, phase_re: re.Pattern, all_markers: list) -> str:
    """Extract text from a phase marker to the next marker or end of string."""
    m = phase_re.search(md)
    if not m:
        return ""
    start = m.start()
    end = len(md)
    for _, other_re in all_markers:
        if other_re is phase_re:
            continue
        om = other_re.search(md, pos=start + 1)
        if om and om.start() < end:
            end = om.start()
    return md[start:end].strip()


def _parse_loops(plan_id: str, markdown: str) -> list[dict]:
    """Parse #### LOOP sections into structured dicts for DB insertion."""
    parts = _LOOP_HEADER_RE.split(markdown)
    loops: list[dict] = []
    loop_num = 0

    for i in range(1, len(parts), 2):
        header = parts[i].strip()
        body = parts[i + 1] if i + 1 < len(parts) else ""
        full_md = f"#### {header}\n{body}"
        loop_num += 1

        fields: dict = {
            "plan_id": plan_id,
            "loop_number": loop_num,
            "title": header,
            "full_markdown": full_md.strip(),
        }

        for key, regex in _FIELD_RE.items():
            m = regex.search(body)
            fields[key] = m.group(1).strip() if m else ""

        for phase_key, phase_re in _PHASE_MARKERS:
            fields[phase_key] = _extract_phase(body, phase_re, _PHASE_MARKERS)

        loops.append(fields)

    return loops


# ---------------------------------------------------------------------------
# CRUD operations
# ---------------------------------------------------------------------------


def save_demo_plan(
    form_input: DemoFormInput,
    response: DemoPlanResponse,
) -> str:
    """Persist a demo plan and its loops. Returns the plan ID."""
    plan_id = _generate_id()
    now = datetime.now(timezone.utc).isoformat()
    persona_title = _persona_title(form_input.persona.value)
    title = f"{form_input.company_name} — {persona_title}"

    conn = _get_conn()
    try:
        conn.execute(
            """INSERT INTO plans
               (id, created_at, company_name, persona, demo_mode, incumbent_tooling,
                title, markdown, form_input_json, context_plan_json, sources_json,
                processing_time_ms, pdf_path)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                plan_id,
                now,
                form_input.company_name,
                form_input.persona.value,
                form_input.demo_mode.value,
                form_input.incumbent_tooling,
                title,
                response.demo_plan,
                form_input.model_dump_json(),
                response.context_plan.model_dump_json() if response.context_plan else "",
                response.sources_used.model_dump_json(),
                response.processing_time_ms,
                "",
            ),
        )

        loops = _parse_loops(plan_id, response.demo_plan)
        for lp in loops:
            conn.execute(
                """INSERT INTO loops
                   (plan_id, loop_number, title, pain_point, primary_product,
                    supporting_products, tell_setup, show_demo, tell_connection,
                    discovery_questions, transition, full_markdown)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    lp["plan_id"], lp["loop_number"], lp["title"],
                    lp["pain_point"], lp["primary_product"], lp["supporting_products"],
                    lp["tell_setup"], lp["show_demo"], lp["tell_connection"],
                    lp["discovery_questions"], lp["transition"], lp["full_markdown"],
                ),
            )

        conn.commit()
        logger.info("Saved demo plan %s with %d loops", plan_id, len(loops))
    finally:
        conn.close()

    return plan_id


def update_pdf_path(plan_id: str, pdf_path: str) -> None:
    """Set the pdf_path for a saved plan after PDF generation."""
    conn = _get_conn()
    try:
        conn.execute("UPDATE plans SET pdf_path = ? WHERE id = ?", (pdf_path, plan_id))
        conn.commit()
    finally:
        conn.close()


def list_demo_plans() -> list[DemoPlanSummary]:
    """Return summaries of all saved plans, newest first."""
    conn = _get_conn()
    try:
        rows = conn.execute(
            """SELECT id, created_at, company_name, persona, demo_mode, title,
                      processing_time_ms, pdf_path, slides_json
               FROM plans ORDER BY created_at DESC"""
        ).fetchall()
        return [
            DemoPlanSummary(
                id=r["id"],
                created_at=r["created_at"],
                company_name=r["company_name"],
                persona=r["persona"],
                demo_mode=r["demo_mode"],
                title=r["title"],
                processing_time_ms=r["processing_time_ms"],
                has_pdf=bool(r["pdf_path"]),
                has_slides=bool(r["slides_json"]),
            )
            for r in rows
        ]
    finally:
        conn.close()


def get_demo_plan(plan_id: str) -> dict | None:
    """Load a full plan by ID including its loops."""
    conn = _get_conn()
    try:
        row = conn.execute("SELECT * FROM plans WHERE id = ?", (plan_id,)).fetchone()
        if not row:
            return None
        plan = dict(row)

        loop_rows = conn.execute(
            "SELECT * FROM loops WHERE plan_id = ? ORDER BY loop_number",
            (plan_id,),
        ).fetchall()
        plan["loops"] = [dict(lr) for lr in loop_rows]
        return plan
    finally:
        conn.close()


def delete_demo_plan(plan_id: str) -> bool:
    """Delete a plan, its loops, and its PDF file."""
    conn = _get_conn()
    try:
        row = conn.execute(
            "SELECT pdf_path FROM plans WHERE id = ?", (plan_id,)
        ).fetchone()
        if not row:
            return False

        if row["pdf_path"]:
            pdf = Path(row["pdf_path"])
            if pdf.exists():
                pdf.unlink()

        conn.execute("DELETE FROM loops WHERE plan_id = ?", (plan_id,))
        conn.execute("DELETE FROM plans WHERE id = ?", (plan_id,))
        conn.commit()
        return True
    finally:
        conn.close()


def save_slides(plan_id: str, slides_json: str) -> bool:
    """Persist generated slide deck JSON for a plan."""
    conn = _get_conn()
    try:
        cur = conn.execute(
            "UPDATE plans SET slides_json = ? WHERE id = ?",
            (slides_json, plan_id),
        )
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def get_slides(plan_id: str) -> str:
    """Return the stored slide deck JSON for a plan, or empty string."""
    conn = _get_conn()
    try:
        row = conn.execute(
            "SELECT slides_json FROM plans WHERE id = ?", (plan_id,)
        ).fetchone()
        return (row["slides_json"] or "") if row else ""
    finally:
        conn.close()


_LOOP_UPDATABLE_FIELDS = {
    "title", "pain_point", "primary_product", "supporting_products",
    "tell_setup", "show_demo", "tell_connection",
    "discovery_questions", "transition", "full_markdown",
    "page_url", "url_pattern", "page_urls_json",
}


def get_loops(plan_id: str) -> list[dict]:
    """Return all loops for a plan, ordered by loop_number."""
    conn = _get_conn()
    try:
        rows = conn.execute(
            "SELECT * FROM loops WHERE plan_id = ? ORDER BY loop_number",
            (plan_id,),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def update_loop(plan_id: str, loop_id: int, fields: dict) -> dict | None:
    """Partial-update a loop. Returns the updated loop dict or None if not found."""
    safe = {k: v for k, v in fields.items() if k in _LOOP_UPDATABLE_FIELDS}
    if not safe:
        return None

    conn = _get_conn()
    try:
        row = conn.execute(
            "SELECT * FROM loops WHERE id = ? AND plan_id = ?", (loop_id, plan_id)
        ).fetchone()
        if not row:
            return None

        set_clause = ", ".join(f"{col} = ?" for col in safe)
        params = list(safe.values()) + [loop_id, plan_id]
        conn.execute(
            f"UPDATE loops SET {set_clause} WHERE id = ? AND plan_id = ?",
            params,
        )
        conn.commit()

        updated = conn.execute(
            "SELECT * FROM loops WHERE id = ?", (loop_id,)
        ).fetchone()
        return dict(updated) if updated else None
    finally:
        conn.close()


def reparse_loops(plan_id: str) -> int:
    """Re-parse a plan's markdown and replace its loops. Returns loop count."""
    conn = _get_conn()
    try:
        row = conn.execute(
            "SELECT markdown FROM plans WHERE id = ?", (plan_id,)
        ).fetchone()
        if not row:
            return 0
        markdown = row["markdown"]
        conn.execute("DELETE FROM loops WHERE plan_id = ?", (plan_id,))
        loops = _parse_loops(plan_id, markdown)
        for lp in loops:
            conn.execute(
                """INSERT INTO loops
                   (plan_id, loop_number, title, pain_point, primary_product,
                    supporting_products, tell_setup, show_demo, tell_connection,
                    discovery_questions, transition, full_markdown)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    lp["plan_id"], lp["loop_number"], lp["title"],
                    lp["pain_point"], lp["primary_product"], lp["supporting_products"],
                    lp["tell_setup"], lp["show_demo"], lp["tell_connection"],
                    lp["discovery_questions"], lp["transition"], lp["full_markdown"],
                ),
            )
        conn.commit()
        logger.info("Re-parsed plan %s: found %d loops", plan_id, len(loops))
        return len(loops)
    finally:
        conn.close()


def search_loops(
    query: str = "",
    product: str = "",
    persona: str = "",
) -> list[dict]:
    """Search loops across all plans. Groundwork for future searchable UI."""
    conn = _get_conn()
    try:
        sql = """
            SELECT l.*, p.company_name, p.persona, p.demo_mode, p.title AS plan_title
            FROM loops l JOIN plans p ON l.plan_id = p.id
            WHERE 1=1
        """
        params: list = []

        if query:
            sql += " AND (l.title LIKE ? OR l.pain_point LIKE ? OR l.full_markdown LIKE ?)"
            like = f"%{query}%"
            params.extend([like, like, like])
        if product:
            sql += " AND l.primary_product LIKE ?"
            params.append(f"%{product}%")
        if persona:
            sql += " AND p.persona = ?"
            params.append(persona)

        sql += " ORDER BY p.created_at DESC, l.loop_number"

        rows = conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()
