"""Query classification router using Claude."""

import json
import logging
import re

import anthropic

from ddtrace.llmobs import LLMObs
from ddtrace.llmobs.decorators import llm

from anthropic_helpers import extract_text
from config import settings
from models import Persona, RouteDecision, RouteType

logger = logging.getLogger(__name__)

_FENCE_RE = re.compile(r"^```(?:json)?\s*\n(.*?)\n```\s*$", re.DOTALL)


def _strip_fences(text: str) -> str:
    """Remove markdown code fences that Claude sometimes wraps around JSON."""
    m = _FENCE_RE.match(text.strip())
    return m.group(1).strip() if m else text.strip()

ROUTER_SYSTEM_PROMPT = """\
You are a query router for a Sales Engineering knowledge system. You have two primary \
knowledge stores and two optional stores:

TECHNICAL LIBRARY: Contains product documentation, API specs, technical architecture, \
configuration guides, release notes, and feature specifications. Best for questions about \
what the product does, how features work, technical details, and implementation specifics.

VALUE LIBRARY: Contains blog posts, case studies, customer stories, tutorials, solution \
briefs, and best practice guides. Best for questions about why features matter, how \
customers use them, business outcomes, competitive positioning, and real-world \
implementation patterns.

CASE STUDIES LIBRARY (optional): Contains detailed customer case studies with named \
companies, deployment specifics, and quantified outcomes. Include this when the query \
would benefit from specific customer proof points or named references.

SEC 10-K FILINGS (optional): Contains parsed 10-K annual reports from the SEC with \
strategic initiatives, risk factors, management discussion & analysis, and financial \
performance data for publicly traded companies. Include this when the query relates to \
a specific company's strategy, financial performance, competitive position, or industry \
headwinds.

Given a user query, determine the optimal routing:
- TECHNICAL: Query is purely about product capabilities, features, or technical specs
- VALUE: Query is purely about business value, customer outcomes, or use cases
- BOTH: Query requires both technical detail AND business context to answer well

BUYER PERSONA LIBRARY (optional): Contains role-specific buyer profiles including priorities, \
KPIs, decision criteria, common objections, and discovery tactics for Datadog buying motions. \
Include this when persona context is provided or when a query asks how to tailor messaging for \
a specific role.

Also decide whether case studies, SEC 10-K filings, and/or buyer persona libraries should be consulted (true/false each).

When routing to BOTH, rewrite the query into two optimized sub-queries:
- technical_query: Focused on product capabilities and technical mechanisms
- value_query: Focused on customer outcomes, use cases, and business impact

IMPORTANT — When include_case_studies is true, you MUST also produce a case_study_query. \
The case_study_query must be optimized for finding INDUSTRY-SIMILAR companies and analogous \
use cases in the case studies library. Do NOT repeat the value_query. Instead, focus the \
case_study_query on: the prospect's industry vertical and sub-vertical, peer company types \
and competitors, comparable technical challenges (e.g. high-traffic live events, real-time \
transactions, peak load handling, global scale), and deployment patterns similar to what \
the prospect likely faces. Include industry synonyms and related terms (e.g. for a gaming \
company: "gaming, betting, fantasy sports, wagering, game servers, live events, esports"). \
The goal is to surface case studies from companies in the same or adjacent industries.

IMPORTANT — When include_sec_filings is true, you MUST also produce a sec_query. The \
sec_query must be written to extract BUSINESS STRATEGIC INITIATIVES from the 10-K filing \
WITHOUT mentioning Datadog or any vendor. Focus the sec_query on: strategic priorities, \
digital transformation plans, technology modernization, cloud migration, operational \
efficiency goals, risk factors related to IT/security/compliance, software and data \
platform investments, and any technology challenges described in the filing. The other \
agents will handle mapping these initiatives to Datadog capabilities — the sec_query \
should only extract what the company itself says about its strategy and challenges.

Respond with ONLY a JSON object, no other text:
{
  "route": "TECHNICAL" | "VALUE" | "BOTH",
  "technical_query": "optimized query for technical library (null if route is VALUE)",
  "value_query": "optimized query for value library (null if route is TECHNICAL)",
  "case_study_query": "query optimized for finding industry-similar case studies with vertical, peer types, and analogous challenges (null if include_case_studies is false)",
  "sec_query": "query focused on extracting business strategic initiatives from the 10-K (null if include_sec_filings is false)",
  "persona_query": "query focused on persona goals, objections, and talk-track guidance (null if include_buyer_persona is false)",
  "include_case_studies": true | false,
  "include_sec_filings": true | false,
  "include_buyer_persona": true | false,
  "reasoning": "one sentence explaining the routing decision"
}"""


@llm(model_name=settings.claude_model, name="classify_query", model_provider="anthropic")
async def classify_query(query: str, persona: Persona | None = None) -> RouteDecision:
    """Classify a query and determine which agent(s) to route to."""
    client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)
    persona_hint = persona.value if persona else "none"
    user_message = f"Persona: {persona_hint}\nQuery: {query}"

    try:
        response = await client.messages.create(
            model=settings.claude_model,
            max_tokens=2000,
            temperature=0.3,
            system=ROUTER_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_message}],
        )

        LLMObs.annotate(
            input_data=[
                {"role": "system", "content": ROUTER_SYSTEM_PROMPT},
                {"role": "user", "content": user_message},
            ],
            output_data=[{"role": "assistant", "content": extract_text(response)}],
            metadata={"temperature": 0.3, "max_tokens": 2000},
            metrics={
                "input_tokens": response.usage.input_tokens,
                "output_tokens": response.usage.output_tokens,
                "total_tokens": response.usage.input_tokens + response.usage.output_tokens,
            },
        )

        raw = _strip_fences(extract_text(response))
        data = json.loads(raw)

        route = RouteType(data["route"])
        technical_query = data.get("technical_query")
        value_query = data.get("value_query")
        case_study_query = data.get("case_study_query")
        sec_query = data.get("sec_query")
        persona_query = data.get("persona_query")
        include_case_studies = bool(data.get("include_case_studies", False))
        include_sec_filings = bool(data.get("include_sec_filings", False))
        include_buyer_persona = bool(data.get("include_buyer_persona", bool(persona)))
        reasoning = data.get("reasoning", "")

        if route == RouteType.TECHNICAL and not technical_query:
            technical_query = query
        elif route == RouteType.VALUE and not value_query:
            value_query = query
        elif route == RouteType.BOTH:
            technical_query = technical_query or query
            value_query = value_query or query

        if include_case_studies and not case_study_query:
            case_study_query = value_query or technical_query or query

        if include_sec_filings and not sec_query:
            sec_query = (
                "What are the key strategic initiatives, technology investments, "
                "digital transformation priorities, operational challenges, and "
                "risk factors described in the annual report?"
            )
        if include_buyer_persona and not persona_query:
            if persona:
                persona_query = (
                    f"What are this {persona.value} persona's primary objectives, KPIs, "
                    "decision criteria, objections, and recommended Datadog discovery talk track?"
                )
            else:
                persona_query = (
                    "What buyer persona priorities, KPIs, objections, and decision criteria "
                    "are relevant to this question?"
                )

        return RouteDecision(
            route=route,
            technical_query=technical_query,
            value_query=value_query,
            case_study_query=case_study_query,
            sec_query=sec_query,
            persona_query=persona_query,
            include_case_studies=include_case_studies,
            include_sec_filings=include_sec_filings,
            include_buyer_persona=include_buyer_persona,
            reasoning=reasoning,
        )

    except (json.JSONDecodeError, KeyError, ValueError) as exc:
        logger.warning("Router classification failed, defaulting to BOTH: %s", exc)
        return RouteDecision(
            route=RouteType.BOTH,
            technical_query=query,
            value_query=query,
            include_case_studies=False,
            include_buyer_persona=bool(persona),
            persona_query=(
                f"What are this {persona.value} persona's priorities and objections for Datadog?"
                if persona else None
            ),
            reasoning="Classification failed; routing to both agents as fallback.",
        )
