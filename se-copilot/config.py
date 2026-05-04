"""Configuration management for the SE Copilot Router service."""

from pathlib import Path
from typing import Literal

from dotenv import load_dotenv
from pydantic_settings import BaseSettings, SettingsConfigDict

SERVICE_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SERVICE_DIR.parent

load_dotenv(PROJECT_ROOT / ".env", override=False)
load_dotenv(SERVICE_DIR / ".env", override=True)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore")

    anthropic_api_key: str = ""
    technical_agent_url: str = "http://localhost:5050/api/query"
    value_agent_url: str = "http://localhost:5051/api/query"
    case_studies_agent_url: str = ""
    sec_edgar_agent_url: str = ""
    buyer_persona_agent_url: str = ""
    slide_agent_url: str = ""
    company_research_agent_url: str = ""
    claude_model: str = "claude-sonnet-4-6"
    router_timeout_seconds: int = 10
    agent_timeout_seconds: int = 30
    log_level: str = "INFO"
    gap_log_path: Path = SERVICE_DIR / "gap_log.jsonl"
    reports_dir: Path = SERVICE_DIR / "reports"
    demo_plans_db: Path = SERVICE_DIR / "demo_plans.db"
    demo_plans_dir: Path = SERVICE_DIR / "demo_plans"
    hypotheses_db: Path = SERVICE_DIR / "hypotheses.db"
    expansion_db: Path = SERVICE_DIR / "expansion_playbooks.db"
    companies_db: Path = SERVICE_DIR / "companies.db"
    call_notes_db: Path = SERVICE_DIR / "call_notes.db"
    call_notes_dir: Path = SERVICE_DIR / "call_notes"
    company_chat_db: Path = SERVICE_DIR / "company_chat.db"
    port: int = 5070

    # Datadog (tracing + MCP Demo Environment Agent)
    datadog_api_key: str = ""
    datadog_app_key: str = ""
    datadog_mcp_binary: str = str(
        Path.home() / ".local" / "bin" / "datadog_mcp_cli"
    )
    datadog_mcp_timeout_seconds: int = 30

    # Datadog RUM / Product Analytics (client-side — served via /api/rum-config)
    dd_rum_application_id: str = ""
    dd_rum_client_token: str = ""

    # Snowflake (optional — Homerun context from REPORTING.GENERAL)
    # transport connector: snowflake-connector-python + credentials below.
    # transport mcp: spawn Snowflake MCP stdio (same pattern as Cursor); auth via MCP / SNOWFLAKE_* env.
    snowflake_transport: Literal["connector", "mcp"] = "connector"
    snowflake_mcp_command: str = ""
    snowflake_mcp_args_json: str = "[]"
    snowflake_mcp_query_tool: str = "run_snowflake_query"
    # Body key passed to the MCP tool (some servers use "sql" instead of "statement").
    snowflake_mcp_statement_argument: str = "statement"
    # Working directory for the MCP subprocess (optional; some installs need a writable cwd).
    snowflake_mcp_cwd: str = ""
    snowflake_mcp_timeout_seconds: int = 120
    snowflake_enabled: bool = False
    snowflake_account: str = ""
    snowflake_user: str = ""
    snowflake_role: str = ""
    snowflake_warehouse: str = ""
    snowflake_database: str = "REPORTING"
    snowflake_schema: str = "GENERAL"
    # Password auth; ignored if snowflake_private_key_path is set.
    snowflake_password: str = ""
    snowflake_private_key_path: str = ""
    snowflake_private_key_passphrase: str = ""
    # OAuth / SSO: Cursor MCP can open a browser; SE Copilot spawns MCP headlessly (see .env.example).
    snowflake_authenticator: str = ""
    snowflake_client_store_temporary_credential: bool = False
    snowflake_temporary_credential_cache_dir: str = ""
    # ~/.snowflake/connections.toml profile from Snowflake CLI after SSO login (see scripts/snowflake_sso_refresh_cli.py).
    snowflake_default_connection_name: str = ""
    # Headless OAuth bearer for MCP (short-lived). Prefer snowflake_oauth_token_file updated by your own refresh job.
    snowflake_oauth_access_token: str = ""
    snowflake_oauth_token_file: str = ""
    snowflake_query_timeout_seconds: int = 15
    # Optional read-only SQL for Company Detail → Snowflake tab → Salesforce section.
    # Must include exactly one placeholder: {SALESFORCE_OPPORTUNITY_ID}
    # Example: SELECT ... FROM my_db.my_schema.vw_opportunity WHERE id = '{SALESFORCE_OPPORTUNITY_ID}' LIMIT 50
    snowflake_salesforce_context_sql: str = ""
    snowflake_salesforce_context_row_limit: int = 35
    homerun_max_activity_rows: int = 20
    homerun_max_field_chars: int = 2000



settings = Settings()
