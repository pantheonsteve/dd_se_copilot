"""Report persistence — save, list, retrieve, and delete query reports."""

import hashlib
import json
import logging
from datetime import datetime, timezone
from pathlib import Path

from ddtrace.llmobs.decorators import task

from config import settings
from models import QueryResponse, ReportSummary, SavedReport

logger = logging.getLogger(__name__)


def _ensure_dir() -> Path:
    settings.reports_dir.mkdir(parents=True, exist_ok=True)
    return settings.reports_dir

def _generate_id() -> str:
    ts = datetime.now(timezone.utc)
    stamp = ts.strftime("%Y%m%d-%H%M%S")
    short_hash = hashlib.sha256(ts.isoformat().encode()).hexdigest()[:4]
    return f"{stamp}-{short_hash}"

@task(name="save_report")
def save_report(response: QueryResponse, title: str | None = None) -> SavedReport:
    """Persist a query response as a saved report and return it."""
    reports_dir = _ensure_dir()
    report_id = _generate_id()
    now = datetime.now(timezone.utc).isoformat()

    report = SavedReport(
        id=report_id,
        saved_at=now,
        title=title,
        response=response,
    )

    path = reports_dir / f"{report_id}.json"
    try:
        path.write_text(report.model_dump_json(indent=2), encoding="utf-8")
    except OSError as exc:
        logger.error("Failed to write report %s: %s", report_id, exc)
        raise

    return report

@task(name="list_reports")
def list_reports() -> list[ReportSummary]:
    """Return summary metadata for all saved reports, most recent first."""
    reports_dir = _ensure_dir()
    summaries: list[ReportSummary] = []

    for path in sorted(reports_dir.glob("*.json"), reverse=True):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            summaries.append(ReportSummary(
                id=data["id"],
                saved_at=data["saved_at"],
                title=data.get("title"),
                query=data["response"]["query"],
                route=data["response"]["route"],
                processing_time_ms=data["response"]["processing_time_ms"],
            ))
        except (OSError, json.JSONDecodeError, KeyError) as exc:
            logger.warning("Skipping malformed report %s: %s", path.name, exc)

    return summaries

@task(name="get_report")
def get_report(report_id: str) -> SavedReport | None:
    """Load a single report by ID, or return None if not found."""
    path = _ensure_dir() / f"{report_id}.json"
    if not path.exists():
        return None

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return SavedReport(**data)
    except (OSError, json.JSONDecodeError, KeyError) as exc:
        logger.error("Failed to load report %s: %s", report_id, exc)
        return None

@task(name="delete_report")
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
