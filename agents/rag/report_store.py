"""Per-agent report persistence — save, list, retrieve, and delete query reports."""

import hashlib
import json
import logging
from datetime import datetime, timezone

from config import REPORTS_DIR

logger = logging.getLogger(__name__)


def _ensure_dir():
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    return REPORTS_DIR


def _generate_id() -> str:
    ts = datetime.now(timezone.utc)
    stamp = ts.strftime("%Y%m%d-%H%M%S")
    short_hash = hashlib.sha256(ts.isoformat().encode()).hexdigest()[:4]
    return f"{stamp}-{short_hash}"


def save_report(question: str, answer: str, sources: list[str],
                elapsed: float, llm: str, title: str | None = None) -> dict:
    """Persist a query result and return the saved report dict."""
    reports_dir = _ensure_dir()
    report_id = _generate_id()
    now = datetime.now(timezone.utc).isoformat()

    report = {
        "id": report_id,
        "saved_at": now,
        "title": title,
        "question": question,
        "answer": answer,
        "sources": sources,
        "elapsed": elapsed,
        "llm": llm,
    }

    path = reports_dir / f"{report_id}.json"
    try:
        path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    except OSError as exc:
        logger.error("Failed to write report %s: %s", report_id, exc)
        raise

    return report


def list_reports() -> list[dict]:
    """Return summary metadata for all saved reports, most recent first."""
    reports_dir = _ensure_dir()
    summaries: list[dict] = []

    for path in sorted(reports_dir.glob("*.json"), reverse=True):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            summaries.append({
                "id": data["id"],
                "saved_at": data["saved_at"],
                "title": data.get("title"),
                "question": data["question"],
                "llm": data.get("llm", ""),
                "elapsed": data.get("elapsed", 0),
            })
        except (OSError, json.JSONDecodeError, KeyError) as exc:
            logger.warning("Skipping malformed report %s: %s", path.name, exc)

    return summaries


def get_report(report_id: str) -> dict | None:
    """Load a single report by ID, or return None if not found."""
    path = _ensure_dir() / f"{report_id}.json"
    if not path.exists():
        return None

    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.error("Failed to load report %s: %s", report_id, exc)
        return None


def delete_report(report_id: str) -> bool:
    """Delete a report by ID. Returns True if deleted, False if not found."""
    path = _ensure_dir() / f"{report_id}.json"
    if not path.exists():
        return False

    try:
        path.unlink()
        return True
    except OSError as exc:
        logger.error("Failed to delete report %s: %s", report_id, exc)
        return False
