"""MCP client for connecting to the Datadog MCP Server via the local CLI binary.

Uses stdio transport with ``datadog_mcp_cli`` which handles authentication
and communicates with the remote Datadog MCP Server on our behalf.
The server is read-only -- no write operations are performed against the demo org.
"""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from typing import Any

from mcp import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client

from config import settings

logger = logging.getLogger(__name__)


@asynccontextmanager
async def mcp_session(toolsets: list[str] | None = None):
    """Open an authenticated stdio session to the Datadog MCP Server.

    The session is backed by the local ``datadog_mcp_cli`` binary which
    communicates with Datadog's remote MCP endpoint. API and App keys are
    passed via environment variables so the binary can authenticate.

    Usage::

        async with mcp_session() as session:
            result = await call_tool(session, "search_datadog_services", {...})
    """
    api_key = settings.datadog_api_key
    app_key = settings.datadog_app_key
    logger.info(
        "Opening MCP session (api_key=%s…, app_key=%s…, binary=%s)",
        api_key[:8] if api_key else "<missing>",
        app_key[:8] if app_key else "<missing>",
        settings.datadog_mcp_binary,
    )

    env = {
        **os.environ,
        "DD_API_KEY": api_key,
        "DD_APP_KEY": app_key,
    }

    server_params = StdioServerParameters(
        command=settings.datadog_mcp_binary,
        args=[],
        env=env,
    )

    async with stdio_client(server_params) as (read_stream, write_stream):
        async with ClientSession(read_stream, write_stream) as session:
            await session.initialize()
            logger.info("MCP session initialized successfully")
            yield session


async def call_tool(
    session: ClientSession,
    tool_name: str,
    arguments: dict[str, Any],
    timeout: float | None = None,
) -> dict[str, Any]:
    """Call a single MCP tool and return the parsed result.

    Returns ``{"content": <text>, "error": None}`` on success, or
    ``{"content": "", "error": <message>}`` on failure.
    """
    timeout = timeout or settings.datadog_mcp_timeout_seconds

    try:
        result = await asyncio.wait_for(
            session.call_tool(tool_name, arguments=arguments),
            timeout=timeout,
        )

        text_parts: list[str] = []
        for block in result.content:
            if hasattr(block, "text"):
                text_parts.append(block.text)

        joined = "\n".join(text_parts)

        if getattr(result, "isError", False):
            msg = f"MCP tool '{tool_name}' returned error: {joined[:200]}"
            logger.warning(msg)
            return {"content": "", "error": joined}

        logger.info(
            "MCP tool '%s' succeeded (%d chars)",
            tool_name,
            len(joined),
        )
        return {"content": joined, "error": None}

    except asyncio.TimeoutError:
        msg = f"MCP tool '{tool_name}' timed out after {timeout}s"
        logger.warning(msg)
        return {"content": "", "error": msg}
    except Exception as exc:
        msg = f"MCP tool '{tool_name}' failed: {exc}"
        logger.warning(msg)
        return {"content": "", "error": msg}


async def call_tools_parallel(
    session: ClientSession,
    calls: list[tuple[str, dict[str, Any]]],
) -> dict[str, dict[str, Any]]:
    """Execute multiple MCP tool calls in parallel.

    *calls* is a list of ``(tool_name, arguments)`` tuples.
    Returns a dict keyed by tool_name with the result of each call.
    When the same tool is called more than once, results are keyed as
    ``tool_name``, ``tool_name__2``, etc.
    """
    seen: dict[str, int] = {}
    keys: list[str] = []
    for tool_name, _ in calls:
        count = seen.get(tool_name, 0) + 1
        seen[tool_name] = count
        key = tool_name if count == 1 else f"{tool_name}__{count}"
        keys.append(key)

    tasks = [
        asyncio.ensure_future(call_tool(session, name, args))
        for name, args in calls
    ]
    results_list = await asyncio.gather(*tasks, return_exceptions=True)

    results: dict[str, dict[str, Any]] = {}
    for key, result in zip(keys, results_list):
        if isinstance(result, BaseException):
            results[key] = {"content": "", "error": str(result)}
        else:
            results[key] = result

    return results
