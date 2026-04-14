"""Configuration management for the SE Copilot Router service."""

from pathlib import Path

from dotenv import load_dotenv
from pydantic_settings import BaseSettings

SERVICE_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SERVICE_DIR.parent

load_dotenv(PROJECT_ROOT / ".env", override=False)
load_dotenv(SERVICE_DIR / ".env", override=True)


class Settings(BaseSettings):
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



settings = Settings()
