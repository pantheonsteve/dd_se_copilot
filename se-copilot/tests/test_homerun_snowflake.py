"""Tests for Homerun Snowflake context loading (mocked, no real connection)."""

import sys
from pathlib import Path
from unittest.mock import patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from config import settings  # noqa: E402
from homerun_snowflake import (  # noqa: E402
    HomerunIdMismatchError,
    _format_activities,
    _format_dim_row,
    _load_homerun_context_sync,
    _search_opportunities_by_name_sync,
    fetch_homerun_dim_dict_sync,
    fetch_homerun_dim_for_fill_preview_sync,
)


class _FakeCursor:
    def __init__(self, dim_dict: dict, activity_rows: list[dict]):
        self._dim = dim_dict
        self._acts = activity_rows
        self._mode = "dim"

    def execute(self, sql, params=None):
        s = sql or ""
        if "DIM_HOMERUN" in s:
            self._mode = "dim"
        else:
            self._mode = "act"

    @property
    def description(self):
        if self._mode == "dim":
            return [(k,) for k in self._dim.keys()]
        if self._acts:
            return [(k,) for k in self._acts[0].keys()]
        return [("ACTIVITY_TYPE",), ("ACTIVITY_OPPORTUNITY_UUID",)]

    def fetchall(self):
        if self._mode == "dim":
            return [tuple(self._dim[k] for k in self._dim)]
        if not self._acts:
            return []
        keys = list(self._acts[0].keys())
        return [tuple(r.get(k) for k in keys) for r in self._acts]

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return None


class _FakeConn:
    def __init__(self, dim_dict: dict, activity_rows: list[dict]):
        self._dim = dim_dict
        self._acts = activity_rows

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return None

    def cursor(self):
        return _FakeCursor(self._dim, self._acts)


def test_format_dim_row_includes_opportunity_name():
    row = {
        "OPPORTUNITY_NAME": "Acme PoV",
        "OPPORTUNITY_UUID": "abc-123",
        "HOMERUN_STAGE": "Evaluation",
    }
    out = _format_dim_row(row, max_chars=5000)
    assert "Acme PoV" in out
    assert "abc-123" in out
    assert "Evaluation" in out


def test_format_activities_empty():
    assert _format_activities([], 5, 1000) == ""


def test_format_activities_one_row():
    rows = [
        {
            "ACTIVITY_TYPE": "Workshop",
            "ACTIVITY_USER_EMAIL": "se@example.com",
            "ACTIVITY_CREATED_TIMESTAMP_UTC": "2026-01-01 12:00:00",
        }
    ]
    out = _format_activities(rows, max_rows=5, max_chars=2000)
    assert "Workshop" in out
    assert "se@example.com" in out


def test_load_sync_not_enabled():
    with patch.object(settings, "snowflake_enabled", False):
        assert _load_homerun_context_sync("u1", None) is None


def test_load_sync_mismatch_sf_id(monkeypatch):
    monkeypatch.setattr(settings, "snowflake_transport", "connector")
    dim = {
        "OPPORTUNITY_UUID": "uuid-1",
        "SALESFORCE_OPPORTUNITY_ID": "006XX1",
        "OPPORTUNITY_NAME": "Deal A",
    }
    conn = _FakeConn(dim, [])
    monkeypatch.setattr(settings, "snowflake_enabled", True)
    monkeypatch.setattr(settings, "snowflake_account", "acct")
    monkeypatch.setattr(settings, "snowflake_user", "user")
    monkeypatch.setattr(settings, "snowflake_password", "pw")

    with patch("homerun_snowflake._snowflake_connect", return_value=conn):
        with pytest.raises(HomerunIdMismatchError):
            _load_homerun_context_sync("uuid-1", "006YY2")


def test_load_sync_success_with_dim_and_matching_sf(monkeypatch):
    monkeypatch.setattr(settings, "snowflake_transport", "connector")
    dim = {
        "OPPORTUNITY_UUID": "uuid-1",
        "SALESFORCE_OPPORTUNITY_ID": "006XX1",
        "OPPORTUNITY_NAME": "Deal A",
    }
    conn = _FakeConn(dim, [])
    monkeypatch.setattr(settings, "snowflake_enabled", True)
    monkeypatch.setattr(settings, "snowflake_account", "acct")
    monkeypatch.setattr(settings, "snowflake_user", "user")
    monkeypatch.setattr(settings, "snowflake_password", "pw")

    with patch("homerun_snowflake._snowflake_connect", return_value=conn):
        out = _load_homerun_context_sync("uuid-1", "006xx1")
    assert out is not None
    assert "Deal A" in out
    assert "Homerun opportunity" in out


def test_fetch_homerun_dim_dict_sync(monkeypatch):
    monkeypatch.setattr(settings, "snowflake_transport", "connector")
    dim = {
        "OPPORTUNITY_UUID": "uuid-1",
        "SALESFORCE_OPPORTUNITY_ID": "006XX1",
        "OPPORTUNITY_NAME": "Deal A",
        "SE_NEXT_STEPS": "Follow up",
    }
    conn = _FakeConn(dim, [])
    monkeypatch.setattr(settings, "snowflake_enabled", True)
    monkeypatch.setattr(settings, "snowflake_account", "acct")
    monkeypatch.setattr(settings, "snowflake_user", "user")
    monkeypatch.setattr(settings, "snowflake_password", "pw")

    with patch("homerun_snowflake._snowflake_connect", return_value=conn):
        got = fetch_homerun_dim_dict_sync("uuid-1", None)
    assert got is not None
    assert got["SE_NEXT_STEPS"] == "Follow up"


def test_search_opportunities_empty_query():
    assert _search_opportunities_by_name_sync("", 10) == []
    assert _search_opportunities_by_name_sync("   ", 10) == []


def test_fill_preview_sync_snowflake_disabled(monkeypatch):
    monkeypatch.setattr(settings, "snowflake_enabled", False)
    row, outcome = fetch_homerun_dim_for_fill_preview_sync("uuid-1")
    assert row is None
    assert outcome == "snowflake_disabled"


def test_fill_preview_sync_mcp_misconfigured_empty_command(monkeypatch):
    monkeypatch.setattr(settings, "snowflake_enabled", True)
    monkeypatch.setattr(settings, "snowflake_transport", "mcp")
    monkeypatch.setattr(settings, "snowflake_mcp_command", "")
    monkeypatch.setattr(settings, "snowflake_mcp_args_json", "[]")
    row, outcome = fetch_homerun_dim_for_fill_preview_sync("uuid-1")
    assert row is None
    assert outcome.startswith("misconfigured|")


def test_fill_preview_sync_misconfigured_no_auth(monkeypatch):
    monkeypatch.setattr(settings, "snowflake_transport", "connector")
    monkeypatch.setattr(settings, "snowflake_enabled", True)
    monkeypatch.setattr(settings, "snowflake_account", "acct")
    monkeypatch.setattr(settings, "snowflake_user", "user")
    monkeypatch.setattr(settings, "snowflake_password", "")
    monkeypatch.setattr(settings, "snowflake_private_key_path", "")
    row, outcome = fetch_homerun_dim_for_fill_preview_sync("uuid-1")
    assert row is None
    assert outcome.startswith("misconfigured|")


def test_fill_preview_sync_ok(monkeypatch):
    monkeypatch.setattr(settings, "snowflake_transport", "connector")
    dim = {
        "OPPORTUNITY_UUID": "uuid-1",
        "OPPORTUNITY_NAME": "Deal A",
        "SE_NEXT_STEPS": "x",
    }
    conn = _FakeConn(dim, [])
    monkeypatch.setattr(settings, "snowflake_enabled", True)
    monkeypatch.setattr(settings, "snowflake_account", "acct")
    monkeypatch.setattr(settings, "snowflake_user", "user")
    monkeypatch.setattr(settings, "snowflake_password", "pw")

    with patch("homerun_snowflake._snowflake_connect", return_value=conn):
        row, outcome = fetch_homerun_dim_for_fill_preview_sync("uuid-1")
    assert outcome == "ok"
    assert row is not None
    assert row.get("OPPORTUNITY_NAME") == "Deal A"
