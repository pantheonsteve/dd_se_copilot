"""Snowflake MCP response parsing (no live MCP)."""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from snowflake_mcp_client import parse_mcp_snowflake_rows  # noqa: E402


def test_parse_list_of_objects():
    rows = [{"SE_NEXT_STEPS": "a", "OPPORTUNITY_UUID": "u1"}]
    assert parse_mcp_snowflake_rows(json.dumps(rows)) == rows


def test_parse_columns_matrix():
    payload = {"columns": ["A", "B"], "data": [[1, 2], [3, 4]]}
    out = parse_mcp_snowflake_rows(json.dumps(payload))
    assert out == [{"A": 1, "B": 2}, {"A": 3, "B": 4}]


def test_parse_fenced_json():
    raw = '```json\n[{"x": 1}]\n```'
    assert parse_mcp_snowflake_rows(raw) == [{"x": 1}]
