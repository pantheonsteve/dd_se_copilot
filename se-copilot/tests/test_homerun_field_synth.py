"""Tests for Homerun field draft LLM helper."""

import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from homerun_browser_automation import HOMERUN_TEMPLATE_GENERATED_HEADINGS  # noqa: E402
from homerun_field_synth import (  # noqa: E402
    SE_NEXT_STEPS_MAX_CHARS,
    SE_OUTSTANDING_RISKS_MAX_CHARS,
    _parse_field_json,
    _truncate,
    build_homerun_field_user_message,
    generate_homerun_field_values,
)


def test_parse_field_json_strips_fence():
    raw = '```json\n{"SE Next Steps": "a"}\n```'
    out = _parse_field_json(raw)
    assert out["SE Next Steps"] == "a"


def test_build_user_message_includes_prompt_and_company():
    msg = build_homerun_field_user_message(
        "Focus on risks",
        "Acme",
        "acme.com",
        "Note here",
        {"hypothesis": None},
        None,
    )
    assert "Focus on risks" in msg
    assert "Acme" in msg
    assert "acme.com" in msg
    assert "Note here" in msg
    assert "## Homerun opportunity snapshot" in msg


def test_build_user_message_dim_shows_selected_opportunity_name():
    msg = build_homerun_field_user_message(
        "x",
        "Waters Corp",
        "",
        "",
        {},
        {
            "OPPORTUNITY_NAME": "BitsAI expansion",
            "HOMERUN_STAGE": "Discovery",
            "OPPORTUNITY_UUID": "abc-123",
        },
    )
    assert "Selected Homerun opportunity" in msg
    assert "Official opportunity name (from Snowflake)" in msg
    assert "BitsAI expansion" in msg


def test_build_user_message_lists_other_linked_opportunities():
    msg = build_homerun_field_user_message(
        "go",
        "Acme",
        "",
        "",
        {},
        None,
        other_linked_opportunities=[
            {
                "opportunity_uuid": "uuid-a",
                "opportunity_name": "Renewal FY26",
                "homerun_stage": "Negotiation",
            }
        ],
    )
    assert "Other Homerun opportunities" in msg
    assert "Renewal FY26" in msg
    assert "uuid-a" in msg
    assert "Negotiation" in msg


@pytest.mark.asyncio
async def test_generate_homerun_field_values_mock_anthropic(monkeypatch):
    payload = {h: f"v-{i}" for i, h in enumerate(HOMERUN_TEMPLATE_GENERATED_HEADINGS)}
    text = json.dumps(payload)

    async def fake_create(**kwargs):
        return SimpleNamespace(
            content=[SimpleNamespace(type="text", text=text)],
            stop_reason="end_turn",
        )

    mock_client = SimpleNamespace(
        messages=SimpleNamespace(create=AsyncMock(side_effect=fake_create))
    )

    def fake_anthropic(**kw):
        return mock_client

    monkeypatch.setattr("homerun_field_synth.anthropic.AsyncAnthropic", fake_anthropic)

    out = await generate_homerun_field_values(
        "test",
        "Co",
        "",
        "",
        {},
        None,
    )
    assert out == payload
    mock_client.messages.create.assert_called_once()


@pytest.mark.asyncio
async def test_generate_truncates_se_next_steps(monkeypatch):
    long_steps = "x" * 500
    payload = {h: "ok" for h in HOMERUN_TEMPLATE_GENERATED_HEADINGS}
    payload["SE Next Steps"] = long_steps
    text = json.dumps(payload)

    async def fake_create(**kwargs):
        return SimpleNamespace(
            content=[SimpleNamespace(type="text", text=text)],
            stop_reason="end_turn",
        )

    mock_client = SimpleNamespace(
        messages=SimpleNamespace(create=AsyncMock(side_effect=fake_create))
    )

    monkeypatch.setattr("homerun_field_synth.anthropic.AsyncAnthropic", lambda **kw: mock_client)

    out = await generate_homerun_field_values("test", "Co", "", "", {}, None)
    assert len(out["SE Next Steps"]) <= SE_NEXT_STEPS_MAX_CHARS
    assert out["SE Next Steps"] == _truncate(long_steps, SE_NEXT_STEPS_MAX_CHARS)


@pytest.mark.asyncio
async def test_generate_truncates_se_outstanding_risks(monkeypatch):
    long_risks = "r" * 400
    payload = {h: "ok" for h in HOMERUN_TEMPLATE_GENERATED_HEADINGS}
    payload["SE Outstanding Risks"] = long_risks
    text = json.dumps(payload)

    async def fake_create(**kwargs):
        return SimpleNamespace(
            content=[SimpleNamespace(type="text", text=text)],
            stop_reason="end_turn",
        )

    mock_client = SimpleNamespace(
        messages=SimpleNamespace(create=AsyncMock(side_effect=fake_create))
    )

    monkeypatch.setattr("homerun_field_synth.anthropic.AsyncAnthropic", lambda **kw: mock_client)

    out = await generate_homerun_field_values("test", "Co", "", "", {}, None)
    assert len(out["SE Outstanding Risks"]) <= SE_OUTSTANDING_RISKS_MAX_CHARS
    assert out["SE Outstanding Risks"] == _truncate(long_risks, SE_OUTSTANDING_RISKS_MAX_CHARS)
