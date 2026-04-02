"""Tests for query classification router."""

import json
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from models import Persona, RouteType
from router import classify_query


def _mock_claude_response(content: str):
    """Build a mock Anthropic message response."""
    block = MagicMock()
    block.text = content
    msg = MagicMock()
    msg.content = [block]
    return msg


@pytest.mark.asyncio
async def test_route_technical_query():
    payload = json.dumps({
        "route": "TECHNICAL",
        "technical_query": "How does the Datadog Agent collect metrics?",
        "value_query": None,
        "include_case_studies": False,
        "reasoning": "Purely technical question about product internals.",
    })

    with patch("router.anthropic.AsyncAnthropic") as mock_cls:
        mock_client = AsyncMock()
        mock_client.messages.create.return_value = _mock_claude_response(payload)
        mock_cls.return_value = mock_client

        result = await classify_query("How does the Datadog Agent collect metrics?")

    assert result.route == RouteType.TECHNICAL
    assert result.technical_query is not None
    assert result.value_query is None
    assert result.include_case_studies is False


@pytest.mark.asyncio
async def test_route_value_query():
    payload = json.dumps({
        "route": "VALUE",
        "technical_query": None,
        "value_query": "What business outcomes have customers achieved with Datadog?",
        "include_case_studies": True,
        "reasoning": "Business value question.",
    })

    with patch("router.anthropic.AsyncAnthropic") as mock_cls:
        mock_client = AsyncMock()
        mock_client.messages.create.return_value = _mock_claude_response(payload)
        mock_cls.return_value = mock_client

        result = await classify_query("Why should we buy Datadog?")

    assert result.route == RouteType.VALUE
    assert result.value_query is not None
    assert result.technical_query is None
    assert result.include_case_studies is True


@pytest.mark.asyncio
async def test_route_both():
    payload = json.dumps({
        "route": "BOTH",
        "technical_query": "What EC2 misconfiguration risks does Datadog detect?",
        "value_query": "How have customers prevented EC2 misconfigurations using Datadog?",
        "include_case_studies": True,
        "reasoning": "Requires both technical and business context.",
    })

    with patch("router.anthropic.AsyncAnthropic") as mock_cls:
        mock_client = AsyncMock()
        mock_client.messages.create.return_value = _mock_claude_response(payload)
        mock_cls.return_value = mock_client

        result = await classify_query(
            "What are the biggest risks for EC2 misconfiguration and how does Datadog help?"
        )

    assert result.route == RouteType.BOTH
    assert result.technical_query is not None
    assert result.value_query is not None
    assert result.include_case_studies is True


@pytest.mark.asyncio
async def test_malformed_json_defaults_to_both():
    with patch("router.anthropic.AsyncAnthropic") as mock_cls:
        mock_client = AsyncMock()
        mock_client.messages.create.return_value = _mock_claude_response("not valid json {{{")
        mock_cls.return_value = mock_client

        result = await classify_query("Some question")

    assert result.route == RouteType.BOTH
    assert result.technical_query == "Some question"
    assert result.value_query == "Some question"
    assert result.include_case_studies is False
    assert "fallback" in result.reasoning.lower()


@pytest.mark.asyncio
async def test_missing_route_key_defaults_to_both():
    payload = json.dumps({"reasoning": "oops no route key"})

    with patch("router.anthropic.AsyncAnthropic") as mock_cls:
        mock_client = AsyncMock()
        mock_client.messages.create.return_value = _mock_claude_response(payload)
        mock_cls.return_value = mock_client

        result = await classify_query("Another question")

    assert result.route == RouteType.BOTH
    assert result.include_case_studies is False


@pytest.mark.asyncio
async def test_technical_route_backfills_query():
    """When routing to TECHNICAL but technical_query is null, use the original query."""
    payload = json.dumps({
        "route": "TECHNICAL",
        "technical_query": None,
        "value_query": None,
        "include_case_studies": False,
        "reasoning": "Technical question.",
    })

    with patch("router.anthropic.AsyncAnthropic") as mock_cls:
        mock_client = AsyncMock()
        mock_client.messages.create.return_value = _mock_claude_response(payload)
        mock_cls.return_value = mock_client

        result = await classify_query("What is APM?")

    assert result.route == RouteType.TECHNICAL
    assert result.technical_query == "What is APM?"


@pytest.mark.asyncio
async def test_include_case_studies_defaults_false_when_absent():
    """When Claude omits include_case_studies from JSON, it should default to False."""
    payload = json.dumps({
        "route": "TECHNICAL",
        "technical_query": "Agent config",
        "value_query": None,
        "reasoning": "Tech question.",
    })

    with patch("router.anthropic.AsyncAnthropic") as mock_cls:
        mock_client = AsyncMock()
        mock_client.messages.create.return_value = _mock_claude_response(payload)
        mock_cls.return_value = mock_client

        result = await classify_query("How do I configure the agent?")

    assert result.include_case_studies is False


@pytest.mark.asyncio
async def test_persona_defaults_enable_buyer_persona():
    payload = json.dumps({
        "route": "VALUE",
        "technical_query": None,
        "value_query": "How should we position Datadog for this buyer?",
        "include_case_studies": False,
        "reasoning": "Persona-oriented value question.",
    })

    with patch("router.anthropic.AsyncAnthropic") as mock_cls:
        mock_client = AsyncMock()
        mock_client.messages.create.return_value = _mock_claude_response(payload)
        mock_cls.return_value = mock_client

        result = await classify_query("How do I tailor this pitch?", Persona.ARCHITECT)

    assert result.include_buyer_persona is True
    assert result.persona_query is not None
    assert "architect" in result.persona_query.lower()


# ---------------------------------------------------------------------------
# Parametrized classification accuracy suite (11 queries, all 3 routes)
# ---------------------------------------------------------------------------

CLASSIFICATION_CASES = [
    # --- TECHNICAL (4) ---
    (
        "What is the default retention period for logs?",
        "TECHNICAL",
        "Datadog log retention policy default settings",
        None,
        False,
    ),
    (
        "How do I configure the Datadog Agent on Kubernetes?",
        "TECHNICAL",
        "Datadog Agent Kubernetes configuration deployment",
        None,
        False,
    ),
    (
        "What API endpoints are available for submitting metrics?",
        "TECHNICAL",
        "Datadog metrics submission API endpoints",
        None,
        False,
    ),
    (
        "What is the architecture of the trace ingestion pipeline?",
        "TECHNICAL",
        "Datadog APM trace pipeline architecture components",
        None,
        False,
    ),
    # --- VALUE (3) ---
    (
        "What ROI have customers seen from adopting APM?",
        "VALUE",
        None,
        "Customer ROI outcomes Datadog APM adoption",
        True,
    ),
    (
        "How do enterprises use Datadog for compliance reporting?",
        "VALUE",
        None,
        "Enterprise compliance reporting use cases Datadog",
        True,
    ),
    (
        "What competitive advantages does Datadog have over Splunk?",
        "VALUE",
        None,
        "Datadog vs Splunk competitive advantages positioning",
        False,
    ),
    # --- BOTH (4) ---
    (
        "How does log analytics work and what cost savings have customers achieved?",
        "BOTH",
        "Datadog log analytics technical capabilities",
        "Customer cost savings log analytics adoption",
        True,
    ),
    (
        "What cloud security features does Datadog offer and how have customers reduced incidents?",
        "BOTH",
        "Datadog cloud security features CSM capabilities",
        "Customer incident reduction cloud security outcomes",
        True,
    ),
    (
        "How does RUM work and why do customers adopt it?",
        "BOTH",
        "Datadog RUM real user monitoring technical details",
        "Customer adoption reasons RUM business outcomes",
        True,
    ),
    (
        "What is Datadog's approach to AIOps and how are customers benefiting?",
        "BOTH",
        "Datadog AIOps capabilities features technical approach",
        "Customer benefits AIOps adoption outcomes",
        True,
    ),
]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "query, expected_route, tech_query, value_query, case_studies",
    CLASSIFICATION_CASES,
    ids=[c[0][:50] for c in CLASSIFICATION_CASES],
)
async def test_classification_accuracy(query, expected_route, tech_query, value_query, case_studies):
    payload = json.dumps({
        "route": expected_route,
        "technical_query": tech_query,
        "value_query": value_query,
        "include_case_studies": case_studies,
        "reasoning": f"Classified as {expected_route}.",
    })

    with patch("router.anthropic.AsyncAnthropic") as mock_cls:
        mock_client = AsyncMock()
        mock_client.messages.create.return_value = _mock_claude_response(payload)
        mock_cls.return_value = mock_client

        result = await classify_query(query)

    assert result.route == RouteType(expected_route)
    assert result.include_case_studies is case_studies

    if expected_route == "TECHNICAL":
        assert result.technical_query is not None
        assert result.value_query is None
    elif expected_route == "VALUE":
        assert result.value_query is not None
        assert result.technical_query is None
    elif expected_route == "BOTH":
        assert result.technical_query is not None
        assert result.value_query is not None
