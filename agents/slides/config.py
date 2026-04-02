"""Configuration for the Slide Generation Agent."""

from pathlib import Path

from dotenv import load_dotenv
from pydantic_settings import BaseSettings

_AGENT_DIR = Path(__file__).resolve().parent
_PROJECT_ROOT = _AGENT_DIR.parent.parent

load_dotenv(_PROJECT_ROOT / ".env", override=False)
load_dotenv(_AGENT_DIR / ".env", override=True)


class Settings(BaseSettings):
    anthropic_api_key: str = ""
    claude_model: str = "claude-sonnet-4-6"
    log_level: str = "INFO"
    port: int = 5055


settings = Settings()
