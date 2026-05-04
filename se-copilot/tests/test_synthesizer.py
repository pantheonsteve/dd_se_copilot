"""Tests for response synthesis."""

import json
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from models import (
    AgentResponse,
    ConfidenceLevel,
    Persona,
    PipelineContext,
    RouteDecision,
    RouteType,
)
from synthesizer import _assess_confidence, synthesize


def _mock_claude_response(content: str):
    block = MagicMock()
    block.text = content
    msg = MagicMock()
    msg.content = [block]
    return msg


def _make_ctx(
    query: str = "Tell me about APM",
    persona: Persona | None = None,
    technical: AgentResponse | None = None,
    value: AgentResponse | None = None,
    case_studies: AgentResponse | None = None,
) -> PipelineContext:
    """Build a PipelineContext with the given agent responses pre-loaded."""
    responses: dict[str, AgentResponse] = {}
    if technical is not None:
        responses["technical"] = technical
    if value is not None:
        responses["value"] = value
    if case_studies is not None:
        responses["case_studies"] = case_studies

    return PipelineContext(
        query=query,
        persona=persona,
        route=RouteDecision(route=RouteType.BOTH),
        agent_responses=responses,
    )


def test_confidence_high_with_multiple_sources():
    resp = AgentResponse(answer="Good answer", sources=["a.md", "b.md", "c.md"])
    assert _assess_confidence(resp) == ConfidenceLevel.HIGH


def test_confidence_medium_with_few_sources():
    resp = AgentResponse(answer="Partial answer", sources=["a.md"])
    assert _assess_confidence(resp) == ConfidenceLevel.MEDIUM


def test_confidence_low_on_error():
    resp = AgentResponse(error="Agent timed out")
    assert _assess_confidence(resp) == ConfidenceLevel.LOW


def test_confidence_low_on_none():
    assert _assess_confidence(None) == ConfidenceLevel.LOW


def test_confidence_low_on_empty_answer():
    resp = AgentResponse(answer="No relevant documents found.", sources=[])
    assert _assess_confidence(resp) == ConfidenceLevel.LOW


@pytest.mark.asyncio
async def test_synthesize_both_agents():
    synth_output = json.dumps({
        "synthesized_answer": "Unified answer about monitoring.",
        "technical_confidence": "HIGH",
        "value_confidence": "MEDIUM",
        "sources_used": {
            "technical": ["doc1.md", "doc2.md"],
            "value": ["blog1.md"],
            "case_studies": [],
        },
        "content_gaps": ["No case study for APM specifically"],
        "discovery_questions": [
            "How are you monitoring latency today?",
            "What SLAs do you have in place?",
        ],
        "talk_track_version": "Customers typically see 40% faster MTTR with Datadog APM.",
    })

    tech = AgentResponse(answer="APM provides distributed tracing...", sources=["doc1.md", "doc2.md", "doc3.md"])
    val = AgentResponse(answer="Customers report faster MTTR...", sources=["blog1.md"])
    ctx = _make_ctx(technical=tech, value=val)

    with patch("synthesizer.anthropic.AsyncAnthropic") as mock_cls:
        mock_client = AsyncMock()
        mock_client.messages.create.return_value = _mock_claude_response(synth_output)
        mock_cls.return_value = mock_client

        result = await synthesize(ctx)

    assert "monitoring" in result.synthesized_answer.lower()
    assert result.technical_confidence == ConfidenceLevel.HIGH
    assert result.value_confidence == ConfidenceLevel.MEDIUM
    assert len(result.discovery_questions) == 2
    assert len(result.content_gaps) == 1
    assert result.talk_track_version != ""


@pytest.mark.asyncio
async def test_synthesize_technical_only():
    synth_output = json.dumps({
        "synthesized_answer": "Technical-only answer.",
        "technical_confidence": "HIGH",
        "value_confidence": "LOW",
        "sources_used": {"technical": ["doc1.md"], "value": [], "case_studies": []},
        "content_gaps": ["No value context available"],
        "discovery_questions": ["What outcomes matter most?"],
        "talk_track_version": "Short version.",
    })

    tech = AgentResponse(answer="Detailed technical info.", sources=["doc1.md", "doc2.md", "doc3.md"])
    ctx = _make_ctx(query="How does log ingestion work?", technical=tech)

    with patch("synthesizer.anthropic.AsyncAnthropic") as mock_cls:
        mock_client = AsyncMock()
        mock_client.messages.create.return_value = _mock_claude_response(synth_output)
        mock_cls.return_value = mock_client

        result = await synthesize(ctx)

    assert result.technical_confidence == ConfidenceLevel.HIGH
    assert result.value_confidence == ConfidenceLevel.LOW


@pytest.mark.asyncio
async def test_synthesize_with_persona():
    synth_output = json.dumps({
        "synthesized_answer": "For a CTO, the strategic impact...",
        "technical_confidence": "HIGH",
        "value_confidence": "HIGH",
        "sources_used": {"technical": ["doc.md"], "value": ["blog.md"], "case_studies": []},
        "content_gaps": [],
        "discovery_questions": ["What is your board's risk tolerance?"],
        "talk_track_version": "At the strategic level...",
    })

    tech = AgentResponse(answer="Tech answer.", sources=["doc.md", "d2.md", "d3.md"])
    val = AgentResponse(answer="Value answer.", sources=["blog.md", "b2.md", "b3.md"])
    ctx = _make_ctx(query="Tell me about security", persona=Persona.CTO, technical=tech, value=val)

    with patch("synthesizer.anthropic.AsyncAnthropic") as mock_cls:
        mock_client = AsyncMock()
        mock_client.messages.create.return_value = _mock_claude_response(synth_output)
        mock_cls.return_value = mock_client

        result = await synthesize(ctx)

    assert "strategic" in result.synthesized_answer.lower() or "cto" in result.synthesized_answer.lower()


@pytest.mark.asyncio
async def test_synthesize_with_case_studies():
    synth_output = json.dumps({
        "synthesized_answer": "Acme Corp reduced MTTR by 50% after deploying APM.",
        "technical_confidence": "HIGH",
        "value_confidence": "HIGH",
        "sources_used": {
            "technical": ["doc.md"],
            "value": ["blog.md"],
            "case_studies": ["acme-case-study.md"],
        },
        "content_gaps": [],
        "discovery_questions": ["What is your current MTTR?"],
        "talk_track_version": "Customers like Acme have halved their MTTR.",
    })

    tech = AgentResponse(answer="APM traces.", sources=["doc.md", "d2.md", "d3.md"])
    val = AgentResponse(answer="Business value.", sources=["blog.md"])
    cs = AgentResponse(answer="Acme Corp deployed Datadog APM...", sources=["acme-case-study.md"])
    ctx = _make_ctx(technical=tech, value=val, case_studies=cs)

    with patch("synthesizer.anthropic.AsyncAnthropic") as mock_cls:
        mock_client = AsyncMock()
        mock_client.messages.create.return_value = _mock_claude_response(synth_output)
        mock_cls.return_value = mock_client

        result = await synthesize(ctx)

    assert "acme" in result.synthesized_answer.lower()
    assert len(result.sources_used.case_studies) >= 1


@pytest.mark.asyncio
async def test_synthesize_fallback_on_bad_json():
    tech = AgentResponse(answer="Technical fallback.", sources=["doc.md"])
    ctx = _make_ctx(query="Some question", technical=tech)

    with patch("synthesizer.anthropic.AsyncAnthropic") as mock_cls:
        mock_client = AsyncMock()
        mock_client.messages.create.return_value = _mock_claude_response("not json at all!!!")
        mock_cls.return_value = mock_client

        result = await synthesize(ctx)

    assert "Technical fallback." in result.synthesized_answer
    assert "parsing failed" in result.content_gaps[0].lower()


@pytest.mark.asyncio
async def test_synthesize_includes_homerun_context():
    synth_output = json.dumps({
        "synthesized_answer": "Answer with deal context.",
        "technical_confidence": "HIGH",
        "value_confidence": "HIGH",
        "sources_used": {"technical": ["a.md"], "value": ["b.md"], "case_studies": []},
        "content_gaps": [],
        "discovery_questions": ["Q1?"],
        "talk_track_version": "Short.",
    })
    tech = AgentResponse(answer="T", sources=["a.md", "b.md", "c.md"])
    val = AgentResponse(answer="V", sources=["b.md"])
    ctx = _make_ctx(technical=tech, value=val)
    ctx.homerun_context = "### Test\n- **Homerun Stage:** Discovery"

    with patch("synthesizer.anthropic.AsyncAnthropic") as mock_cls:
        mock_client = AsyncMock()
        mock_client.messages.create.return_value = _mock_claude_response(synth_output)
        mock_cls.return_value = mock_client
        await synthesize(ctx)
        call_kwargs = mock_client.messages.create.call_args[1]
        user_content = call_kwargs["messages"][0]["content"]

    assert "HOMERUN OPPORTUNITY CONTEXT" in user_content
    assert "Discovery" in user_content
