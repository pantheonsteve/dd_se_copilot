"""Config-driven Salesforce (Snowflake) context query for the Company Detail Snowflake tab."""

from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any

from config import settings

log = logging.getLogger(__name__)

SF_CONTEXT_SQL_PLACEHOLDER = "{SALESFORCE_OPPORTUNITY_ID}"

_SF_ID_RE = re.compile(r"^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$")


def validate_salesforce_opportunity_id(value: str | None) -> str | None:
    """Return stripped id if it looks like a 15- or 18-char Salesforce opportunity id, else None."""
    if value is None:
        return None
    s = str(value).strip()
    if not _SF_ID_RE.fullmatch(s):
        return None
    return s


def render_salesforce_context_sql(template: str, sf_id: str) -> str:
    if SF_CONTEXT_SQL_PLACEHOLDER not in template:
        raise ValueError(
            f"snowflake_salesforce_context_sql must contain {SF_CONTEXT_SQL_PLACEHOLDER}"
        )
    return template.replace(SF_CONTEXT_SQL_PLACEHOLDER, sf_id)


def _cell_json(v: Any) -> Any:
    if v is None:
        return None
    if isinstance(v, (str, int, float, bool)):
        return v
    return str(v)


def normalize_rows_for_json(rows: list[dict[str, Any]]) -> tuple[list[str], list[dict[str, Any]]]:
    if not rows:
        return [], []
    columns = list(rows[0].keys())
    out: list[dict[str, Any]] = []
    for r in rows:
        out.append({str(k): _cell_json(r.get(k)) for k in columns})
    return columns, out


def salesforce_context_configured() -> bool:
    return bool((settings.snowflake_salesforce_context_sql or "").strip())


async def execute_salesforce_context_sql(statement: str) -> list[dict[str, Any]]:
    """Run admin-authored SELECT via MCP or connector."""
    if settings.snowflake_transport == "mcp":
        from snowflake_mcp_client import run_snowflake_query_statement

        return await run_snowflake_query_statement(statement)
    return await asyncio.to_thread(_execute_salesforce_context_connector_sync, statement)


def _execute_salesforce_context_connector_sync(statement: str) -> list[dict[str, Any]]:
    from homerun_snowflake import _snowflake_connect

    conn = _snowflake_connect()
    if conn is None:
        raise RuntimeError(
            "Snowflake connector unavailable (credentials or snowflake-connector-python)."
        )
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(statement)
                desc = [c[0] for c in cur.description] if cur.description else []
                fetched = cur.fetchall()
                out: list[dict[str, Any]] = []
                for row in fetched:
                    out.append({desc[i]: row[i] for i in range(len(desc))})
                return out
    except Exception:
        log.exception("Salesforce context SQL failed (connector)")
        raise


async def fetch_salesforce_context_rows(sf_opportunity_id: str) -> dict[str, Any]:
    """
    Execute configured SQL with the given Salesforce Opportunity Id.

    Returns keys: configured, snowflake_enabled, salesforce_opportunity_id, columns, rows, message (optional).
    """
    if not salesforce_context_configured():
        return {
            "configured": False,
            "snowflake_enabled": settings.snowflake_enabled,
            "salesforce_opportunity_id": sf_opportunity_id,
            "columns": [],
            "rows": [],
            "message": "Set snowflake_salesforce_context_sql in .env (must include "
            f"{SF_CONTEXT_SQL_PLACEHOLDER}).",
        }

    if not settings.snowflake_enabled:
        return {
            "configured": True,
            "snowflake_enabled": False,
            "salesforce_opportunity_id": sf_opportunity_id,
            "columns": [],
            "rows": [],
            "message": "Snowflake is disabled (snowflake_enabled=false).",
        }

    validated = validate_salesforce_opportunity_id(sf_opportunity_id)
    if not validated:
        return {
            "configured": True,
            "snowflake_enabled": True,
            "salesforce_opportunity_id": None,
            "columns": [],
            "rows": [],
            "message": "No valid Salesforce Opportunity Id on this Homerun row (link DIM / check Snowflake).",
        }

    template = (settings.snowflake_salesforce_context_sql or "").strip()
    try:
        statement = render_salesforce_context_sql(template, validated)
    except ValueError as exc:
        return {
            "configured": True,
            "snowflake_enabled": True,
            "salesforce_opportunity_id": validated,
            "columns": [],
            "rows": [],
            "message": str(exc),
        }

    lim = max(1, min(int(settings.snowflake_salesforce_context_row_limit), 500))
    try:
        raw_rows = await execute_salesforce_context_sql(statement)
    except Exception as exc:
        log.exception("Salesforce context query failed: %s", exc)
        return {
            "configured": True,
            "snowflake_enabled": True,
            "salesforce_opportunity_id": validated,
            "columns": [],
            "rows": [],
            "message": f"Snowflake query failed: {exc}"[:500],
        }

    sliced = raw_rows[:lim]
    columns, rows = normalize_rows_for_json(sliced)
    return {
        "configured": True,
        "snowflake_enabled": True,
        "salesforce_opportunity_id": validated,
        "columns": columns,
        "rows": rows,
        "message": None,
    }


def truncate_rows_for_llm(
    columns: list[str],
    rows: list[dict[str, Any]],
    *,
    max_rows: int = 25,
    max_cell_chars: int = 400,
) -> tuple[list[str], list[dict[str, Any]]]:
    """Shrink payload for Claude."""
    take = rows[:max_rows]
    out: list[dict[str, Any]] = []
    for r in take:
        slim: dict[str, Any] = {}
        for c in columns:
            v = r.get(c)
            if isinstance(v, str) and len(v) > max_cell_chars:
                slim[c] = v[: max_cell_chars - 3] + "..."
            else:
                slim[c] = v
        out.append(slim)
    return columns, out


def rows_payload_json(columns: list[str], rows: list[dict[str, Any]], max_chars: int = 100_000) -> str:
    _, slim_rows = truncate_rows_for_llm(columns, rows)
    blob = json.dumps({"columns": columns, "rows": slim_rows}, default=str)
    if len(blob) <= max_chars:
        return blob
    return blob[: max_chars - 3] + "..."
