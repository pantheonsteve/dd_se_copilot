"""Homerun browser mapping helpers."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from homerun_browser_automation import (  # noqa: E402
    automation_runbook_markdown,
    dim_row_to_fill_strings,
    workspace_url,
)


def test_dim_row_to_fill_strings_maps_headings():
    row = {
        "TECHNICAL_PLAN_STATUS": "Plan done",
        "OPPORTUNITY_CURRENT_STATUS": "In evaluation",
        "SE_NEXT_STEPS": "Book workshop",
        "CURRENT_ENVIRONMENT_TOOLS": ["k8s", "aws"],
    }
    out = dim_row_to_fill_strings(row)
    assert out["Technical Plan/Status"] == "Plan done"
    assert out["Current Status"] == "In evaluation"
    assert out["SE Next Steps"] == "Book workshop"
    assert "k8s" in out["Current Environment/Tools"]


def test_workspace_url():
    u = workspace_url("abc-def-123")
    assert "abc-def-123" in u
    assert u.endswith("/workspace")


def test_runbook_contains_navigate():
    md = automation_runbook_markdown("uuid-1", {"SE Next Steps": "x"})
    assert "navigate_page" in md
    assert "uuid-1" in md
