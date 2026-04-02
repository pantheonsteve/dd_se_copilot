"""End-to-end integration tests using mocked agent endpoints and Claude API."""

import json
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def _mock_claude_response(content: str):
    block = MagicMock()
    block.text = content
    msg = MagicMock()
    msg.content = [block]
    return msg


ROUTER_RESPONSE = json.dumps({
    "route": "BOTH",
    "technical_query": "What EC2 misconfiguration risks does Datadog detect?",
    "value_query": "How have customers prevented EC2 misconfigurations with Datadog?",
    "persona_query": None,
    "include_case_studies": False,
    "include_buyer_persona": False,
    "reasoning": "Requires both technical capabilities and customer proof.",
})

SYNTH_RESPONSE = json.dumps({
    "synthesized_answer": "EC2 misconfiguration is a top risk. Datadog detects it via CSM.",
    "technical_confidence": "HIGH",
    "value_confidence": "MEDIUM",
    "sources_used": {
        "technical": ["csm-docs.md", "ec2-guide.md"],
        "value": ["customer-story.md"],
        "case_studies": [],
        "sec_filings": [],
        "buyer_persona": [],
    },
    "content_gaps": ["No specific EC2 case study found"],
    "discovery_questions": [
        "How are you enforcing IMDSv2 across your fleet?",
        "Do you have visibility into IAM roles on public instances?",
    ],
    "talk_track_version": "EC2 misconfiguration is one of the top cloud risks we see.",
})

TECH_AGENT_RESPONSE = {
    "answer": "Datadog CSM detects EC2 misconfigurations including open security groups [Source 1].",
    "sources": ["csm-docs.md", "ec2-guide.md"],
    "elapsed": 1.2,
    "llm": "claude",
}

VALUE_AGENT_RESPONSE = {
    "answer": "Customers using CSM have reduced misconfig incidents by 60% [Source 1].",
    "sources": ["customer-story.md"],
    "elapsed": 0.8,
    "llm": "claude",
}


class MockTransport(httpx.AsyncBaseTransport):
    """Mock transport that returns canned responses for agent URLs."""

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if "5050" in url:
            return httpx.Response(200, json=TECH_AGENT_RESPONSE)
        if "5051" in url:
            return httpx.Response(200, json=VALUE_AGENT_RESPONSE)
        return httpx.Response(404)


@pytest.fixture
def mock_claude():
    """Patch the Anthropic client for both router and synthesizer, returning
    the router response on the first call and the synth response on the second."""
    mock_client = AsyncMock()
    mock_client.messages.create.side_effect = [
        _mock_claude_response(ROUTER_RESPONSE),
        _mock_claude_response(SYNTH_RESPONSE),
    ]

    with (
        patch("router.anthropic.AsyncAnthropic", return_value=mock_client),
        patch("synthesizer.anthropic.AsyncAnthropic", return_value=mock_client),
    ):
        yield mock_client


@pytest.fixture
def mock_agents():
    """Patch httpx.AsyncClient to use the mock transport for agent calls."""
    original_init = httpx.AsyncClient.__init__

    def patched_init(self, *args, **kwargs):
        kwargs["transport"] = MockTransport()
        original_init(self, *args, **kwargs)

    with patch.object(httpx.AsyncClient, "__init__", patched_init):
        yield


@pytest.fixture
def client():
    from main import app
    return TestClient(app)


def test_full_query_pipeline(client, mock_claude, mock_agents):
    resp = client.post("/api/query", json={
        "query": "What are the biggest risks for EC2 misconfiguration and how does Datadog help?",
        "persona": "cto",
        "include_talk_track": True,
    })

    assert resp.status_code == 200
    data = resp.json()

    assert data["route"] == "BOTH"
    assert data["routing_reasoning"] != ""
    assert "EC2" in data["synthesized_answer"] or "misconfiguration" in data["synthesized_answer"]
    assert data["technical_confidence"] in ("HIGH", "MEDIUM", "LOW")
    assert data["value_confidence"] in ("HIGH", "MEDIUM", "LOW")
    assert data["talk_track"] is not None
    assert data["processing_time_ms"] > 0

    st = data["stage_timings_ms"]
    assert "router" in st
    assert "retrieval" in st
    assert "synthesis" in st
    assert "processors" in st

    assert len(data["discovery_questions"]) >= 1
    assert len(data["sources"]["technical"]) >= 1


def test_query_without_talk_track(client, mock_claude, mock_agents):
    resp = client.post("/api/query", json={
        "query": "How does APM work?",
        "include_talk_track": False,
    })

    assert resp.status_code == 200
    data = resp.json()
    assert data["talk_track"] is None


def test_query_response_shape(client, mock_claude, mock_agents):
    """Verify all expected fields are present in the response."""
    resp = client.post("/api/query", json={"query": "Tell me about Datadog"})
    assert resp.status_code == 200
    data = resp.json()

    required_fields = [
        "query", "route", "routing_reasoning", "synthesized_answer",
        "persona",
        "technical_confidence", "value_confidence", "sources",
        "content_gaps", "discovery_questions", "stage_timings_ms",
        "processing_time_ms",
    ]
    for field in required_fields:
        assert field in data, f"Missing field: {field}"

    assert "technical" in data["sources"]
    assert "value" in data["sources"]
    assert "case_studies" in data["sources"]
    assert "sec_filings" in data["sources"]
    assert "buyer_persona" in data["sources"]


def test_gaps_endpoint(client):
    resp = client.get("/api/gaps")
    assert resp.status_code == 200
    data = resp.json()
    assert "total_entries" in data
    assert "gaps_by_frequency" in data
