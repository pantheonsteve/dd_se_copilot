"""Configuration for the Company Research Agent."""

from pathlib import Path

from dotenv import load_dotenv
from pydantic_settings import BaseSettings

SERVICE_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SERVICE_DIR.parent.parent

load_dotenv(PROJECT_ROOT / ".env", override=False)
load_dotenv(SERVICE_DIR / ".env", override=True)


class Settings(BaseSettings):
    sumble_api_key: str = ""
    sec_edgar_agent_url: str = "http://localhost:5053"
    builtwith_api_key: str = ""
    builtwith_cache_dir: str = str(SERVICE_DIR / ".builtwith_cache")
    port: int = 5056
    log_level: str = "INFO"
    cache_ttl_seconds: int = 86_400


settings = Settings()
