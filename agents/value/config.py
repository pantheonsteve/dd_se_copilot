import os
from pathlib import Path

from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
VALUE_DIR = Path(__file__).resolve().parent

load_dotenv(VALUE_DIR / ".env", override=True)
load_dotenv(PROJECT_ROOT / ".env", override=True)

OPENAI_API_KEY = os.environ["OPENAI_API_KEY"]
ANTHROPIC_API_KEY = os.environ["ANTHROPIC_API_KEY"]

CHROMA_HOST = os.getenv("CHROMA_HOST", "localhost")
CHROMA_PORT = int(os.getenv("CHROMA_PORT", "8000"))
CHROMA_PERSIST_DIR = str(VALUE_DIR / "chroma_data")
CHROMA_COLLECTION = "value"

EMBEDDING_MODEL = "text-embedding-3-small"
EMBEDDING_DIMENSIONS = 1536

CLAUDE_MODEL = "claude-haiku-4-5-20251001"
OPENAI_CHAT_MODEL = "gpt-4o"

CHUNK_SIZE = 500
CHUNK_OVERLAP = 50

KNOWLEDGE_BASE_DIR = VALUE_DIR / "knowledge_base"

SUPPORTED_EXTENSIONS = {".md", ".txt"}
