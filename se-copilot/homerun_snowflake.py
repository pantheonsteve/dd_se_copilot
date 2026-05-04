"""
Load Homerun presales context from Snowflake (REPORTING.GENERAL).

Read-only. Used by /api/query to enrich synthesis. Connection is optional; when
snowflake_enabled is false or credentials are missing, callers get None unless
they pass a manual homerun_context string in the request body.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from pathlib import Path
from typing import Any, Optional

from config import settings

log = logging.getLogger(__name__)


class HomerunIdMismatchError(ValueError):
    """Raised when opportunity_uuid and salesforce_opportunity_id both refer to different deals."""

    pass


# Columns to show on the dim row, in order (omitted if null/empty).
_DIM_FIELD_ORDER: tuple[str, ...] = (
    "OPPORTUNITY_NAME",
    "OPPORTUNITY_UUID",
    "HOMERUN_STAGE",
    "OPPORTUNITY_CURRENT_STATUS",
    "OPPORTUNITY_SENTIMENT",
    "EVALUATION_PLAN_PERCENT_COMPLETE",
    "PRODUCTS_IN_SCOPE",
    "CURRENT_ENVIRONMENT_TOOLS",
    "EVALUATION_METHOD",
    "IS_EVALUATION_STARTED",
    "EVALUATION_STARTED_DATE",
    "IS_EVALUATION_FINISHED",
    "EVALUATION_FINISHED_DATE",
    "SALESFORCE_OPPORTUNITY_ID",
    "SALESFORCE_STAGE",
    "TECHNICAL_LEAD",
    "TECHNICAL_LEAD_EMAIL",
    "SE_ENGAGEMENT_LEVEL",
    "SE_ENGAGEMENT_QUALITY",
    "SE_COMPETITION",
    "SE_NEXT_STEPS",
    "SE_LEADER_NEXT_STEPS",
    "SE_OUTSTANDING_RISKS",
    "TECHNICAL_WIN",
    "TECHNICAL_CLOSE_STATUS",
    "TECHNICAL_PLAN_STATUS",
    "LINK_TO_OPPORTUNITY_DOCUMENTS",
    "ADDITIONAL_APPLICATION_STACK_NOTES",
    "APM_LANGUAGES",
    "APPLICATION_FUNCTION_WHAT_DOES_IT_DO",
    "CI_CD_TOOLING",
    "CLOUD_ENVIRONMENT",
    "CONFIG_MGMT",
    "CONTAINER_ORCHESTRATOR",
    "DATASTORE",
    "HOW_ARE_APPLICATION_SLAS_SLOS_MEASURED",
    "INCUMBENT_MONITORING",
    "KEY_METRICS_FOR_SUCCESS",
    "MESSAGE_BUS",
    "NETWORK_DEVICES",
    "NOTIFICATION_ENDPOINTS",
    "SERVERLESS",
    "WEB",
    "WHO_WILL_BE_MAKING_THE_TECHNICAL_DECISIONS",
    "EMITTED_AT",
)


def _truncate(s: str, max_chars: int) -> str:
    s = s.strip()
    if len(s) <= max_chars:
        return s
    return s[: max_chars - 3] + "..."


def _format_value(v: Any, max_chars: int) -> str:
    if v is None:
        return ""
    if isinstance(v, (list, dict)):
        text = json.dumps(v, default=str)
    else:
        text = str(v)
    return _truncate(text, max_chars)


def _normalize_sf_id(s: str | None) -> str:
    if not s:
        return ""
    return s.strip().lower()


def _uppercase_snowflake_row_keys(row: dict[str, Any]) -> dict[str, Any]:
    """MCP JSON may use mixed-case keys; DIM column names are uppercase in our mappings."""
    return {str(k).upper(): v for k, v in row.items()}


def _brief_exception(exc: BaseException, max_len: int = 900) -> str:
    """Flatten ExceptionGroup chains into one line for UI + outcome codes."""

    def walk(e: BaseException, acc: list[str]) -> None:
        if isinstance(e, BaseExceptionGroup):
            for sub in e.exceptions:
                walk(sub, acc)
        else:
            acc.append(str(e))

    parts: list[str] = []
    walk(exc, parts)
    msg = " | ".join(parts) if parts else str(exc)
    return msg.replace("\n", " ").strip()[:max_len]


def _format_dim_row(row: dict[str, Any], max_chars: int) -> str:
    lines: list[str] = ["### Homerun opportunity (DIM)"]
    for col in _DIM_FIELD_ORDER:
        if col not in row:
            continue
        val = row.get(col)
        if val is None or val == "" or val == []:
            continue
        formatted = _format_value(val, max_chars)
        if not formatted:
            continue
        label = re.sub(r"^_", "", col).replace("_", " ").title()
        lines.append(f"- **{label}:** {formatted}")
    if len(lines) == 1:
        lines.append("(no populated fields in allowlist)")
    return "\n".join(lines)


def _format_activities(
    rows: list[dict[str, Any]], max_rows: int, max_chars: int
) -> str:
    if not rows:
        return ""
    take = rows[:max_rows]
    lines = [f"### Recent activities (last {len(take)}, FACT_HOMERUN_ACTIVITY)"]
    for r in take:
        parts: list[str] = []
        for k in (
            "ACTIVITY_CREATED_TIMESTAMP_UTC",
            "ACTIVITY_TYPE",
            "ACTIVITY_USER",
            "ACTIVITY_USER_EMAIL",
            "ACTIVITY_HOURS_SINGLE_ACTIVITY",
        ):
            if r.get(k) is not None:
                parts.append(f"{k}={_format_value(r[k], max_chars)}")
        if r.get("ACTIVITY_USER_NOTES"):
            parts.append(
                f"NOTES={_format_value(r['ACTIVITY_USER_NOTES'], min(500, max_chars))}"
            )
        lines.append("- " + " | ".join(parts) if parts else "- (activity row)")
    if len(rows) > max_rows:
        lines.append(f"_(Omitted {len(rows) - max_rows} additional rows)_")
    return "\n".join(lines)


def _snowflake_connect():
    try:
        import snowflake.connector
    except ImportError:
        log.warning(
            "snowflake-connector-python is not installed; connector transport cannot connect "
            "(use SNOWFLAKE_TRANSPORT=mcp or pip install snowflake-connector-python)."
        )
        return None
    from cryptography.hazmat.backends import default_backend
    from cryptography.hazmat.primitives import serialization

    if not settings.snowflake_user or not settings.snowflake_account:
        log.warning("Snowflake user or account not configured; skipping Homerun load")
        return None

    kwargs: dict[str, Any] = {
        "user": settings.snowflake_user,
        "account": settings.snowflake_account,
        "database": settings.snowflake_database,
        "schema": settings.snowflake_schema,
    }
    if settings.snowflake_warehouse:
        kwargs["warehouse"] = settings.snowflake_warehouse
    if settings.snowflake_role:
        kwargs["role"] = settings.snowflake_role

    if settings.snowflake_private_key_path:
        p = Path(settings.snowflake_private_key_path).expanduser()
        if not p.is_file():
            log.error("Snowflake private key file not found: %s", p)
            return None
        passphrase: bytes | None = None
        if settings.snowflake_private_key_passphrase:
            passphrase = settings.snowflake_private_key_passphrase.encode("utf-8")
        with open(p, "rb") as f:
            p_key = serialization.load_pem_private_key(
                f.read(),
                password=passphrase,
                backend=default_backend(),
            )
        pkb = p_key.private_bytes(
            encoding=serialization.Encoding.DER,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
        kwargs["private_key"] = pkb
    elif settings.snowflake_password:
        kwargs["password"] = settings.snowflake_password
    else:
        log.error(
            "Snowflake: set snowflake_private_key_path or snowflake_password for Homerun"
        )
        return None

    return snowflake.connector.connect(**kwargs)


def _query_dim(
    cur,
    *,
    by_uuid: str | None,
    by_sf_id: str | None,
) -> Optional[dict[str, Any]]:
    fq = (
        f'"{settings.snowflake_database}"."{settings.snowflake_schema}".'
        f'"DIM_HOMERUN_OPPORTUNITY"'
    )
    if by_uuid:
        u = (by_uuid or "").strip()
        cur.execute(
            f"SELECT * FROM {fq} WHERE LOWER(TRIM(OPPORTUNITY_UUID)) = LOWER(TRIM(%s)) LIMIT 2",
            (u,),
        )
    elif by_sf_id:
        cur.execute(
            f"SELECT * FROM {fq} WHERE SALESFORCE_OPPORTUNITY_ID = %s LIMIT 2",
            (by_sf_id,),
        )
    else:
        return None

    rows = cur.fetchall()
    if not rows:
        return None
    if len(rows) > 1:
        log.warning("Homerun dim: multiple rows for id; using first only")
    desc = [c[0] for c in cur.description] if cur.description else []
    return {desc[i]: rows[0][i] for i in range(len(desc))}


def _query_activities(cur, opportunity_uuid: str) -> list[dict[str, Any]]:
    fq = (
        f'"{settings.snowflake_database}"."{settings.snowflake_schema}"'
        f'."FACT_HOMERUN_ACTIVITY"'
    )
    lim = settings.homerun_max_activity_rows
    cur.execute(
        f"""
        SELECT *
        FROM {fq}
        WHERE ACTIVITY_OPPORTUNITY_UUID = %s
        ORDER BY ACTIVITY_CREATED_TIMESTAMP_UTC DESC NULLS LAST
        LIMIT {lim}
        """,
        (opportunity_uuid,),
    )
    desc = [c[0] for c in cur.description] if cur.description else []
    out: list[dict[str, Any]] = []
    for row in cur.fetchall():
        out.append({desc[i]: row[i] for i in range(len(desc))})
    return out


def _sql_activities_for_uuid(opportunity_uuid: str) -> str:
    u = _sql_lit(opportunity_uuid.strip())
    fq = (
        f'"{settings.snowflake_database}"."{settings.snowflake_schema}"'
        f'."FACT_HOMERUN_ACTIVITY"'
    )
    lim = max(1, min(int(settings.homerun_max_activity_rows), 500))
    return (
        f"SELECT * FROM {fq} WHERE ACTIVITY_OPPORTUNITY_UUID = '{u}' "
        f"ORDER BY ACTIVITY_CREATED_TIMESTAMP_UTC DESC NULLS LAST LIMIT {lim}"
    )


def _snowflake_configuration_hint() -> Optional[str]:
    """If env blocks Snowflake access, return a short user-facing hint; else None."""
    if settings.snowflake_transport == "mcp":
        cmd = (settings.snowflake_mcp_command or "").strip()
        if not cmd:
            return (
                "Set snowflake_mcp_command (e.g. uvx) and snowflake_mcp_args_json to match your "
                "Cursor Snowflake MCP launch command."
            )
        try:
            args = json.loads(settings.snowflake_mcp_args_json or "[]")
        except json.JSONDecodeError:
            return "snowflake_mcp_args_json must be a JSON array of strings."
        if not isinstance(args, list) or not args:
            return (
                "snowflake_mcp_args_json must be a non-empty JSON array "
                '(e.g. ["snowflake-labs-mcp","--service-config-file","/path/tools_config.yaml"]).'
            )
        return None

    if not settings.snowflake_user or not settings.snowflake_account:
        return "Set snowflake_user and snowflake_account."
    if not settings.snowflake_private_key_path and not settings.snowflake_password:
        return "Set snowflake_password or snowflake_private_key_path."
    if settings.snowflake_private_key_path:
        p = Path(settings.snowflake_private_key_path).expanduser()
        if not p.is_file():
            return f"Private key file not found: {p}"
    return None


def _dim_table_fq() -> str:
    return (
        f'"{settings.snowflake_database}"."{settings.snowflake_schema}"'
        f'."DIM_HOMERUN_OPPORTUNITY"'
    )


def _sql_lit(value: str) -> str:
    return (value or "").replace("'", "''")


def _sql_dim_by_uuid(uid: str) -> str:
    u = _sql_lit(uid.strip())
    fq = _dim_table_fq()
    return (
        f"SELECT * FROM {fq} WHERE LOWER(TRIM(OPPORTUNITY_UUID)) = LOWER(TRIM('{u}')) LIMIT 2"
    )


def _sql_dim_by_sf(sf_id: str) -> str:
    s = _sql_lit(sf_id.strip())
    fq = _dim_table_fq()
    return f"SELECT * FROM {fq} WHERE SALESFORCE_OPPORTUNITY_ID = '{s}' LIMIT 2"


def _sql_dim_summary_fields_by_uuids(uuids: list[str]) -> str:
    """Same projection as connector batch lookup (company profile Homerun list)."""
    clean = [u.strip() for u in uuids if (u or "").strip()]
    in_list = ", ".join(f"'{_sql_lit(u)}'" for u in clean)
    fq = _dim_table_fq()
    return (
        f"SELECT OPPORTUNITY_UUID, OPPORTUNITY_NAME, SALESFORCE_OPPORTUNITY_ID, HOMERUN_STAGE "
        f"FROM {fq} WHERE OPPORTUNITY_UUID IN ({in_list})"
    )


async def _lookup_dim_by_uuids_mcp_async(uuids: list[str]) -> dict[str, dict[str, Any]]:
    from snowflake_mcp_client import run_snowflake_query_statement

    clean = [u.strip() for u in uuids if (u or "").strip()]
    if not clean:
        return {}
    rows = await run_snowflake_query_statement(_sql_dim_summary_fields_by_uuids(clean))
    out: dict[str, dict[str, Any]] = {}
    for r in rows:
        d = _uppercase_snowflake_row_keys(r)
        uid = str(d.get("OPPORTUNITY_UUID") or "")
        if uid:
            out[uid] = d
    return out


def _lookup_dim_by_uuids_mcp_blocking(uuids: list[str]) -> dict[str, dict[str, Any]]:
    return asyncio.run(_lookup_dim_by_uuids_mcp_async(uuids))


def _resolve_dim_row_mcp_blocking(
    opportunity_uuid: str | None,
    salesforce_opportunity_id: str | None,
) -> Optional[dict[str, Any]]:
    """Load DIM row via Snowflake MCP ``run_snowflake_query`` (stdio subprocess)."""
    from snowflake_mcp_client import run_snowflake_query_statement

    async def _run() -> Optional[dict[str, Any]]:
        if opportunity_uuid and salesforce_opportunity_id:
            rows = await run_snowflake_query_statement(_sql_dim_by_uuid(opportunity_uuid))
            if not rows:
                return None
            dim = _uppercase_snowflake_row_keys(rows[0])
            got = _normalize_sf_id(str(dim.get("SALESFORCE_OPPORTUNITY_ID") or ""))
            exp = _normalize_sf_id(salesforce_opportunity_id)
            if got and exp and got != exp:
                raise HomerunIdMismatchError(
                    "Homerun opportunity UUID does not match the given "
                    "Salesforce opportunity id."
                )
            return dim
        if opportunity_uuid:
            rows = await run_snowflake_query_statement(_sql_dim_by_uuid(opportunity_uuid))
            return _uppercase_snowflake_row_keys(rows[0]) if rows else None
        if salesforce_opportunity_id:
            rows = await run_snowflake_query_statement(_sql_dim_by_sf(salesforce_opportunity_id))
            return _uppercase_snowflake_row_keys(rows[0]) if rows else None
        return None

    return asyncio.run(_run())


def fetch_homerun_dim_for_fill_preview_sync(opportunity_uuid: str) -> tuple[Optional[dict[str, Any]], str]:
    """
    Load DIM row for Homerun fill-preview, with a machine-readable outcome when missing.

    Outcomes: ok (row present), snowflake_disabled, misconfigured|hint, connect_error|...,
    connection_failed, not_found, query_error|..., empty_uuid
    """
    uid = (opportunity_uuid or "").strip()
    if not uid:
        return None, "empty_uuid"
    if not settings.snowflake_enabled:
        return None, "snowflake_disabled"

    hint = _snowflake_configuration_hint()
    if hint:
        return None, f"misconfigured|{hint}"

    if settings.snowflake_transport == "mcp":
        try:
            row = _resolve_dim_row_mcp_blocking(uid, None)
            if row:
                return row, "ok"
            return None, "not_found"
        except HomerunIdMismatchError:
            raise
        except Exception as exc:  # noqa: BLE001
            log.exception("Homerun DIM MCP fetch failed: %s", exc)
            return None, f"query_error|{_brief_exception(exc)}"

    try:
        conn = _snowflake_connect()
    except Exception as exc:  # noqa: BLE001 — surface as outcome; logged below
        log.exception("Snowflake connect failed: %s", exc)
        return None, f"connect_error|{_brief_exception(exc)}"

    if conn is None:
        return None, "connection_failed"

    try:
        with conn:
            with conn.cursor() as cur:
                row = _resolve_dim_row_on_cursor(cur, uid, None)
                if row:
                    return row, "ok"
                return None, "not_found"
    except HomerunIdMismatchError:
        raise
    except Exception as exc:  # noqa: BLE001
        log.exception("Homerun DIM fetch failed: %s", exc)
        return None, f"query_error|{_brief_exception(exc)}"


async def fetch_homerun_dim_for_fill_preview(
    opportunity_uuid: str,
) -> tuple[Optional[dict[str, Any]], str]:
    """Async + timeout wrapper for :func:`fetch_homerun_dim_for_fill_preview_sync`."""
    uid = (opportunity_uuid or "").strip()
    if not uid:
        return None, "empty_uuid"
    to = float(
        settings.snowflake_mcp_timeout_seconds
        if settings.snowflake_transport == "mcp"
        else settings.snowflake_query_timeout_seconds
    )
    try:
        return await asyncio.wait_for(
            asyncio.to_thread(fetch_homerun_dim_for_fill_preview_sync, uid),
            timeout=to,
        )
    except TimeoutError:
        log.warning("Homerun fill-preview DIM fetch timed out after %s s", to)
        return None, "timeout"


def _resolve_dim_row_on_cursor(
    cur,
    opportunity_uuid: str | None,
    salesforce_opportunity_id: str | None,
) -> Optional[dict[str, Any]]:
    """
    Load a single DIM row. Precedence: uuid, else Salesforce id.
    If both ids are set, lookup is by uuid; Salesforce id must match the row.
    """
    if opportunity_uuid and salesforce_opportunity_id:
        dim = _query_dim(cur, by_uuid=opportunity_uuid, by_sf_id=None)
        if not dim:
            return None
        got = _normalize_sf_id(str(dim.get("SALESFORCE_OPPORTUNITY_ID") or ""))
        exp = _normalize_sf_id(salesforce_opportunity_id)
        if got and exp and got != exp:
            raise HomerunIdMismatchError(
                "Homerun opportunity UUID does not match the given "
                "Salesforce opportunity id."
            )
        return dim
    if opportunity_uuid:
        return _query_dim(cur, by_uuid=opportunity_uuid, by_sf_id=None)
    if salesforce_opportunity_id:
        return _query_dim(cur, by_uuid=None, by_sf_id=salesforce_opportunity_id)
    return None


def fetch_homerun_dim_dict_sync(
    opportunity_uuid: str | None,
    salesforce_opportunity_id: str | None,
) -> Optional[dict[str, Any]]:
    """Return raw DIM row dict for browser fill pipelines, or None."""
    if not settings.snowflake_enabled:
        return None
    if settings.snowflake_transport == "mcp":
        try:
            return _resolve_dim_row_mcp_blocking(opportunity_uuid, salesforce_opportunity_id)
        except HomerunIdMismatchError:
            raise
        except Exception as exc:  # noqa: BLE001
            log.exception("Homerun DIM MCP fetch failed: %s", exc)
            return None
    conn = _snowflake_connect()
    if conn is None:
        return None
    try:
        with conn:
            with conn.cursor() as cur:
                return _resolve_dim_row_on_cursor(
                    cur, opportunity_uuid, salesforce_opportunity_id
                )
    except HomerunIdMismatchError:
        raise
    except Exception as exc:  # noqa: BLE001
        log.exception("Homerun DIM fetch failed: %s", exc)
        return None


async def fetch_homerun_dim_dict(
    opportunity_uuid: str | None,
    salesforce_opportunity_id: str | None,
) -> Optional[dict[str, Any]]:
    if not opportunity_uuid and not salesforce_opportunity_id:
        return None
    if not settings.snowflake_enabled:
        return None
    to = float(
        settings.snowflake_mcp_timeout_seconds
        if settings.snowflake_transport == "mcp"
        else settings.snowflake_query_timeout_seconds
    )
    try:
        return await asyncio.wait_for(
            asyncio.to_thread(
                fetch_homerun_dim_dict_sync,
                opportunity_uuid,
                salesforce_opportunity_id,
            ),
            timeout=to,
        )
    except HomerunIdMismatchError:
        raise
    except TimeoutError:
        log.warning("Homerun DIM fetch timed out after %s s", to)
        return None


def _load_homerun_context_sync(
    opportunity_uuid: str | None,
    salesforce_opportunity_id: str | None,
) -> Optional[str]:
    """
    Fetch dim + activities and return a markdown string, or None if not found.
    Precedence: lookup by opportunity_uuid if set; else by salesforce id.
    If both are set, lookup is by uuid; id values must match or HomerunIdMismatchError.
    """
    if not settings.snowflake_enabled:
        return None

    max_c = settings.homerun_max_field_chars
    max_act = settings.homerun_max_activity_rows

    if settings.snowflake_transport == "mcp":
        if _snowflake_configuration_hint():
            return None
        try:
            dim = _resolve_dim_row_mcp_blocking(opportunity_uuid, salesforce_opportunity_id)
            if not dim:
                return None
            ouid = str(dim.get("OPPORTUNITY_UUID") or "")
            parts: list[str] = [_format_dim_row(dim, max_c)]
            if ouid:
                from snowflake_mcp_client import run_snowflake_query_statement

                async def _acts() -> list[dict[str, Any]]:
                    rows = await run_snowflake_query_statement(_sql_activities_for_uuid(ouid))
                    return [_uppercase_snowflake_row_keys(r) for r in rows]

                activities = asyncio.run(_acts())
                act_str = _format_activities(activities, max_act, max_c)
                if act_str:
                    parts.append(act_str)
            return "\n\n".join(p for p in parts if p)
        except HomerunIdMismatchError:
            raise
        except Exception as exc:  # noqa: BLE001 — log and degrade gracefully
            log.exception("Homerun Snowflake MCP load failed: %s", exc)
            return None

    conn = _snowflake_connect()
    if conn is None:
        return None

    try:
        with conn:
            with conn.cursor() as cur:
                dim = _resolve_dim_row_on_cursor(
                    cur, opportunity_uuid, salesforce_opportunity_id
                )
                if not dim:
                    return None
                ouid = str(dim.get("OPPORTUNITY_UUID") or "")
                parts = [_format_dim_row(dim, max_c)]
                if ouid:
                    activities = _query_activities(cur, ouid)
                    act_str = _format_activities(activities, max_act, max_c)
                    if act_str:
                        parts.append(act_str)
                return "\n\n".join(p for p in parts if p)
    except HomerunIdMismatchError:
        raise
    except Exception as exc:  # noqa: BLE001 — log and degrade gracefully
        log.exception("Homerun Snowflake load failed: %s", exc)
        return None


def _search_opportunities_by_name_sync(query: str, limit: int) -> list[dict[str, Any]]:
    """
    Substring search on OPPORTUNITY_NAME. No account column on DIM; use for company matching hints.
    """
    q = (query or "").strip()
    if not q or not settings.snowflake_enabled:
        return []
    lim = max(1, min(int(limit), 100))
    conn = _snowflake_connect()
    if conn is None:
        return []
    fq = (
        f'"{settings.snowflake_database}"."{settings.snowflake_schema}"'
        f'."DIM_HOMERUN_OPPORTUNITY"'
    )
    like = f"%{q}%"
    out: list[dict[str, Any]] = []
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    SELECT OPPORTUNITY_UUID, OPPORTUNITY_NAME, SALESFORCE_OPPORTUNITY_ID,
                           HOMERUN_STAGE, TECHNICAL_LEAD
                    FROM {fq}
                    WHERE OPPORTUNITY_NAME ILIKE %s
                    ORDER BY OPPORTUNITY_LAST_UPDATED_BY_USER DESC NULLS LAST
                    LIMIT {lim}
                    """,
                    (like,),
                )
                desc = [c[0] for c in cur.description] if cur.description else []
                for row in cur.fetchall():
                    out.append({desc[i]: row[i] for i in range(len(desc))})
    except Exception as exc:  # noqa: BLE001
        log.exception("Homerun opportunity search failed: %s", exc)
    return out


def _lookup_dim_by_uuids_sync(uuids: list[str]) -> dict[str, dict[str, Any]]:
    """Batch fetch key display fields by OPPORTUNITY_UUID."""
    clean = [u.strip() for u in uuids if (u or "").strip()]
    if not clean or not settings.snowflake_enabled:
        return {}

    if settings.snowflake_transport == "mcp":
        if _snowflake_configuration_hint():
            return {}
        try:
            return _lookup_dim_by_uuids_mcp_blocking(clean)
        except Exception as exc:  # noqa: BLE001
            log.exception("Homerun batch MCP lookup failed: %s", exc)
            return {}

    conn = _snowflake_connect()
    if conn is None:
        return {}
    fq = (
        f'"{settings.snowflake_database}"."{settings.snowflake_schema}"'
        f'."DIM_HOMERUN_OPPORTUNITY"'
    )
    out: dict[str, dict[str, Any]] = {}
    try:
        with conn:
            with conn.cursor() as cur:
                placeholders = ", ".join(["%s"] * len(clean))
                cur.execute(
                    f"""
                    SELECT OPPORTUNITY_UUID, OPPORTUNITY_NAME, SALESFORCE_OPPORTUNITY_ID,
                           HOMERUN_STAGE
                    FROM {fq}
                    WHERE OPPORTUNITY_UUID IN ({placeholders})
                    """,
                    tuple(clean),
                )
                desc = [c[0] for c in cur.description] if cur.description else []
                for row in cur.fetchall():
                    d = {desc[i]: row[i] for i in range(len(desc))}
                    uid = str(d.get("OPPORTUNITY_UUID") or "")
                    if uid:
                        out[uid] = d
    except Exception as exc:  # noqa: BLE001
        log.exception("Homerun batch lookup failed: %s", exc)
    return out


async def search_homerun_opportunities(query: str, limit: int = 25) -> list[dict[str, Any]]:
    if not settings.snowflake_enabled:
        return []
    to = float(settings.snowflake_query_timeout_seconds)
    try:
        return await asyncio.wait_for(
            asyncio.to_thread(_search_opportunities_by_name_sync, query, limit),
            timeout=to,
        )
    except TimeoutError:
        log.warning("Homerun opportunity search timed out after %s s", to)
        return []


async def lookup_homerun_opportunity_summaries(uuids: list[str]) -> dict[str, dict[str, Any]]:
    if not settings.snowflake_enabled or not uuids:
        return {}
    to = float(
        settings.snowflake_mcp_timeout_seconds
        if settings.snowflake_transport == "mcp"
        else settings.snowflake_query_timeout_seconds
    )
    try:
        return await asyncio.wait_for(
            asyncio.to_thread(_lookup_dim_by_uuids_sync, uuids),
            timeout=to,
        )
    except TimeoutError:
        log.warning("Homerun batch lookup timed out after %s s", to)
        return {}


async def load_homerun_context(
    opportunity_uuid: str | None,
    salesforce_opportunity_id: str | None,
) -> Optional[str]:
    """Load formatted Homerun context, or None. Uses a thread + timeout to avoid blocking."""
    if not opportunity_uuid and not salesforce_opportunity_id:
        return None
    if not settings.snowflake_enabled:
        return None
    to = float(
        settings.snowflake_mcp_timeout_seconds
        if settings.snowflake_transport == "mcp"
        else settings.snowflake_query_timeout_seconds
    )
    try:
        return await asyncio.wait_for(
            asyncio.to_thread(
                _load_homerun_context_sync,
                opportunity_uuid,
                salesforce_opportunity_id,
            ),
            timeout=to,
        )
    except TimeoutError:
        log.warning("Homerun Snowflake query timed out after %s s", to)
        return None