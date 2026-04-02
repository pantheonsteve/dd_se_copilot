"""Response synthesis using Claude to merge agent outputs into a unified SE-ready answer."""

import json
import logging
import re

import anthropic

from ddtrace.llmobs import LLMObs
from ddtrace.llmobs.decorators import llm

from anthropic_helpers import extract_text
from config import settings
from models import (
    AgentResponse,
    ConfidenceLevel,
    Persona,
    PipelineContext,
    SourcesUsed,
    SynthesizedResponse,
)

logger = logging.getLogger(__name__)

_FENCE_RE = re.compile(r"^```(?:json)?\s*\n(.*?)\n```\s*$", re.DOTALL)


def _strip_fences(text: str) -> str:
    """Remove markdown code fences that Claude sometimes wraps around JSON."""
    m = _FENCE_RE.match(text.strip())
    return m.group(1).strip() if m else text.strip()

SYNTHESIZER_SYSTEM_PROMPT = """\
You are a synthesis engine for a Sales Engineering knowledge system. You receive answers \
from up to five knowledge stores:

TECHNICAL LIBRARY RESPONSE: Facts about product capabilities, features, and technical details.
VALUE LIBRARY RESPONSE: Customer stories, use cases, business outcomes, and best practices.
CASE STUDIES RESPONSE (when available): Named customer case studies with deployment details \
and quantified business outcomes.
SEC 10-K FILINGS RESPONSE (when available): Strategic initiatives, risk factors, technology \
investments, and operational challenges extracted from a company's 10-K annual report. \
This response contains what the COMPANY says about its own strategy — it will NOT mention \
Datadog. Your job is to MAP these initiatives to Datadog capabilities.

BUYER PERSONA RESPONSE (when available): Role-specific goals, KPIs, decision criteria, \
objections, and preferred evidence for the selected buyer persona.

Your job is to synthesize these into a single, unified response that a Sales Engineer \
could use to prepare for or conduct a customer conversation.

Rules:
1. Lead with the customer's likely pain point or business concern
2. Pair every technical capability with a "so what" statement about business impact
3. When you have a customer story or case study that illustrates a technical point, weave it in naturally
4. If you only have technical detail without value context (or vice versa), note the gap
5. End with 2-3 discovery questions the SE could ask the customer
6. When BUYER PERSONA RESPONSE is present, tailor prioritization, proof points, and language \
to that persona's KPIs and decision criteria.

CRITICAL — When SEC 10-K filing data is present, you MUST perform strategic mapping:
7. For EACH strategic initiative, technology investment, or risk factor from the 10-K, \
explicitly map it to relevant Datadog products and capabilities from the technical and \
value library responses. Structure this as:
   - "The company's initiative/challenge" → "How Datadog addresses this" → "Relevant products/features"
8. Even if the 10-K does not mention observability, monitoring, or Datadog by name, \
infer the technology needs implied by each initiative (e.g. "cloud migration" implies \
need for cloud infrastructure monitoring; "digital transformation" implies need for APM \
and real user monitoring; "cybersecurity risk" implies need for Cloud SIEM and security monitoring).
9. When case studies are available, match them to the company's industry or similar \
strategic challenges to provide proof points.
10. Organize the SEC-to-Datadog mapping into clear sections by strategic theme (e.g. \
"Cloud & Infrastructure", "Application Performance", "Security & Compliance", "Cost Optimization").

FORMATTING — The synthesized_answer MUST use markdown formatting for scannability:
11. Use markdown ### headers for each strategic theme or major section \
(e.g. "### R&D Velocity & Software Platform Reliability"). Never use bold inline text as a section header.
12. When referencing a Datadog product or capability, always bold it: \
**APM**, **Cloud SIEM**, **RUM**, **Synthetic Monitoring**, **Log Management**, \
**Error Tracking**, **Infrastructure Monitoring**, **Database Monitoring**, \
**Observability Pipelines**, **Sensitive Data Scanner**, **Cloud Security Management**, etc.
13. When citing a case study, format it as a markdown blockquote callout on its own line:
    > **Case Study — CompanyName:** One-sentence outcome with quantified result if available.
14. At the end of each strategic theme section, include a brief summary line:
    **Datadog Relevance:** Comma-separated list of the specific Datadog products relevant to that theme.

Respond with a JSON object:
{
  "synthesized_answer": "The unified response text, written conversationally as an SE would speak",
  "technical_confidence": "HIGH" | "MEDIUM" | "LOW",
  "value_confidence": "HIGH" | "MEDIUM" | "LOW",
  "sources_used": {
    "technical": ["list of source references from technical response"],
    "value": ["list of source references from value response"],
    "case_studies": ["list of source references from case studies response"],
      "sec_filings": ["list of source references from SEC filings response"],
      "buyer_persona": ["list of source references from buyer persona response"]
  },
  "content_gaps": ["list of topics where one knowledge store had info but the other didn't"],
  "discovery_questions": ["2-3 questions the SE should ask the customer"],
  "talk_track_version": "A 3-4 sentence version of the answer optimized for verbal delivery on a call"
}"""

PERSONA_FRAMING = {
    Persona.CTO: (
        "Frame the response for a CTO. Lead with business impact, strategic outcomes, "
        "and organizational risk before diving into technical details. Emphasize total cost "
        "of ownership, platform-level architecture decisions, and measurable outcomes."
    ),
    Persona.ARCHITECT: (
        "Frame the response for an Architect. Lead with architecture patterns, integration "
        "coverage, and long-term maintainability. Emphasize standards, interoperability, and "
        "time-to-value for platform-wide adoption."
    ),
    Persona.CLOUD_ENGINEER: (
        "Frame the response for a Cloud Engineer. Lead with cloud operations, scalability, and "
        "real-time infrastructure troubleshooting. Emphasize automation, anomaly detection, and "
        "repeatable operational policies."
    ),
    Persona.SRE_DEVOPS_PLATFORM_OPS: (
        "Frame the response for SRE/DevOps/Platform Ops. Lead with reliability outcomes, on-call "
        "burden reduction, and incident response acceleration. Emphasize SLOs, alert quality, and "
        "post-mortem evidence."
    ),
    Persona.DEVOPS_LEAD: (
        "Frame the response for a DevOps Lead. Lead with technical implementation details "
        "and operational workflow before business outcomes. Emphasize automation, CI/CD "
        "integration, alert noise reduction, and day-to-day operational efficiency."
    ),
    Persona.SOFTWARE_ENGINEER: (
        "Frame the response for a Software Engineer. Lead with fast debugging and developer "
        "workflow fit. Emphasize service maps, instrumentation speed, and concrete steps to "
        "reduce time-to-resolution."
    ),
    Persona.FRONTEND_ENGINEER: (
        "Frame the response for a Front-end Engineer. Lead with user experience observability "
        "and browser-side diagnostics. Emphasize RUM, Synthetics, and clear correlation to "
        "backend/service signals."
    ),
    Persona.NETWORK_ENGINEER: (
        "Frame the response for a Network Engineer. Lead with topology visibility, network path "
        "analysis, and device/integration compatibility. Emphasize tracing, SNMP ecosystem fit, "
        "and hybrid network troubleshooting."
    ),
    Persona.TECH_EXECUTIVE: (
        "Frame the response for a technology executive. Lead with strategic outcomes, budget "
        "control, and engineering productivity. Emphasize platform consolidation, forecastability, "
        "and delivery risk reduction."
    ),
    Persona.FINOPS: (
        "Frame the response for FinOps. Lead with spend accountability, optimization actions, "
        "and forecasting confidence. Emphasize ownership mapping, waste reduction, and cost-aware "
        "operational decisions."
    ),
    Persona.PRODUCT_MANAGER_ANALYST: (
        "Frame the response for Product/UX analytics stakeholders. Lead with measurable user and "
        "business outcomes. Emphasize conversion, adoption, friction analysis, and shared "
        "business-plus-technical visibility."
    ),
    Persona.SQL_POWER_USER: (
        "Frame the response for SQL power users. Lead with query flexibility and cross-source "
        "analysis capabilities. Emphasize joins across telemetry domains, reusable analysis, and "
        "exportable reporting."
    ),
    Persona.CLOUD_GOVERNANCE_COMPLIANCE: (
        "Frame the response for governance/compliance teams. Lead with controls, auditability, "
        "and repeatable evidence generation. Emphasize policy coverage, queryable history, and "
        "compliance-ready reporting."
    ),
    Persona.BIZ_USER: (
        "Frame the response for business/operations stakeholders. Lead with shareable visibility "
        "for planning and coordination. Emphasize dashboards, SLO/uptime communication, and "
        "clear status reporting."
    ),
    Persona.SECURITY_ENGINEER: (
        "Frame the response for a Security Engineer. Lead with risk exposure, threat surface, "
        "and compliance implications before feature capabilities. Emphasize audit trails, "
        "least-privilege enforcement, detection coverage, and security posture management."
    ),
    Persona.PLATFORM_ENGINEER: (
        "Frame the response for a Platform Engineer. Lead with scalability, infrastructure "
        "abstraction, and developer experience before business context. Emphasize self-service "
        "tooling, multi-tenancy patterns, and platform reliability."
    ),
}


def _format_agent_section(label: str, resp: AgentResponse | None) -> str:
    if resp is None:
        return f"{label}: Not queried for this request."
    if resp.error:
        return f"{label}: Unavailable — {resp.error}"
    if not resp.answer:
        return f"{label}: No relevant documents found."

    source_lines = "\n".join(
        f"  [{i + 1}] {src}" for i, src in enumerate(resp.sources)
    )
    sources_block = f"\nSources:\n{source_lines}" if resp.sources else ""
    return f"{label}:\n{resp.answer}{sources_block}"


def _assess_confidence(resp: AgentResponse | None) -> ConfidenceLevel:
    """Determine confidence based on agent response quality."""
    if resp is None or resp.error:
        return ConfidenceLevel.LOW
    if not resp.answer or resp.answer == "No relevant documents found.":
        return ConfidenceLevel.LOW
    if len(resp.sources) >= 3:
        return ConfidenceLevel.HIGH
    if len(resp.sources) >= 1:
        return ConfidenceLevel.MEDIUM
    return ConfidenceLevel.LOW


@llm(model_name=settings.claude_model, name="synthesize", model_provider="anthropic")
async def synthesize(ctx: PipelineContext) -> SynthesizedResponse:
    """Synthesize agent responses from PipelineContext into a unified SE-ready answer."""
    technical = ctx.agent_responses.get("technical")
    value = ctx.agent_responses.get("value")
    case_studies = ctx.agent_responses.get("case_studies")
    sec_filings = ctx.agent_responses.get("sec_filings")
    buyer_persona = ctx.agent_responses.get("buyer_persona")

    tech_section = _format_agent_section("TECHNICAL LIBRARY RESPONSE", technical)
    value_section = _format_agent_section("VALUE LIBRARY RESPONSE", value)

    case_studies_section = ""
    if case_studies is not None:
        case_studies_section = "\n\n" + _format_agent_section(
            "CASE STUDIES RESPONSE", case_studies
        )

    sec_filings_section = ""
    if sec_filings is not None:
        sec_filings_section = "\n\n" + _format_agent_section(
            "SEC 10-K FILINGS RESPONSE", sec_filings
        )
    buyer_persona_section = ""
    if buyer_persona is not None:
        buyer_persona_section = "\n\n" + _format_agent_section(
            "BUYER PERSONA RESPONSE", buyer_persona
        )

    persona_instruction = ""
    if ctx.persona:
        persona_instruction = f"\n\nAUDIENCE INSTRUCTION: {PERSONA_FRAMING[ctx.persona]}"

    hypothesis_section = ""
    if ctx.hypothesis_context:
        hypothesis_section = (
            "\n\nCOMPANY TECHNOLOGY INTELLIGENCE (from Sales Hypothesis research):\n"
            "This is real-world technology stack, competitive landscape, and hiring data "
            "gathered from the company's job postings and technology footprint. Use this "
            "to ground your strategic mapping in their actual tools and infrastructure.\n"
            f"{ctx.hypothesis_context}"
        )

    user_message = (
        f"ORIGINAL QUERY: {ctx.query}\n\n"
        f"{tech_section}\n\n"
        f"{value_section}"
        f"{case_studies_section}"
        f"{sec_filings_section}"
        f"{buyer_persona_section}"
        f"{hypothesis_section}"
        f"{persona_instruction}\n\n"
        "Synthesize these into a unified response. Respond with ONLY a JSON object."
    )

    client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)

    tech_confidence = _assess_confidence(technical)
    value_confidence = _assess_confidence(value)

    try:
        response = await client.messages.create(
            model=settings.claude_model,
            max_tokens=4096,
            temperature=0.3,
            system=SYNTHESIZER_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_message}],
        )

        LLMObs.annotate(
            input_data=[
                {"role": "system", "content": SYNTHESIZER_SYSTEM_PROMPT},
                {"role": "user", "content": user_message},
            ],
            output_data=[{"role": "assistant", "content": extract_text(response)}],
            metadata={"temperature": 0.3, "max_tokens": 4096},
            metrics={
                "input_tokens": response.usage.input_tokens,
                "output_tokens": response.usage.output_tokens,
                "total_tokens": response.usage.input_tokens + response.usage.output_tokens,
            },
        )

        raw = _strip_fences(extract_text(response))
        data = json.loads(raw)

        return SynthesizedResponse(
            synthesized_answer=data.get("synthesized_answer", ""),
            technical_confidence=tech_confidence,
            value_confidence=value_confidence,
            sources_used=SourcesUsed(
                technical=data.get("sources_used", {}).get("technical", []),
                value=data.get("sources_used", {}).get("value", []),
                case_studies=data.get("sources_used", {}).get("case_studies", []),
                sec_filings=data.get("sources_used", {}).get("sec_filings", []),
                buyer_persona=data.get("sources_used", {}).get("buyer_persona", []),
            ),
            content_gaps=data.get("content_gaps", []),
            discovery_questions=data.get("discovery_questions", []),
            talk_track_version=data.get("talk_track_version", ""),
        )

    except (json.JSONDecodeError, KeyError, ValueError) as exc:
        logger.warning("Synthesis JSON parsing failed: %s", exc)
        combined = _build_fallback_answer(
            technical, value, case_studies, sec_filings, buyer_persona
        )
        return SynthesizedResponse(
            synthesized_answer=combined,
            technical_confidence=tech_confidence,
            value_confidence=value_confidence,
            sources_used=SourcesUsed(
                technical=technical.sources if technical else [],
                value=value.sources if value else [],
                case_studies=case_studies.sources if case_studies else [],
                sec_filings=sec_filings.sources if sec_filings else [],
                buyer_persona=buyer_persona.sources if buyer_persona else [],
            ),
            content_gaps=["Synthesis parsing failed; raw agent answers returned."],
            discovery_questions=[],
            talk_track_version="",
        )


def _build_fallback_answer(
    technical: AgentResponse | None,
    value: AgentResponse | None,
    case_studies: AgentResponse | None = None,
    sec_filings: AgentResponse | None = None,
    buyer_persona: AgentResponse | None = None,
) -> str:
    """Concatenate raw agent answers when Claude synthesis fails."""
    parts: list[str] = []
    if technical and technical.answer and not technical.error:
        parts.append(f"**Technical:**\n{technical.answer}")
    if value and value.answer and not value.error:
        parts.append(f"**Value:**\n{value.answer}")
    if case_studies and case_studies.answer and not case_studies.error:
        parts.append(f"**Case Studies:**\n{case_studies.answer}")
    if sec_filings and sec_filings.answer and not sec_filings.error:
        parts.append(f"**SEC 10-K Filings:**\n{sec_filings.answer}")
    if buyer_persona and buyer_persona.answer and not buyer_persona.error:
        parts.append(f"**Buyer Persona Guidance:**\n{buyer_persona.answer}")
    return "\n\n".join(parts) or "No information available from any knowledge store."
