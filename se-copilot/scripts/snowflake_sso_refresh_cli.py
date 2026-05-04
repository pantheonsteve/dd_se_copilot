#!/usr/bin/env python3
"""Refresh Snowflake credentials via Snowflake CLI (browser SSO) for headless SE Copilot MCP.

Cursor’s Snowflake MCP can log you in with Gmail/SSO, but that session is **not** visible to SE Copilot.
Run this script in your **terminal** when tokens expire—same macOS/Linux user that runs uvicorn—so the
Snowflake CLI can open a browser once and refresh ``connections.toml`` / credential cache.

Prerequisites:
  - Install Snowflake CLI: https://docs.snowflake.com/en/developer-guide/snowflake-cli/
  - Create a CLI connection that matches your MCP ``--connection-name`` (often OAuth / external browser).

se-copilot ``.env``:
  - ``snowflake_default_connection_name`` = that connection name
  - ``snowflake_client_store_temporary_credential=true`` (recommended)
  - ``SNOWFLAKE_MCP_ARGS_JSON`` must use the same ``--connection-name``

Usage::

    cd se-copilot && python scripts/snowflake_sso_refresh_cli.py

Optional: ``SNOWFLAKE_SQL_CLI_PATH`` to force a binary (Homebrew installs ``snow``; legacy installs may use ``snowflake``).
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from config import settings  # noqa: E402


def _default_snow_cli() -> str:
    """Homebrew ``snowflake-cli`` exposes ``snow``; older docs used ``snowflake``."""
    for candidate in ("snow", "snowflake"):
        if shutil.which(candidate):
            return candidate
    return "snow"


def main() -> int:
    cli = (os.environ.get("SNOWFLAKE_SQL_CLI_PATH") or _default_snow_cli()).strip()
    name = (settings.snowflake_default_connection_name or "").strip()
    if not name:
        print(
            "Set snowflake_default_connection_name in se-copilot/.env to your Snowflake CLI "
            "connection name (must match --connection-name in SNOWFLAKE_MCP_ARGS_JSON).",
            file=sys.stderr,
        )
        return 2
    cmd = [cli, "sql", "-q", "select 1", "--connection", name]
    print("Running:", " ".join(cmd))
    print("(Complete browser SSO if the CLI prompts you.)")
    return subprocess.call(cmd)


if __name__ == "__main__":
    raise SystemExit(main())
