import os
import sys
from pathlib import Path

import yaml
from dotenv import load_dotenv

RAG_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = RAG_DIR.parent.parent

load_dotenv(RAG_DIR / ".env", override=True)
load_dotenv(PROJECT_ROOT / ".env", override=True)

OPENAI_API_KEY = os.environ["OPENAI_API_KEY"]
ANTHROPIC_API_KEY = os.environ["ANTHROPIC_API_KEY"]

# ---------------------------------------------------------------------------
# Agent config loader
# ---------------------------------------------------------------------------

def _agent_name_from_argv() -> str | None:
    """Parse --agent from sys.argv without interfering with argparse."""
    for i, arg in enumerate(sys.argv):
        if arg == "--agent" and i + 1 < len(sys.argv):
            return sys.argv[i + 1]
        if arg.startswith("--agent="):
            return arg.split("=", 1)[1]
    return None


AGENT_NAME = _agent_name_from_argv() or os.getenv("RAG_AGENT", "librarian")


def load_agent_config(agent_name: str) -> dict:
    path = RAG_DIR / "agents" / f"{agent_name}.yaml"
    if not path.exists():
        available = [p.stem for p in (RAG_DIR / "agents").glob("*.yaml")]
        print(f"Error: agent '{agent_name}' not found. Available: {available}")
        sys.exit(1)
    with open(path) as f:
        return yaml.safe_load(f)


agent = load_agent_config(AGENT_NAME)

# ---------------------------------------------------------------------------
# Per-agent paths
# ---------------------------------------------------------------------------

CHROMA_PERSIST_DIR = str(RAG_DIR / "data" / AGENT_NAME / "chroma_data")
CHROMA_COLLECTION = agent["collection"]
KNOWLEDGE_BASE_DIR = RAG_DIR / "data" / AGENT_NAME / "knowledge_base"
REPORTS_DIR = RAG_DIR / "data" / AGENT_NAME / "reports"
CONVERSATIONS_DB = RAG_DIR / "data" / AGENT_NAME / "conversations.db"

# ---------------------------------------------------------------------------
# Shared constants
# ---------------------------------------------------------------------------

CHROMA_HOST = os.getenv("CHROMA_HOST", "localhost")
CHROMA_PORT = int(os.getenv("CHROMA_PORT", "8000"))

EMBEDDING_MODEL = "text-embedding-3-small"
EMBEDDING_DIMENSIONS = 1536

CLAUDE_MODEL = "claude-haiku-4-5-20251001"
OPENAI_CHAT_MODEL = "gpt-4o"

CHUNK_SIZE = 500
CHUNK_OVERLAP = 50

SUPPORTED_EXTENSIONS = {".md", ".txt"}
