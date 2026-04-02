"""Next Steps Agent synthesis — Claude consumes all company artifacts and produces
a prioritized, time-boxed action plan to advance the deal."""

import json
import logging
import re
from datetime import datetime, timezone

import anthropic

from anthropic_helpers import extract_text
from config import settings
from next_steps_models import NextStep, NextStepsResponse

logger = logging.getLogger(__name__)

_FENCE_RE = re.compile(r"^```(?:json)?\s*\n(.*?)\n```\s*$", re.DOTALL)


def _strip_fences(text: str) -> str:
    m = _FENCE_RE.match(text.strip())
    return m.group(1).strip() if m else text.strip()


NEXT_STEPS_SYSTEM_PROMPT = """\
You are a Deal Advancement Engine for Datadog Sales Engineers. You receive all available \
artifacts for a specific deal (hypothesis, call notes, demo plans, expansion playbook, \
strategic reports) and produce a concrete, prioritized action plan for the SE and AE to \
advance the deal in the next 7 days.

---

DEAL STAGE INFERENCE RULES:

Infer the deal stage from the combination of artifacts present. Use this logic:
- hypothesis only, no call notes → "prospecting"
- hypothesis + 1-2 call notes, no demo plan → "discovery"
- demo plan exists, no expansion playbook → "demo_complete"
- call notes mention POC, POV, trial, or evaluation → "evaluation"
- expansion playbook exists OR call notes mention renewal, upsell, or QBR → "expansion_or_renewal"
- multiple call notes + demo plan + no clear POC signal → "active_evaluation"

If a deal_stage_override is provided by the SE, use it unconditionally and set \
deal_stage_confidence to "high".

Set deal_stage_confidence based on how clearly the artifacts support the inferred stage:
- "high": multiple artifacts strongly confirm the stage
- "medium": one artifact suggests this stage
- "low": stage is inferred from absence of artifacts or weak signals

---

ACTION GENERATION RULES:

1. SPECIFICITY IS MANDATORY. Every action must be specific enough that the SE can execute \
it without asking any clarifying questions. BAD: "Follow up with the customer." \
GOOD: "Send Sarah Chen (VP Eng) the Database Monitoring POV scope doc referenced in \
the 2024-01-15 call, along with a proposed success criteria table."

2. GROUND EVERY ACTION IN AN ARTIFACT. Each action must cite the artifact that triggered \
it (hypothesis, call note date, demo plan, expansion playbook, missing artifact). \
If you cannot cite an artifact, do not include the action.

3. OWNER ASSIGNMENT IS MANDATORY. Every action must have an owner:
   - "SE": technical follow-ups, POC setup, product questions, demo prep
   - "AE": commercial conversations, exec relationships, procurement, pricing
   - "SE + AE": joint actions (exec briefings, multi-stakeholder calls)
   - "Prospect": things you are waiting on from the customer side

4. TIME-BOX EVERY ACTION. Use one of these timeframes:
   - "Today": must happen in the next 24 hours
   - "This week": must happen before the end of the current work week
   - "Before next call": must happen before the next scheduled customer interaction
   - "Within 2 weeks": important but not immediately blocking

5. CATEGORY TAGS. Assign each action one category:
   - "Discovery": gathering information, qualifying pain, understanding environment
   - "Technical": POC setup, architecture questions, integration work, demo prep
   - "Commercial": pricing, procurement, business case, legal
   - "Relationship": champion building, stakeholder mapping, exec alignment
   - "Internal": SE/AE internal coordination, deal reviews, resource requests

6. CAP AT 7 ACTIONS. If you identify more than 7, keep only the highest-impact ones. \
An overwhelmed SE ignores everything. Prioritize ruthlessly — priority 1 is the \
single most important action regardless of effort.

7. INCLUDE PROSPECT-OWNED ITEMS. If the deal is waiting on something from the customer \
side (a security questionnaire, an intro to another stakeholder, an architecture diagram), \
include it with owner = "Prospect". This helps the SE track blockers explicitly.

---

BLOCKING RISKS RULES:

List 2-4 specific risks that could stall or kill the deal. Each risk must be:
- Grounded in a specific artifact signal (e.g., "The 2024-01-10 call note flags budget \
  freeze language — confirm whether this applies to the Datadog evaluation")
- Actionable (the SE should be able to mitigate it)
- NOT generic (do not include "deal may not close" or "competition is a risk")

Examples of good blocking risks:
- "No expansion playbook exists — the AE may be pitching without a product-specific \
  expansion story, increasing risk of a small initial deal or no upsell path"
- "The most recent call note (2024-01-15) shows an unresolved objection about Datadog's \
  pricing model — this must be addressed before the next commercial conversation"
- "Champion (Sarah Chen) mentioned upcoming reorg in Q2 — buying authority may shift"

---

MISSING ARTIFACTS RULES:

If a natural next artifact has not been generated yet, call it out explicitly. This \
both guides the SE and surfaces the value of the other agents in the system.
Examples:
- "No Sales Hypothesis has been generated — run the Hypothesis Agent to build \
  a tech stack and persona-based engagement strategy before the next call"
- "No Expansion Playbook exists — run the Expansion Playbook Agent to identify \
  upsell opportunities beyond the initial use case"
- "No Demo Plan exists — run the Demo Story Agent to prepare for the upcoming \
  product walkthrough"
- "No Call Notes have been captured — add call notes after each customer interaction \
  to improve next steps quality"

---

OUTPUT FORMAT:

Respond with ONLY a JSON object matching this schema exactly:

{
  "inferred_deal_stage": "prospecting | discovery | demo_complete | evaluation | active_evaluation | expansion_or_renewal",
  "deal_stage_confidence": "high | medium | low",
  "next_steps": [
    {
      "priority": 1,
      "action": "specific imperative action sentence",
      "owner": "SE | AE | SE + AE | Prospect",
      "timeframe": "Today | This week | Before next call | Within 2 weeks",
      "rationale": "why this matters right now, grounded in artifact evidence",
      "artifact_source": "hypothesis | call note YYYY-MM-DD | demo plan | expansion playbook | missing",
      "category": "Discovery | Technical | Commercial | Relationship | Internal"
    }
  ],
  "blocking_risks": [
    "specific, artifact-grounded risk 1",
    "specific, artifact-grounded risk 2"
  ],
  "missing_artifacts": [
    "description of missing artifact and which agent to run"
  ],
  "recommended_focus": "single sentence: the one thing that makes the most difference right now"
}"""


def _format_hypothesis(hyp: dict | None) -> str:
    if not hyp:
        return "SALES HYPOTHESIS: Not generated yet."
    md = hyp.get("hypothesis_markdown", "")
    confidence = hyp.get("confidence_level", "unknown")
    created = hyp.get("created_at", "")[:10]
    # Truncate to keep context manageable
    truncated = md[:3000] + ("\n[...truncated]" if len(md) > 3000 else "")
    return f"SALES HYPOTHESIS (generated {created}, confidence: {confidence}):\n{truncated}"


def _format_call_notes(call_notes: list[dict]) -> str:
    if not call_notes:
        return "CALL NOTES: None captured yet."

    parts = ["CALL NOTES:"]
    for i, note in enumerate(call_notes[:5]):  # cap at 5 most recent
        created = note.get("created_at", "")[:10]
        title = note.get("title") or f"Call {i + 1}"
        parts.append(f"\n--- Call Note: {title} ({created}) ---")

        summary_raw = note.get("summary_markdown", "")
        if not summary_raw:
            parts.append("  (no summary available)")
            continue

        # Try to parse structured JSON summary
        try:
            summary = json.loads(summary_raw)
            call_ctx = summary.get("call_context", {})
            if call_ctx.get("call_type"):
                parts.append(f"  Type: {call_ctx['call_type']}")
            if call_ctx.get("deal_stage"):
                parts.append(f"  Deal Stage: {call_ctx['deal_stage']}")

            pains = summary.get("pain_points", [])
            if pains:
                parts.append("  Pain Points:")
                for p in pains[:4]:
                    urgency = p.get("urgency", "")
                    parts.append(f"    - [{urgency}] {p.get('pain', '')}")

            objections = summary.get("objections", [])
            if objections:
                parts.append("  Objections:")
                for o in objections[:3]:
                    status = o.get("status", "")
                    parts.append(f"    - [{status}] {o.get('objection', '')}")

            next_steps = summary.get("next_steps", [])
            if next_steps:
                parts.append("  Agreed Next Steps from this call:")
                for ns in next_steps[:4]:
                    owner = ns.get("owner", "")
                    due = ns.get("due", "")
                    parts.append(f"    - [{ns.get('owner_side', owner)}] {ns.get('action', '')} {f'(due: {due})' if due else ''}")

            signals = summary.get("signal_log", {})
            buying = signals.get("buying_signals", [])
            risks = signals.get("risk_flags", [])
            open_q = signals.get("open_questions", [])
            if buying:
                parts.append(f"  Buying Signals: {'; '.join(buying[:3])}")
            if risks:
                parts.append(f"  Risk Flags: {'; '.join(risks[:3])}")
            if open_q:
                parts.append(f"  Open Questions: {'; '.join(open_q[:3])}")

            bd = summary.get("business_drivers", {})
            if bd.get("why_now"):
                parts.append(f"  Why Now: {bd['why_now']}")

        except (json.JSONDecodeError, TypeError):
            # Fallback: include raw summary preview
            parts.append(f"  Summary: {summary_raw[:400]}")

    return "\n".join(parts)


def _format_demo_plans(demo_plans: list[dict]) -> str:
    if not demo_plans:
        return "DEMO PLANS: None generated yet."

    parts = ["DEMO PLANS:"]
    for plan in demo_plans[:3]:
        created = plan.get("created_at", "")[:10]
        title = plan.get("title", "Untitled")
        persona = plan.get("persona", "")
        mode = plan.get("demo_mode", "")
        parts.append(f"  - {title} ({created}) | Persona: {persona} | Mode: {mode}")
    return "\n".join(parts)


def _format_expansion_playbook(playbook: dict | None) -> str:
    if not playbook:
        return "EXPANSION PLAYBOOK: Not generated yet."

    created = playbook.get("created_at", "")[:10]
    footprint = playbook.get("current_footprint_summary", "")
    champion = playbook.get("current_champion", "")
    next_action = playbook.get("recommended_next_action", "")
    opportunities = playbook.get("opportunities", [])

    parts = [f"EXPANSION PLAYBOOK (generated {created}):"]
    if footprint:
        parts.append(f"  Current Footprint: {footprint}")
    if champion:
        parts.append(f"  Known Champion: {champion}")
    if next_action:
        parts.append(f"  Recommended Next Action: {next_action}")
    if opportunities:
        parts.append(f"  Opportunities ({len(opportunities)} phases):")
        for opp in opportunities[:4]:
            phase = opp.get("phase", "?")
            name = opp.get("opportunity_name", "")
            urgency = opp.get("urgency", "")
            persona = opp.get("target_persona", {})
            persona_title = persona.get("title", "") if isinstance(persona, dict) else ""
            parts.append(f"    Phase {phase}: {name} | Urgency: {urgency} | Persona: {persona_title}")

    gaps = playbook.get("content_gaps", [])
    if gaps:
        parts.append(f"  Content Gaps: {'; '.join(gaps[:3])}")

    return "\n".join(parts)


def _format_reports(reports: list[dict]) -> str:
    if not reports:
        return "STRATEGIC REPORTS: None saved yet."
    parts = ["STRATEGIC REPORTS:"]
    for r in reports[:3]:
        saved = r.get("saved_at", "")[:10]
        title = r.get("title") or r.get("query", "Untitled")
        route = r.get("route", "")
        parts.append(f"  - {title} ({saved}) | Route: {route}")
    return "\n".join(parts)


def _format_company_notes(company_notes: list[dict]) -> str:
    """Format SE-authored company notes with recency annotations."""
    if not company_notes:
        return ""

    now = datetime.now(timezone.utc)
    sorted_notes = sorted(
        company_notes,
        key=lambda n: n.get("note_date") or n.get("created_at", ""),
        reverse=True,
    )

    parts = ["SE NOTES (most recent first — newer notes take precedence):"]
    for i, note in enumerate(sorted_notes[:6]):
        date_str = note.get("note_date") or note.get("created_at", "")[:10]
        title = note.get("title", f"Note {i + 1}")
        age_label = ""
        try:
            dt = (
                datetime.fromisoformat(date_str + "T00:00:00+00:00")
                if len(date_str) == 10
                else datetime.fromisoformat(date_str.replace("Z", "+00:00"))
            )
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            days = (now - dt).days
            if days <= 1:
                age_label = "today" if days == 0 else "1 day ago"
            elif days < 30:
                age_label = f"{days} days ago"
            else:
                age_label = f"{days} days ago (~{days // 30} months)"
        except (ValueError, TypeError):
            age_label = "unknown age"

        max_len = 1000 if i < 3 else 400
        content = (note.get("content") or "").strip()
        if len(content) > max_len:
            content = content[:max_len] + "\n[...truncated]"

        parts.append(f"\n--- {title} ({date_str}, {age_label}) ---")
        parts.append(content)

    return "\n".join(parts)


def _format_slack_summaries(slack_summaries: list[dict]) -> str:
    """Format Slack summaries for inclusion in synthesis prompts."""
    if not slack_summaries:
        return ""
    parts = [f"SLACK CHANNEL SUMMARIES ({len(slack_summaries)}, most recent first):"]
    parts.append("These are internal team discussions — highest-recency, highest-confidence context.")
    for s in slack_summaries[:5]:
        created = s.get("updated_at", s.get("created_at", ""))[:10]
        channel = s.get("channel_name", "").strip()
        parts.append(f"\n--- {channel or 'Slack'} ({created}) ---")
        text = s.get("summary_text", "").strip()
        if text:
            for line in text.splitlines():
                parts.append(f"  {line}" if line.strip() else "")
    return "\n".join(parts)


async def synthesize_next_steps(
    company_name: str,
    hypothesis: dict | None,
    call_notes: list[dict],
    demo_plans: list[dict],
    expansion_playbook: dict | None,
    reports: list[dict],
    deal_stage_override: str | None = None,
    additional_context: str | None = None,
    slack_summaries: list[dict] | None = None,
    company_notes: list[dict] | None = None,
) -> dict:
    """Call Claude to produce the Next Steps plan.

    Returns a dict matching the NextStepsResponse schema (minus id and processing_time_ms).
    """
    hyp_section = _format_hypothesis(hypothesis)
    notes_section = _format_call_notes(call_notes)
    demo_section = _format_demo_plans(demo_plans)
    playbook_section = _format_expansion_playbook(expansion_playbook)
    reports_section = _format_reports(reports)

    user_parts = [
        f"COMPANY: {company_name}",
        "",
        hyp_section,
        "",
        notes_section,
        "",
        demo_section,
        "",
        playbook_section,
        "",
        reports_section,
    ]

    if company_notes:
        cn_section = _format_company_notes(company_notes)
        if cn_section:
            user_parts.extend(["", cn_section])

    if slack_summaries:
        slack_section = _format_slack_summaries(slack_summaries)
        if slack_section:
            user_parts.extend(["", slack_section])

    if deal_stage_override:
        user_parts.extend([
            "",
            f"DEAL STAGE OVERRIDE (provided by SE): {deal_stage_override}",
            "Use this stage exactly. Set deal_stage_confidence to 'high'.",
        ])

    if additional_context:
        user_parts.extend([
            "",
            f"ADDITIONAL CONTEXT FROM SE:\n{additional_context}",
        ])

    user_parts.extend([
        "",
        "Generate the Next Steps plan. Respond with ONLY a JSON object.",
    ])

    user_message = "\n".join(user_parts)
    client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)

    try:
        response = await client.messages.create(
            model=settings.claude_model,
            max_tokens=4096,
            temperature=0.2,
            system=NEXT_STEPS_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_message}],
        )

        raw = _strip_fences(extract_text(response))
        data = json.loads(raw)

        return {
            "inferred_deal_stage": data.get("inferred_deal_stage", "unknown"),
            "deal_stage_confidence": data.get("deal_stage_confidence", "low"),
            "next_steps": data.get("next_steps", []),
            "blocking_risks": data.get("blocking_risks", []),
            "missing_artifacts": data.get("missing_artifacts", []),
            "recommended_focus": data.get("recommended_focus", ""),
        }

    except (json.JSONDecodeError, KeyError, ValueError) as exc:
        logger.warning("Next Steps synthesis JSON parsing failed: %s", exc)
        return _fallback_next_steps(company_name, str(exc))

    except Exception as exc:
        logger.error("Next Steps synthesis failed: %s", exc)
        return _fallback_next_steps(company_name, str(exc))


def _fallback_next_steps(company_name: str, error_msg: str) -> dict:
    return {
        "inferred_deal_stage": "unknown",
        "deal_stage_confidence": "low",
        "next_steps": [],
        "blocking_risks": [f"Next steps synthesis failed: {error_msg}"],
        "missing_artifacts": [],
        "recommended_focus": "Retry next steps generation or review artifacts manually.",
    }
