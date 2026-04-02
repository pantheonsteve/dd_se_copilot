"""Content gap tracking — logs and aggregates gaps between knowledge stores."""

import json
import logging
from collections import Counter
from datetime import datetime, timezone

from ddtrace.llmobs.decorators import task

from config import settings

logger = logging.getLogger(__name__)


@task(name="log_gaps")
def log_gaps(gaps: list[str], query: str, route: str) -> None:
    """Append a gap entry to the JSONL log file."""
    if not gaps:
        return

    entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "query": query,
        "route": route,
        "gaps": gaps,
    }

    try:
        with open(settings.gap_log_path, "a") as f:
            f.write(json.dumps(entry) + "\n")
    except OSError as exc:
        logger.error("Failed to write gap log: %s", exc)


@task(name="read_gaps")
def read_gaps() -> list[dict]:
    """Read all gap entries from the log file."""
    if not settings.gap_log_path.exists():
        return []

    entries: list[dict] = []
    try:
        with open(settings.gap_log_path) as f:
            for line in f:
                line = line.strip()
                if line:
                    entries.append(json.loads(line))
    except (OSError, json.JSONDecodeError) as exc:
        logger.error("Failed to read gap log: %s", exc)

    return entries


@task(name="aggregate_gaps")
def aggregate_gaps() -> dict:
    """Aggregate gaps by frequency for the /api/gaps endpoint."""
    entries = read_gaps()

    gap_counter: Counter[str] = Counter()
    for entry in entries:
        for gap in entry.get("gaps", []):
            gap_counter[gap] += 1

    return {
        "total_entries": len(entries),
        "unique_gaps": len(gap_counter),
        "gaps_by_frequency": [
            {"gap": gap, "count": count}
            for gap, count in gap_counter.most_common()
        ],
    }
