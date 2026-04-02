"""Expansion Playbook synthesis — Claude merges research + agent outputs into a
sequenced, phased account expansion plan."""

import json
import logging
import re

import anthropic

from anthropic_helpers import extract_text
from config import settings
from expansion_models import ExistingFootprint
from models import AgentResponse

logger = logging.getLogger(__name__)

_FENCE_RE = re.compile(r"^```(?:json)?\s*\n(.*?)\n```\s*$", re.DOTALL)


def _strip_fences(text: str) -> str:
    m = _FENCE_RE.match(text.strip())
    return m.group(1).strip() if m else text.strip()


EXPANSION_SYSTEM_PROMPT = """\
You are an Account Expansion Playbook Engine for Datadog Sales Engineers. You receive \
structured company research, existing Datadog footprint data, validated product intelligence \
from the Librarian agent, buyer persona mapping, value evidence, and case studies. Your job \
is to synthesize everything into a sequenced, phased expansion plan.

CRITICAL CONTEXT: Most accounts already have a Datadog footprint. This is NOT a greenfield \
"land Datadog" tool. The goal is to expand product adoption, expand into new teams/BUs, or \
identify net-new use cases driven by company initiatives.

---

SEQUENCING RULES:

1. Phase 1 is ALWAYS the lowest-friction, highest-impact opportunity:
   - If there is an existing champion, Phase 1 leverages that relationship.
   - If there is a compliance or revenue-gating mandate, Phase 1 addresses it.
   - If Datadog is already deployed, Phase 1 expands from the existing footprint \
     (not a new product in a new team — that is Phase 2+).

2. Each subsequent phase MUST be triggered by a natural discovery from the previous phase. \
   Do NOT just list products in order of importance. Explain the causal chain: why does \
   success in Phase 1 unlock Phase 2? What question will the customer ask, or what gap \
   will they see, that creates the opening for the next product?

3. Separate opportunities by buyer. If two products are sold to the same persona on the \
   same team, they can be in the same phase. If they require different buyers or different \
   budget approvals, they MUST be separate phases — even if technically related.

4. Classify each opportunity by type:
   - "product_expansion" — selling a new Datadog product to a team that already uses Datadog
   - "new_team" — selling Datadog to a team within the same BU that does not currently use it
   - "new_bu" — selling Datadog to an entirely different business unit
   - "net_new_use_case" — selling Datadog for a use case driven by a new initiative \
     (AI/ML, compliance, cloud migration) that did not previously exist as a buying center

5. Net-new BU opportunities are the highest-value but hardest. They require a new champion, \
   new budget, and new evaluation. Sequence them later unless there is a specific trigger \
   (org restructure, acquisition, mandate from corporate).

---

PRODUCT ACCURACY RULES:

1. NEVER use category names as product names. Use the EXACT product names provided by the \
   Librarian agent. Examples of what NOT to do:
   - "Recommend CSPM" — wrong. Use "Cloud Security Management" (which includes CSPM as a capability).
   - "Deploy Datadog's SIEM" — wrong. Use "Cloud SIEM".
   - "Use container monitoring" — wrong. Specify which product: Infrastructure Monitoring, \
     APM, or Live Containers.

2. Always include the specific capability within the product. Do NOT just say \
   "Infrastructure Monitoring" — say "Infrastructure Monitoring with container-level \
   visibility for Kubernetes environments" or similar.

3. If a product has tiers or editions, specify which tier is relevant and why.

4. Map capabilities to competitive tools precisely. Do NOT say "Datadog replaces Splunk." \
   Say "Cloud SIEM and Log Management replace Splunk's SIEM and log analytics capabilities, \
   while Observability Pipelines Worker reduces Splunk ingest volume."

5. Use ONLY product names that appear in the LIBRARIAN PRODUCT INTELLIGENCE section below. \
   If the Librarian did not mention a product, do not recommend it.

---

EXISTING FOOTPRINT RULES:

1. NEVER recommend a product the customer already has UNLESS the recommendation is \
   specifically about expanding that product to a new team or BU. In that case, \
   explicitly say so.

2. When recommending expansion of an existing product to a new team, frame it clearly: \
   "The account already uses {product} in {team}. This opportunity extends {product} \
   coverage to {new team}, which currently relies on {competitive tool}."

3. Use the existing footprint as the anchor for the expansion story: "Your team already \
   sees the value of X — here's how adding Y gives you {benefit} that X alone can't provide."

4. If no existing footprint data is provided, note this as a content gap and recommend \
   the AE validate the current deployment before executing the playbook.

---

DISPLACEMENT CONFIDENCE RULES:

1. For tools marked as CONFIRMED or LIKELY competitive targets, recommend specific \
   displacement strategies.

2. For UNVERIFIED tools, generate a discovery question instead of a displacement \
   recommendation. Example: "We've seen signals suggesting SolarWinds may be in your \
   environment — is that still actively managed, or is it a legacy remnant?"

3. NEVER claim a tool is in use if the confidence is unverified. Frame it as a question.

Set displacement_confidence to "confirmed", "likely", or "unverified" for each opportunity.

---

OUTPUT FORMAT:

Respond with ONLY a JSON object matching this schema:

{
  "company_name": "string",
  "domain": "string",
  "generated_at": "ISO 8601 timestamp",
  "current_footprint_summary": "1-2 sentence summary of what DD products are deployed and where",
  "current_champion": "name or null",
  "opportunities": [
    {
      "phase": 1,
      "opportunity_name": "descriptive name",
      "products": [
        {
          "product_name": "exact Datadog product name",
          "sku_or_tier": "tier if relevant, else null",
          "key_capabilities": ["capability 1", "capability 2"],
          "why_this_product": "1-2 sentences",
          "replaces": ["competitive tool name"]
        }
      ],
      "target_team_or_bu": "team or BU name",
      "target_persona": {
        "name": "person name or null",
        "title": "role title",
        "why_this_person": "why they are the buyer",
        "relationship_to_champion": "how they connect to the existing champion or null"
      },
      "business_case": "2-3 sentences grounded in company context",
      "urgency": "high|medium|low — with rationale in the business_case",
      "trigger_from_previous": "what success in previous phase unlocks this, or null for Phase 1",
      "displaces": ["tool1", "tool2"],
      "displacement_confidence": "confirmed|likely|unverified",
      "case_study_reference": "most relevant case study with outcome metrics, or null",
      "roi_evidence": "quantified business value if available, or null",
      "conversation_opener": "2-3 sentences tailored to this opportunity",
      "discovery_questions": ["question 1", "question 2", "question 3"],
      "success_metrics": ["metric 1", "metric 2"],
      "estimated_timeline": "e.g. 30-60 days to POV, 90 days to production",
      "opportunity_type": "product_expansion|new_team|new_bu|net_new_use_case"
    }
  ],
  "total_opportunities": 3,
  "opportunity_types": {"product_expansion": 2, "new_team": 1},
  "estimated_total_expansion_arr": "rough estimate or null",
  "content_gaps": ["what information is missing"],
  "key_assumptions": ["what assumptions the plan is built on"],
  "recommended_next_action": "the single most important thing the AE should do next"
}
"""


def _format_agent_section(label: str, resp: AgentResponse | None) -> str:
    if resp is None:
        return f"{label}: Not available."
    if resp.error:
        return f"{label}: Unavailable — {resp.error}"
    if not resp.answer:
        return f"{label}: No relevant data found."
    return f"{label}:\n{resp.answer}"


def _format_footprint(footprint: ExistingFootprint | None) -> str:
    if footprint is None:
        return (
            "EXISTING DATADOG FOOTPRINT:\n"
            "No footprint data provided. Flag this as a content gap — the AE should "
            "validate the current Datadog deployment before executing this playbook."
        )

    parts = ["EXISTING DATADOG FOOTPRINT:"]
    if footprint.products:
        parts.append(f"  Products deployed: {', '.join(footprint.products)}")
    else:
        parts.append("  Products deployed: Unknown")
    if footprint.teams_using:
        parts.append(f"  Teams using Datadog: {', '.join(footprint.teams_using)}")
    if footprint.known_champions:
        parts.append(f"  Known champions: {', '.join(footprint.known_champions)}")
    if footprint.approximate_spend:
        parts.append(f"  Approximate spend: {footprint.approximate_spend}")
    if footprint.deployment_scope:
        parts.append(f"  Deployment scope: {footprint.deployment_scope}")

    return "\n".join(parts)


def _format_research_section(research: dict) -> str:
    """Format CompanyResearch dict into a readable context block."""
    parts: list[str] = []

    parts.append(f"Company: {research.get('company_name', 'Unknown')}")
    parts.append(f"Domain: {research.get('domain', 'N/A')}")
    parts.append(f"Public Company: {'Yes' if research.get('is_public') else 'No'}")

    if research.get("industry"):
        parts.append(f"Industry: {research['industry']}")
    if research.get("employee_count"):
        parts.append(f"Employee Count: ~{research['employee_count']}")
    if research.get("description"):
        parts.append(f"Description: {research['description']}")
    if research.get("strategic_priorities"):
        parts.append(f"Strategic Priorities: {', '.join(research['strategic_priorities'])}")
    if research.get("risk_factors"):
        parts.append(f"Risk Factors: {', '.join(research['risk_factors'])}")
    if research.get("technology_investments"):
        parts.append(f"Technology Investments: {', '.join(research['technology_investments'])}")

    landscape = research.get("technology_landscape", {})
    techs = landscape.get("technologies", [])
    if techs:
        confirmed = [t for t in techs if t.get("confidence") == "confirmed"]
        likely = [t for t in techs if t.get("confidence") == "likely"]
        unverified = [t for t in techs if t.get("confidence") == "unverified"]

        parts.append(f"\nTechnology Landscape ({len(techs)} technologies):")
        for label, group in [
            ("CONFIRMED", confirmed), ("LIKELY", likely), ("UNVERIFIED", unverified)
        ]:
            if group:
                names = [
                    f"{t.get('canonical_name', '?')}"
                    f"{' [COMPETITIVE]' if t.get('is_competitive_target') else ''}"
                    for t in group
                ]
                parts.append(f"  {label}: {', '.join(names)}")
    else:
        for key, label in [
            ("current_observability_tools", "Observability Tools"),
            ("current_cloud_platforms", "Cloud Platforms"),
            ("current_infrastructure", "Infrastructure"),
            ("current_security_tools", "Security Tools"),
            ("current_databases", "Databases"),
            ("current_message_queues", "Message Queues"),
            ("current_languages", "Languages / Frameworks"),
            ("current_cicd_tools", "CI/CD Tools"),
        ]:
            if research.get(key):
                parts.append(f"  {label}: {', '.join(research[key])}")

    if research.get("competitive_displacement_targets"):
        parts.append(
            f"\nCompetitive Displacement Targets: "
            f"{', '.join(research['competitive_displacement_targets'])}"
        )

    parts.append(f"\nHiring Velocity: {research.get('hiring_velocity', 'unknown')}")
    if research.get("key_hiring_themes"):
        parts.append(f"Hiring Themes: {', '.join(research['key_hiring_themes'])}")

    if research.get("key_personas"):
        parts.append("\nKey Personas:")
        for p in research["key_personas"][:10]:
            parts.append(
                f"  - {p.get('name', 'N/A')} — {p.get('title', 'N/A')} "
                f"({p.get('seniority', '')})"
            )

    if research.get("recommended_entry_persona"):
        ep = research["recommended_entry_persona"]
        parts.append(f"\nRecommended Entry Persona: {ep.get('title', 'N/A')}")
        if ep.get("name"):
            parts.append(f"  Name: {ep['name']}")

    return "\n".join(parts)


async def synthesize_expansion_playbook(
    research: dict,
    agent_responses: dict[str, AgentResponse],
    existing_footprint: ExistingFootprint | None = None,
    hypothesis_data: dict | None = None,
    strategic_overview_data: dict | None = None,
    additional_context: str | None = None,
) -> dict:
    """Call Claude to produce the Expansion Playbook JSON.

    Returns a dict matching the ExpansionPlaybook schema.
    """
    research_section = _format_research_section(research)
    footprint_section = _format_footprint(existing_footprint)

    librarian = agent_responses.get("librarian")
    buyer_persona = agent_responses.get("buyer_persona")
    value = agent_responses.get("value")
    case_studies = agent_responses.get("case_studies")

    user_parts = [
        f"COMPANY RESEARCH:\n{research_section}",
        "",
        footprint_section,
        "",
        _format_agent_section("LIBRARIAN PRODUCT INTELLIGENCE", librarian),
        "",
        _format_agent_section("BUYER PERSONA INTELLIGENCE", buyer_persona),
        "",
        _format_agent_section("VALUE & ROI EVIDENCE", value),
        "",
        _format_agent_section("CASE STUDIES", case_studies),
    ]

    if hypothesis_data:
        md = hypothesis_data.get("hypothesis_markdown", "")
        if md:
            user_parts.extend([
                "",
                f"EXISTING SALES HYPOTHESIS (for context — do not duplicate, build on it):\n{md[:3000]}",
            ])

    if strategic_overview_data:
        answer = ""
        if isinstance(strategic_overview_data, dict):
            resp = strategic_overview_data.get("response", {})
            if isinstance(resp, dict):
                answer = resp.get("synthesized_answer", "")
            elif hasattr(resp, "synthesized_answer"):
                answer = resp.synthesized_answer
        if answer:
            user_parts.extend([
                "",
                f"EXISTING STRATEGIC OVERVIEW (for context):\n{answer[:3000]}",
            ])

    if additional_context:
        user_parts.extend(["", f"ADDITIONAL CONTEXT FROM AE/SE:\n{additional_context}"])

    user_parts.extend([
        "",
        "Generate the Account Expansion Playbook. Respond with ONLY a JSON object.",
    ])

    user_message = "\n".join(user_parts)

    client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)

    try:
        response = await client.messages.create(
            model=settings.claude_model,
            max_tokens=8000,
            temperature=0.3,
            system=EXPANSION_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_message}],
        )

        raw = _strip_fences(extract_text(response))
        data = json.loads(raw)
        return data

    except (json.JSONDecodeError, KeyError, ValueError) as exc:
        logger.warning("Expansion synthesis JSON parsing failed: %s", exc)
        return _fallback_playbook(research, agent_responses, existing_footprint, str(exc))

    except Exception as exc:
        logger.error("Expansion synthesis failed: %s", exc)
        return _fallback_playbook(research, agent_responses, existing_footprint, str(exc))


def _fallback_playbook(
    research: dict,
    agent_responses: dict[str, AgentResponse],
    footprint: ExistingFootprint | None,
    error_msg: str,
) -> dict:
    """Build a minimal playbook when synthesis fails."""
    return {
        "company_name": research.get("company_name", "Unknown"),
        "domain": research.get("domain", ""),
        "generated_at": "",
        "current_footprint_summary": (
            f"Products: {', '.join(footprint.products)}" if footprint and footprint.products
            else "No footprint data."
        ),
        "current_champion": (
            footprint.known_champions[0] if footprint and footprint.known_champions else None
        ),
        "opportunities": [],
        "total_opportunities": 0,
        "opportunity_types": {},
        "estimated_total_expansion_arr": None,
        "content_gaps": [f"Synthesis failed: {error_msg}"],
        "key_assumptions": [],
        "recommended_next_action": "Retry playbook generation or review raw agent data.",
    }
