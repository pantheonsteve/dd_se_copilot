"""Sales Hypothesis synthesis using Claude to merge company research + agent outputs."""

import json
import logging
import re
from datetime import datetime, timezone

import anthropic

from anthropic_helpers import extract_text
from config import settings
from models import AgentResponse

logger = logging.getLogger(__name__)

_FENCE_RE = re.compile(r"^```(?:json)?\s*\n(.*?)\n```\s*$", re.DOTALL)


def _strip_fences(text: str) -> str:
    m = _FENCE_RE.match(text.strip())
    return m.group(1).strip() if m else text.strip()


HYPOTHESIS_SYSTEM_PROMPT = """\
You are a Sales Hypothesis Engine for Datadog Sales Engineers. You receive structured \
company research data and responses from multiple knowledge agents. Your job is to \
synthesize everything into a strategic Sales Hypothesis — a concise, evidence-based \
framework an AE or SE can use to approach the account.

This hypothesis is the FIRST document in a three-step pipeline:
  1. Sales Hypothesis (this) → "Why engage this account?"
  2. Strategic Overview (separate) → "What to talk about?" (deep 10-K mapping)
  3. Demo Plan (separate) → "How to show the product?"

Focus on what makes THIS document unique: the testable hypothesis, competitive \
displacement map, technology landscape, and recommended approach. Do NOT duplicate \
deep strategic theme analysis or extensive case study citations — those belong in \
the Strategic Overview.

You will receive:
- COMPANY RESEARCH: Structured data about the company (tech stack, hiring signals, \
key personas, strategic priorities, competitive landscape).
- BUYER PERSONA INTELLIGENCE: Role-specific goals, KPIs, objections, and discovery tactics \
for the recommended entry persona.
- VALUE & CASE STUDIES: Relevant customer stories, business outcomes, and proof points.
- TECHNICAL CAPABILITIES: Datadog product capabilities mapped to the company's needs.

Produce a structured Sales Hypothesis in markdown format with these exact sections:

# SALES HYPOTHESIS: {Company Name}

## 1. COMPANY SNAPSHOT
1-2 sentences max. Who is this company and what is driving their technology decisions \
right now? For public companies, one key data point from the 10-K. For private \
companies, ground in observable hiring and tech signals. Keep this extremely brief.

## 2. TECHNOLOGY LANDSCAPE
- **Current Stack:** List technologies grouped by confidence tier when confidence \
data is available:
  - CONFIRMED (detected by 2+ sources or live on website): list with signal counts
  - LIKELY (strong single-source signal or inferred dependency): list with context
  - UNVERIFIED (weak signal, validate during discovery): list with caveats
  Mark competitive displacement targets with a ✕ symbol.
- **Datadog Opportunity:** Which Datadog products map to their stack and gaps
- **Competitive Displacement:** Specific tools we would replace and why. \
Use assertive language for CONFIRMED competitive tools ("They run Splunk — \
consolidation opportunity is clear"). Use softer language for LIKELY tools \
("Data suggests AppDynamics may be in use — validate during discovery"). \
Never recommend displacement of UNVERIFIED tools — instead add them to \
discovery questions.

## 3. STRATEGIC HYPOTHESIS
Write this as a single hypothesis statement:
"We believe {Company} is prioritizing {initiative} because {evidence}. \
This creates an opportunity to {value proposition} by {specific DD capability}. \
The urgency is {high/medium/low} because {timing signal}."

## 4. RECOMMENDED APPROACH
- **Primary Persona:** {title, name if known} — {why this person}
- **Entry Product:** {which DD product to lead with} — {why}
- **Conversation Opener:** 2-3 sentences the AE can use in outreach
- **Discovery Questions:** 3-5 questions grounded in the hypothesis. If there are \
UNVERIFIED competitive technologies, include 1-2 questions to validate them, e.g., \
"We've seen signals suggesting you may still have Nagios in your environment — is \
that still in active use or a remnant from an earlier stack?"

## 5. OBJECTION FORECAST
2-3 likely objections based on the persona, competitive landscape, and industry, \
each with a concise response strategy.

## 6. KEY ASSUMPTIONS
1-2 sentences: what are the critical assumptions that could make this hypothesis wrong? \
What should the AE validate first?

If technology confidence data is provided, always include this paragraph at the end \
of Key Assumptions:
"Technology Confidence Note: Tech stack data is derived from Sumble (job posts and \
employee profiles) and BuiltWith (live website scanning). Technologies marked as \
'confirmed' were detected by two or more independent sources or verified live on \
the company's website. Technologies marked as 'likely' have strong single-source \
evidence. Technologies marked as 'unverified' were detected by a single source with \
limited supporting context and should be validated during discovery. The absence of \
a technology does not confirm it is not in use — it may simply not appear in \
observable sources."

---

Rules:
1. Every claim must be grounded in evidence from the provided data. Cite the source \
(e.g., "per 10-K filing", "based on hiring data", "per case study", "confirmed in \
[date] call note", "per pre-call brief"). When EXISTING COMPANY ARTIFACTS are \
provided, treat confirmed call note data as higher-confidence evidence than \
external research signals. Stakeholders, pain points, objections, and tech stack \
items confirmed on actual calls should take precedence over inferred data from \
BuiltWith or job postings.
2. Be specific — use actual product names, actual tool names, actual persona titles.
3. When data is sparse, say so explicitly rather than fabricating details.
4. The hypothesis should be actionable within 48 hours of reading it.
5. Write for an experienced SE audience — no fluff, no generic statements.
6. Do NOT include a standalone "Proof Points" or "Case Studies" section — the Strategic \
Overview handles that in depth. You may reference a case study inline if it directly \
supports the hypothesis statement.

Respond with a JSON object:
{
  "hypothesis_markdown": "The full markdown document as specified above",
  "confidence_level": "high" | "medium" | "low",
  "entry_product": "The recommended Datadog product to lead with",
  "primary_persona_title": "The recommended persona title to target"
}"""


def _format_tiered_landscape(landscape: dict, techs: list[dict]) -> str:
    """Format the TechnologyLandscape into a tiered context block for Claude."""
    confirmed = [t for t in techs if t.get("confidence") == "confirmed"]
    likely = [t for t in techs if t.get("confidence") == "likely"]
    unverified = [t for t in techs if t.get("confidence") == "unverified"]

    def _tech_line(t: dict) -> str:
        name = t.get("canonical_name", "?")
        strength = t.get("signal_strength", 0)
        rationale = t.get("confidence_rationale", "")
        competitive = " [COMPETITIVE TARGET]" if t.get("is_competitive_target") else ""
        sources = ", ".join(t.get("source_names", []))
        return f"  {name} ({strength} signal{'s' if strength != 1 else ''} — {sources}){competitive}"

    lines = [f"\nTechnology Landscape ({len(techs)} technologies detected):"]

    if confirmed:
        lines.append(f"  CONFIRMED ({len(confirmed)}):")
        for t in confirmed:
            lines.append("  " + _tech_line(t))

    if likely:
        lines.append(f"  LIKELY ({len(likely)}):")
        for t in likely:
            lines.append("  " + _tech_line(t))

    if unverified:
        lines.append(f"  UNVERIFIED ({len(unverified)}) — validate during discovery:")
        for t in unverified:
            lines.append("  " + _tech_line(t))

    competitive_techs = [
        t for t in techs if t.get("is_competitive_target")
    ]
    if competitive_techs:
        parts = []
        for t in competitive_techs:
            parts.append(f"{t['canonical_name']} ({t.get('confidence', 'unknown')})")
        lines.append(f"  Competitive Targets: {', '.join(parts)}")

    summary = landscape.get("confidence_summary", {})
    sources = summary.get("sources_used", [])
    if sources:
        lines.append(f"  Data Sources: {', '.join(sources)}")

    return "\n".join(lines)


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
        parts.append(f"\nStrategic Priorities: {', '.join(research['strategic_priorities'])}")
    if research.get("risk_factors"):
        parts.append(f"Risk Factors: {', '.join(research['risk_factors'])}")
    if research.get("technology_investments"):
        parts.append(f"Technology Investments: {', '.join(research['technology_investments'])}")

    # Technology landscape — prefer tiered confidence data when available
    landscape = research.get("technology_landscape", {})
    landscape_techs = landscape.get("technologies", [])

    if landscape_techs:
        parts.append(_format_tiered_landscape(landscape, landscape_techs))
    else:
        # Fallback: flat lists for backward compat with old cached data
        if research.get("current_observability_tools"):
            parts.append(f"\nCurrent Observability Tools: {', '.join(research['current_observability_tools'])}")
        if research.get("current_cloud_platforms"):
            parts.append(f"Cloud Platforms: {', '.join(research['current_cloud_platforms'])}")
        if research.get("current_infrastructure"):
            parts.append(f"Infrastructure: {', '.join(research['current_infrastructure'])}")
        if research.get("current_security_tools"):
            parts.append(f"Security Tools: {', '.join(research['current_security_tools'])}")
        if research.get("current_databases"):
            parts.append(f"Databases: {', '.join(research['current_databases'])}")
        if research.get("current_message_queues"):
            parts.append(f"Message Queues / Streaming: {', '.join(research['current_message_queues'])}")
        if research.get("current_languages"):
            parts.append(f"Languages / Frameworks: {', '.join(research['current_languages'])}")
        if research.get("current_data_platforms"):
            parts.append(f"Data Platforms: {', '.join(research['current_data_platforms'])}")
        if research.get("current_cicd_tools"):
            parts.append(f"CI/CD Tools: {', '.join(research['current_cicd_tools'])}")
        if research.get("current_feature_flags"):
            parts.append(f"Feature Flags: {', '.join(research['current_feature_flags'])}")
        if research.get("current_serverless"):
            parts.append(f"Serverless: {', '.join(research['current_serverless'])}")
        if research.get("current_networking"):
            parts.append(f"Networking / CDN: {', '.join(research['current_networking'])}")

    parts.append(f"\nHiring Velocity: {research.get('hiring_velocity', 'unknown')}")
    if research.get("key_hiring_themes"):
        parts.append(f"Hiring Themes: {', '.join(research['key_hiring_themes'])}")

    if research.get("relevant_open_roles"):
        parts.append("\nRelevant Open Roles:")
        for role in research["relevant_open_roles"][:8]:
            techs = ", ".join(role.get("technologies", [])[:3])
            parts.append(f"  - {role.get('title', 'N/A')} ({role.get('department', 'N/A')}) [{techs}]")

    if research.get("key_personas"):
        parts.append("\nKey Personas:")
        for p in research["key_personas"][:10]:
            parts.append(f"  - {p.get('name', 'N/A')} — {p.get('title', 'N/A')} ({p.get('seniority', '')})")

    if research.get("recommended_entry_persona"):
        ep = research["recommended_entry_persona"]
        parts.append(f"\nRecommended Entry Persona: {ep.get('title', 'N/A')}")
        if ep.get("name"):
            parts.append(f"  Name: {ep['name']}")
        parts.append(f"  Rationale: {ep.get('rationale', 'N/A')}")

    if research.get("competitive_displacement_targets"):
        parts.append(f"\nCompetitive Displacement Targets: {', '.join(research['competitive_displacement_targets'])}")

    return "\n".join(parts)


def _format_agent_section(label: str, resp: AgentResponse | None) -> str:
    if resp is None:
        return f"{label}: Not available."
    if resp.error:
        return f"{label}: Unavailable — {resp.error}"
    if not resp.answer:
        return f"{label}: No relevant data found."
    return f"{label}:\n{resp.answer}"


def _format_existing_artifacts(artifacts: dict) -> str:
    """Format existing company artifacts into a context block for Claude.

    artifacts keys: call_notes (list of full note dicts), demo_plans (list),
    expansion_playbook (dict or None), precall_briefs (list), reports (list).
    """
    if not artifacts:
        return ""

    parts = ["EXISTING COMPANY ARTIFACTS (from prior work with this account):"]
    parts.append("These represent real intelligence already captured — weight them heavily.")
    parts.append("")

    # Call notes — highest signal, extract structured intelligence
    call_notes = artifacts.get("call_notes", [])
    if call_notes:
        parts.append(f"CALL NOTES ({len(call_notes)} captured, most recent first):")
        for i, note in enumerate(call_notes[:5]):
            created = note.get("created_at", "")[:10]
            title = note.get("title") or f"Call {i + 1}"
            parts.append(f"  --- {title} ({created}) ---")
            raw = note.get("summary_markdown", "")
            if not raw:
                parts.append("    (no summary)")
                continue
            try:
                s = json.loads(raw)
                ctx = s.get("call_context", {})
                if ctx.get("call_type"):
                    parts.append(f"    Call Type: {ctx['call_type']}")
                if ctx.get("deal_stage"):
                    parts.append(f"    Deal Stage: {ctx['deal_stage']}")
                # Stakeholders
                for person in s.get("stakeholders", [])[:5]:
                    tags = ", ".join(person.get("role_tags", []))
                    parts.append(f"    Stakeholder: {person.get('name','?')} ({person.get('title','')}) [{tags}]")
                    if person.get("notes"):
                        parts.append(f"      {person['notes']}")
                # Pain points
                for p in s.get("pain_points", [])[:4]:
                    parts.append(f"    Pain [{p.get('urgency','?')}]: {p.get('pain','')}")
                    if p.get("impact"):
                        parts.append(f"      Impact: {p['impact']}")
                # Tech stack confirmed on calls
                tech = s.get("technical_requirements", {})
                if tech.get("current_stack"):
                    parts.append(f"    Confirmed Stack: {', '.join(tech['current_stack'][:8])}")
                if tech.get("technical_goals"):
                    parts.append(f"    Technical Goals: {'; '.join(tech['technical_goals'][:3])}")
                # Objections
                for o in s.get("objections", [])[:3]:
                    parts.append(f"    Objection [{o.get('status','?')}]: {o.get('objection','')}")
                # Competitive ecosystem
                comp = s.get("competitive_ecosystem", {})
                if comp.get("incumbents"):
                    parts.append(f"    Incumbents confirmed on call: {', '.join(comp['incumbents'][:5])}")
                if comp.get("also_evaluating"):
                    parts.append(f"    Also evaluating: {', '.join(comp['also_evaluating'][:3])}")
                # Signal log
                sig = s.get("signal_log", {})
                for b in sig.get("buying_signals", [])[:3]:
                    parts.append(f"    Buying signal: {b}")
                for r in sig.get("risk_flags", [])[:3]:
                    parts.append(f"    Risk flag: {r}")
                # Business drivers
                bd = s.get("business_drivers", {})
                if bd.get("why_now"):
                    parts.append(f"    Why now: {bd['why_now']}")
                # Decision criteria
                dc = s.get("decision_criteria", {})
                if dc.get("must_haves"):
                    parts.append(f"    Must-haves: {'; '.join(dc['must_haves'][:4])}")
                if dc.get("evaluation_timeline"):
                    parts.append(f"    Evaluation timeline: {dc['evaluation_timeline']}")
                # Next steps from that call
                for ns in s.get("next_steps", [])[:3]:
                    parts.append(f"    Next step [{ns.get('owner_side','?')}]: {ns.get('action','')}")
                if s.get("se_notes"):
                    parts.append(f"    SE Notes: {s['se_notes'][:300]}")
            except (json.JSONDecodeError, TypeError):
                parts.append(f"    {raw[:400]}")
        parts.append("")

    # Demo plans — show persona and mode, extract key context
    demo_plans = artifacts.get("demo_plans", [])
    if demo_plans:
        parts.append(f"DEMO PLANS ({len(demo_plans)} generated):")
        for p in demo_plans[:2]:
            created = p.get("created_at", "")[:10]
            title = p.get("title", "Demo Plan")
            persona = p.get("persona", "")
            mode = p.get("demo_mode", "")
            parts.append(f"  - {title} ({created}) | Persona: {persona} | Mode: {mode}")
            # Include pain points and key messages from the demo plan if available
            if p.get("customer_pain_points"):
                parts.append(f"    Pain points addressed: {p['customer_pain_points'][:200]}")
        parts.append("")

    # Expansion playbook — surface the opportunity map
    expansion = artifacts.get("expansion_playbook")
    if expansion:
        created = expansion.get("created_at", "")[:10]
        parts.append(f"EXPANSION PLAYBOOK ({created}):")
        if expansion.get("current_footprint_summary"):
            parts.append(f"  Current Footprint: {expansion['current_footprint_summary']}")
        if expansion.get("current_champion"):
            parts.append(f"  Known Champion: {expansion['current_champion']}")
        if expansion.get("recommended_next_action"):
            parts.append(f"  Recommended Next Action: {expansion['recommended_next_action']}")
        opps = expansion.get("opportunities", [])
        if opps:
            parts.append(f"  {len(opps)} expansion opportunities identified:")
            for opp in opps[:4]:
                phase = opp.get("phase", "?")
                name = opp.get("opportunity_name", "")
                urgency = opp.get("urgency", "")
                parts.append(f"    Phase {phase}: {name} | Urgency: {urgency}")
        parts.append("")

    # Pre-call briefs — show north stars and what was planned
    precall_briefs = artifacts.get("precall_briefs", [])
    if precall_briefs:
        parts.append(f"PRE-CALL BRIEFS ({len(precall_briefs)} generated):")
        for b in precall_briefs[:3]:
            created = b.get("created_at", "")[:10]
            call_type = b.get("call_type", "")
            north_star = b.get("north_star", "")
            parts.append(f"  - {call_type.replace('_',' ').title()} Brief ({created})")
            if north_star:
                parts.append(f"    North Star: {north_star}")
            # Include situation summary if available
            if b.get("situation_summary"):
                parts.append(f"    Situation: {b['situation_summary'][:300]}")
            # Known attendees
            for a in b.get("attendee_prep", [])[:4]:
                parts.append(f"    Attendee: {a.get('name','?')} — {a.get('inferred_role','')}")
        parts.append("")

    # SE-authored company notes
    company_notes = artifacts.get("company_notes", [])
    if company_notes:
        now = datetime.now(timezone.utc)
        sorted_notes = sorted(
            company_notes,
            key=lambda n: n.get("note_date") or n.get("created_at", ""),
            reverse=True,
        )
        parts.append(f"SE NOTES ({len(company_notes)}, most recent first):")
        parts.append("Free-text SE observations — treat as direct account intelligence.")
        for i, note in enumerate(sorted_notes[:6]):
            date_str = note.get("note_date") or note.get("created_at", "")[:10]
            title = note.get("title", f"Note {i + 1}")
            content = (note.get("content") or "").strip()
            max_len = 800 if i < 3 else 300
            if len(content) > max_len:
                content = content[:max_len] + "\n[...truncated]"
            parts.append(f"  --- {title} ({date_str}) ---")
            parts.append(f"  {content}")
        parts.append("")

    # Strategic reports
    reports = artifacts.get("reports", [])
    if reports:
        parts.append(f"STRATEGIC REPORTS ({len(reports)}):")
        for r in reports[:3]:
            saved = r.get("saved_at", "")[:10]
            title = r.get("title") or r.get("query", "Untitled")
            parts.append(f"  - {title} ({saved})")
        parts.append("")

    # Slack channel summaries — highest-recency signal, include full text
    slack_summaries = artifacts.get("slack_summaries", [])
    if slack_summaries:
        parts.append(f"SLACK CHANNEL SUMMARIES ({len(slack_summaries)}, most recent first):")
        parts.append("These are internal team discussions about this account — treat as highest-confidence, most recent intelligence.")
        for s in slack_summaries[:5]:
            created = s.get("updated_at", s.get("created_at", ""))[:10]
            channel = s.get("channel_name", "").strip()
            header = f"  --- {channel or 'Slack'} ({created}) ---"
            parts.append(header)
            text = s.get("summary_text", "").strip()
            if text:
                # Indent each line for readability in the prompt
                for line in text.splitlines():
                    parts.append(f"  {line}" if line.strip() else "")
        parts.append("")

    return "\n".join(parts)


async def synthesize_hypothesis(
    research: dict,
    agent_responses: dict[str, AgentResponse],
    additional_context: str | None = None,
    existing_artifacts: dict | None = None,
) -> dict:
    """Call Claude to produce the Sales Hypothesis document.

    Returns dict with keys: hypothesis_markdown, confidence_level,
    entry_product, primary_persona_title.
    """
    research_section = _format_research_section(research)

    buyer_persona = agent_responses.get("buyer_persona")
    value = agent_responses.get("value")
    case_studies = agent_responses.get("case_studies")
    technical = agent_responses.get("technical")

    user_parts = [
        f"COMPANY RESEARCH:\n{research_section}",
        "",
        _format_agent_section("BUYER PERSONA INTELLIGENCE", buyer_persona),
        "",
        _format_agent_section("VALUE & CUSTOMER STORIES", value),
        "",
        _format_agent_section("CASE STUDIES", case_studies),
        "",
        _format_agent_section("TECHNICAL CAPABILITIES", technical),
    ]

    if existing_artifacts:
        artifacts_section = _format_existing_artifacts(existing_artifacts)
        if artifacts_section:
            user_parts.extend(["", artifacts_section])

    if additional_context:
        user_parts.extend(["", f"ADDITIONAL CONTEXT FROM AE:\n{additional_context}"])

    user_parts.extend([
        "",
        "Generate the Sales Hypothesis document. Respond with ONLY a JSON object.",
    ])

    user_message = "\n".join(user_parts)

    client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)

    try:
        response = await client.messages.create(
            model=settings.claude_model,
            max_tokens=6000,
            temperature=0.3,
            system=HYPOTHESIS_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_message}],
        )

        raw = _strip_fences(extract_text(response))
        data = json.loads(raw)

        return {
            "hypothesis_markdown": data.get("hypothesis_markdown", ""),
            "confidence_level": data.get("confidence_level", research.get("confidence_level", "low")),
            "entry_product": data.get("entry_product", ""),
            "primary_persona_title": data.get("primary_persona_title", ""),
        }

    except (json.JSONDecodeError, KeyError, ValueError) as exc:
        logger.warning("Hypothesis synthesis JSON parsing failed: %s", exc)
        fallback_parts = [
            f"# SALES HYPOTHESIS: {research.get('company_name', 'Unknown')}",
            "",
            "## Synthesis Error",
            "The AI synthesis did not return valid structured output. Raw agent data follows.",
            "",
        ]
        for label, key in [
            ("Buyer Persona", "buyer_persona"),
            ("Value", "value"),
            ("Case Studies", "case_studies"),
            ("Technical", "technical"),
        ]:
            resp = agent_responses.get(key)
            if resp and resp.answer and not resp.error:
                fallback_parts.append(f"## {label}")
                fallback_parts.append(resp.answer)
                fallback_parts.append("")

        return {
            "hypothesis_markdown": "\n".join(fallback_parts),
            "confidence_level": research.get("confidence_level", "low"),
            "entry_product": "",
            "primary_persona_title": "",
        }
    except Exception as exc:
        logger.error("Hypothesis synthesis failed: %s", exc)
        return {
            "hypothesis_markdown": f"# Synthesis Error\n\nFailed to generate hypothesis: {exc}",
            "confidence_level": "low",
            "entry_product": "",
            "primary_persona_title": "",
        }
