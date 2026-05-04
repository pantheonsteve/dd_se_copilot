"""Spawn Snowflake MCP (stdio) and run SQL via ``run_snowflake_query`` (or configured tool).

Use when ``snowflake_transport=mcp`` so SE Copilot matches Cursor's Snowflake MCP server.

**SSO / browser auth:** Cursor MCP can complete Gmail/IdP SSO in a browser; it does **not** share that
session with SE Copilot. For SE Copilot + ``SNOWFLAKE_TRANSPORT=mcp``, use either (a) Snowflake CLI SSO
once per cache lifetime (``scripts/snowflake_sso_refresh_cli.py`` + ``snowflake_default_connection_name``
+ credential cache), or (b) a short-lived OAuth token via ``snowflake_oauth_token_file`` / ``snowflake_oauth_access_token``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from pathlib import Path
from typing import Any

from mcp import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client
from mcp.shared.exceptions import McpError

from config import settings

log = logging.getLogger(__name__)


def _mcp_handshake_closed_message(underlying: str) -> str:
    return (
        "Snowflake MCP closed during handshake (connection closed). "
        "Common causes: missing SNOWFLAKE_ACCOUNT/USER, no auth for this subprocess, bad "
        "snowflake_mcp_args_json, or uvx/Python failing when spawned. "
        "Cursor browser SSO does not carry over: run scripts/snowflake_sso_refresh_cli.py in a terminal "
        "(same user as uvicorn), set snowflake_default_connection_name + credential cache, or supply "
        "snowflake_oauth_token_file / snowflake_oauth_access_token. "
        f"Underlying: {underlying}"
    )


def _env_for_snowflake_mcp_child() -> dict[str, str]:
    """Build env for MCP stdio child.

    Snowflake MCP servers read SNOWFLAKE_* from the **subprocess** environment. Values from
    ``settings`` are merged in so auth works even when only pydantic loaded ``se-copilot/.env``.
    """
    out: dict[str, str] = {}
    for k, v in os.environ.items():
        if v is not None and isinstance(k, str):
            out[k] = v if isinstance(v, str) else str(v)

    def put(key: str, val: str | None) -> None:
        if val is None:
            return
        s = str(val).strip()
        if s:
            out[key] = s

    put("SNOWFLAKE_ACCOUNT", settings.snowflake_account)
    put("SNOWFLAKE_USER", settings.snowflake_user)
    put("SNOWFLAKE_PASSWORD", settings.snowflake_password)
    put("SNOWFLAKE_ROLE", settings.snowflake_role)
    put("SNOWFLAKE_WAREHOUSE", settings.snowflake_warehouse)
    put("SNOWFLAKE_DATABASE", settings.snowflake_database)
    put("SNOWFLAKE_SCHEMA", settings.snowflake_schema)

    if settings.snowflake_private_key_path:
        p = Path(settings.snowflake_private_key_path).expanduser()
        if p.is_file():
            try:
                out["SNOWFLAKE_PRIVATE_KEY"] = p.read_text(encoding="utf-8")
            except OSError as exc:
                log.warning("Cannot read snowflake_private_key_path for MCP subprocess: %s", exc)
        else:
            log.warning("snowflake_private_key_path does not exist for MCP: %s", p)

    if settings.snowflake_private_key_passphrase:
        pw = settings.snowflake_private_key_passphrase.strip()
        if pw:
            out["SNOWFLAKE_PRIVATE_KEY_FILE_PWD"] = pw
            out["SNOWFLAKE_PRIVATE_KEY_PASSPHRASE"] = pw

    put("SNOWFLAKE_AUTHENTICATOR", settings.snowflake_authenticator)

    if settings.snowflake_client_store_temporary_credential:
        out["SNOWFLAKE_CLIENT_STORE_TEMPORARY_CREDENTIAL"] = "true"

    tcd = (settings.snowflake_temporary_credential_cache_dir or "").strip()
    if tcd:
        out["SF_TEMPORARY_CREDENTIAL_CACHE_DIR"] = str(Path(tcd).expanduser())

    put("SNOWFLAKE_DEFAULT_CONNECTION_NAME", settings.snowflake_default_connection_name)

    oauth_token = (settings.snowflake_oauth_access_token or "").strip()
    tok_file = (settings.snowflake_oauth_token_file or "").strip()
    if not oauth_token and tok_file:
        p = Path(tok_file).expanduser()
        if p.is_file():
            try:
                oauth_token = p.read_text(encoding="utf-8").strip()
            except OSError as exc:
                log.warning("Could not read snowflake_oauth_token_file %s: %s", p, exc)
        else:
            log.warning("snowflake_oauth_token_file does not exist: %s", p)
    if oauth_token:
        # Names vary by Snowflake driver releases; MCP servers built on the Python connector often honor these.
        out["SNOWFLAKE_TOKEN"] = oauth_token
        out["SNOWFLAKE_ACCESS_TOKEN"] = oauth_token
        if "SNOWFLAKE_AUTHENTICATOR" not in out:
            out["SNOWFLAKE_AUTHENTICATOR"] = "oauth"

    return out

_FENCE_RE = re.compile(r"^```(?:json)?\s*\n(.*?)\n```\s*$", re.DOTALL)


def _strip_json_fence(text: str) -> str:
    t = text.strip()
    m = _FENCE_RE.match(t)
    return m.group(1).strip() if m else t


def parse_mcp_snowflake_rows(text: str) -> list[dict[str, Any]]:
    """Normalize MCP tool text into list of row dicts."""
    raw = _strip_json_fence(text)
    if not raw:
        return []

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        log.warning("Snowflake MCP response not JSON (first 240 chars): %s", raw[:240])
        snippet = raw[:200].replace("\n", " ").strip()
        raise ValueError(
            "Snowflake MCP returned non-JSON. Check snowflake_mcp_query_tool / "
            f"snowflake_mcp_statement_argument. Response starts with: {snippet!r}"
        ) from None

    if isinstance(data, list):
        if not data:
            return []
        if all(isinstance(r, dict) for r in data):
            return data
        raise ValueError("Snowflake MCP JSON list rows must be objects")

    if isinstance(data, dict):
        cols = data.get("columns") or data.get("COLUMNS")
        matrix = data.get("data") or data.get("DATA") or data.get("rows")
        if isinstance(cols, list) and isinstance(matrix, list) and matrix:
            col_names: list[str] = []
            for c in cols:
                if isinstance(c, dict):
                    col_names.append(str(c.get("name") or c.get("NAME") or c))
                else:
                    col_names.append(str(c))
            out: list[dict[str, Any]] = []
            for row in matrix:
                if isinstance(row, dict):
                    out.append(row)
                elif isinstance(row, list):
                    out.append(dict(zip(col_names, row)))
            if out:
                return out

        inner = data.get("rows") or data.get("result") or data.get("Results")
        if isinstance(inner, list) and inner and isinstance(inner[0], dict):
            return inner

        if data and all(isinstance(k, str) for k in data.keys()):
            return [data]

    raise ValueError(f"Unrecognized Snowflake MCP JSON shape: {type(data).__name__}")


async def run_snowflake_query_statement(statement: str) -> list[dict[str, Any]]:
    """Call the Snowflake MCP SQL tool and return rows as dicts."""
    cmd = (settings.snowflake_mcp_command or "").strip()
    if not cmd:
        raise ValueError("snowflake_mcp_command is empty")

    try:
        args = json.loads(settings.snowflake_mcp_args_json or "[]")
    except json.JSONDecodeError as exc:
        raise ValueError("snowflake_mcp_args_json must be valid JSON array") from exc

    if not isinstance(args, list) or not all(isinstance(a, str) for a in args):
        raise ValueError("snowflake_mcp_args_json must be a JSON array of strings")

    tool = (settings.snowflake_mcp_query_tool or "run_snowflake_query").strip()
    arg_key = (settings.snowflake_mcp_statement_argument or "statement").strip() or "statement"
    timeout = float(settings.snowflake_mcp_timeout_seconds)

    env = _env_for_snowflake_mcp_child()
    cwd_raw = (settings.snowflake_mcp_cwd or "").strip()
    cwd: str | Path | None = Path(cwd_raw).expanduser() if cwd_raw else None

    log.debug(
        "Snowflake MCP subprocess: command=%r argc=%s cwd=%s account_set=%s user_set=%s pwd_set=%s "
        "key_file_set=%s conn_name_set=%s oauth_file_set=%s oauth_inline_set=%s",
        cmd,
        len(args),
        cwd or "(inherit)",
        bool((settings.snowflake_account or "").strip()),
        bool((settings.snowflake_user or "").strip()),
        bool((settings.snowflake_password or "").strip()),
        bool((settings.snowflake_private_key_path or "").strip()),
        bool((settings.snowflake_default_connection_name or "").strip()),
        bool((settings.snowflake_oauth_token_file or "").strip()),
        bool((settings.snowflake_oauth_access_token or "").strip()),
    )

    server_params = StdioServerParameters(command=cmd, args=args, env=env, cwd=cwd)

    try:
        async with stdio_client(server_params) as (read_stream, write_stream):
            async with ClientSession(read_stream, write_stream) as session:
                await session.initialize()
                result = await asyncio.wait_for(
                    session.call_tool(tool, {arg_key: statement}),
                    timeout=timeout,
                )
                text_parts: list[str] = []
                for block in result.content:
                    if hasattr(block, "text"):
                        text_parts.append(block.text)

                joined = "\n".join(text_parts)

                if getattr(result, "isError", False):
                    raise RuntimeError((joined[:2000] if joined else "") or "MCP tool returned error")

                return parse_mcp_snowflake_rows(joined)
    except McpError as exc:
        msg = str(exc).strip()
        low = msg.lower()
        if "connection closed" in low or "connection reset" in low:
            raise RuntimeError(_mcp_handshake_closed_message(msg)) from exc
        raise RuntimeError(f"Snowflake MCP protocol error: {msg}") from exc
    except BaseExceptionGroup as eg:
        parts: list[str] = []

        def _walk_exc(e: BaseException) -> None:
            if isinstance(e, BaseExceptionGroup):
                for sub in e.exceptions:
                    _walk_exc(sub)
            else:
                parts.append(str(e))

        _walk_exc(eg)
        blob = " | ".join(parts).lower()
        if "connection closed" in blob or "connection reset" in blob:
            joined = " | ".join(parts)[:900]
            raise RuntimeError(_mcp_handshake_closed_message(joined)) from eg
        raise
