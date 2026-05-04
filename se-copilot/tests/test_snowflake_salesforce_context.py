"""Snowflake Salesforce context module (no live Snowflake)."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from types import SimpleNamespace
from unittest.mock import AsyncMock

import config
from snowflake_salesforce_context import (
    SF_CONTEXT_SQL_PLACEHOLDER,
    fetch_salesforce_context_rows,
    normalize_rows_for_json,
    render_salesforce_context_sql,
    rows_payload_json,
    validate_salesforce_opportunity_id,
)


def test_validate_salesforce_opportunity_id_accepts_15_and_18():
    sf15 = "006XX00000001AA"
    sf18 = "006XX00000001AABBB"
    assert len(sf15) == 15 and validate_salesforce_opportunity_id(sf15) == sf15
    assert len(sf18) == 18 and validate_salesforce_opportunity_id(sf18) == sf18
    assert validate_salesforce_opportunity_id("bad") is None
    assert validate_salesforce_opportunity_id("") is None
    assert validate_salesforce_opportunity_id("006XX00000001A") is None  # 14 chars


def test_render_salesforce_context_sql():
    sf15 = "006XX00000001AA"
    sql = render_salesforce_context_sql(
        f"SELECT * FROM t WHERE id = '{SF_CONTEXT_SQL_PLACEHOLDER}'", sf15
    )
    assert SF_CONTEXT_SQL_PLACEHOLDER not in sql
    assert sf15 in sql


def test_render_salesforce_context_sql_requires_placeholder():
    with pytest.raises(ValueError):
        render_salesforce_context_sql("SELECT 1", "006XX00000001AA")


def test_normalize_rows_for_json():
    cols, rows = normalize_rows_for_json([{"A": 1, "B": None}])
    assert cols == ["A", "B"]
    assert rows[0]["A"] == 1
    assert rows[0]["B"] is None


def test_rows_payload_json_truncates():
    big = "x" * 500
    cols = ["c"]
    rows = [{"c": big}]
    s = rows_payload_json(cols, rows, max_chars=100)
    assert len(s) <= 100
    assert s.endswith("...")


@pytest.mark.asyncio
async def test_fetch_salesforce_context_rows_not_configured(monkeypatch):
    monkeypatch.setattr(config.settings, "snowflake_salesforce_context_sql", "")
    out = await fetch_salesforce_context_rows("006XX00000001AA")
    assert out["configured"] is False
    assert out["rows"] == []


@pytest.mark.asyncio
async def test_fetch_salesforce_context_rows_success(monkeypatch):
    monkeypatch.setattr(
        config.settings,
        "snowflake_salesforce_context_sql",
        f"SELECT 1 AS x WHERE id = '{SF_CONTEXT_SQL_PLACEHOLDER}'",
    )
    monkeypatch.setattr(config.settings, "snowflake_enabled", True)
    monkeypatch.setattr(config.settings, "snowflake_salesforce_context_row_limit", 10)

    sf15 = "006XX00000001AA"

    async def fake_execute(sql: str):
        assert sf15 in sql
        return [{"X": 1, "NAME": "Deal"}]

    monkeypatch.setattr(
        "snowflake_salesforce_context.execute_salesforce_context_sql",
        fake_execute,
    )
    out = await fetch_salesforce_context_rows(sf15)
    assert out["configured"] is True
    assert out["snowflake_enabled"] is True
    assert out["salesforce_opportunity_id"] == sf15
    assert out["columns"] == ["X", "NAME"]
    assert out["rows"][0]["NAME"] == "Deal"


@pytest.mark.asyncio
async def test_summarize_salesforce_context_markdown(monkeypatch):
    from sf_context_synth import summarize_salesforce_context_markdown

    monkeypatch.setattr(config.settings, "anthropic_api_key", "sk-test")

    async def fake_create(**kwargs):
        return SimpleNamespace(
            content=[SimpleNamespace(type="text", text="## Summary\n- One bullet")],
            stop_reason="end_turn",
        )

    mock_client = SimpleNamespace(
        messages=SimpleNamespace(create=AsyncMock(side_effect=fake_create))
    )
    monkeypatch.setattr("sf_context_synth.anthropic.AsyncAnthropic", lambda **kw: mock_client)

    md = await summarize_salesforce_context_markdown(
        "Acme", "BitsAI", "006XX00000001AA", '{"columns":["x"],"rows":[{"x":1}]}'
    )
    assert "Summary" in md
