"""Call Debrief synthesis — Claude compares a Pre-Call Brief (what we planned)
against a Call Note (what actually happened) to produce a structured debrief."""

import json
import logging
import re

import anthropic

from anthropic_helpers import extract_text
from config import settings

logger = logging.getLogger(__name__)

_FENCE_RE = re.compile(r"^```(?:json)?\s*\n(.*?)\n```\s*$", re.DOTALL)


def _strip_fences(text: str) -> str:
    m = _FENCE_RE.match(text.strip())
    return m.group(1).strip() if m else text.strip()


DEBRIEF_SYSTEM_PROMPT = """\
You are a Call Debrief Engine for Sales Engineers. You receive two documents:
1. PRE-CALL BRIEF — what the SE planned to accomplish before the call
2. CALL NOTE — structured summary of what actually happened on the call

Your job is to produce a structured debrief that closes the loop between intent and reality.
This is not a generic call summary — the call note already does that. This is specifically
a comparison: what did we plan, what did we do, what does the gap tell us?

Be honest and direct. If the SE missed their objectives, say so. If the call revealed
something the brief got wrong, flag it. If the brief preparation led to a clear win,
acknowledge it. This document helps the SE learn and improve their preparation.

---

OUTPUT FORMAT:

Respond with ONLY a JSON object matching this schema:

{
  "overall_call_grade": "A | B | C | D",
  "overall_assessment": "2-3 sentences: how well did the call go relative to the brief? Lead with the most important thing.",

  "north_star_outcome": {
    "north_star": "the original north star from the brief",
    "achieved": true | false | "partial",
    "evidence": "1-2 sentences: what in the call note supports this assessment"
  },

  "objectives_scorecard": [
    {
      "objective": "the planned objective text",
      "status": "achieved | partial | missed | not_attempted",
      "evidence": "what in the call note supports this status — or null if no signal"
    }
  ],

  "questions_scorecard": [
    {
      "question": "the planned question",
      "asked": true | false | "unclear",
      "answer_received": "summary of the answer if it came up — or null",
      "strategic_purpose": "the original strategic purpose from the brief"
    }
  ],

  "surprises": [
    {
      "surprise": "something that came up on the call that the brief did not anticipate",
      "implication": "what this means for the deal or next steps"
    }
  ],

  "brief_accuracy": {
    "what_the_brief_got_right": ["list of things the brief correctly anticipated"],
    "what_the_brief_got_wrong": ["list of things the brief misjudged or missed entirely"],
    "gaps_in_preparation": ["things the SE should have known before this call but didn't"]
  },

  "sharpened_next_steps": [
    {
      "action": "specific next action, grounded in what actually happened on the call",
      "owner": "SE | AE | SE + AE | Prospect",
      "urgency": "immediate | this week | before next call",
      "rationale": "why this matters based on the debrief"
    }
  ],

  "coaching_note": "1-2 sentences of honest coaching for the SE: what should they do differently to prepare for or conduct the next call with this account?"
}

GRADING RUBRIC:
- A: North star achieved, most objectives hit, no major surprises that derailed the call
- B: North star partially achieved or 2+ objectives hit, call advanced the deal
- C: North star missed but meaningful progress made, significant open questions remain
- D: North star missed, few/no objectives achieved, call did not advance the deal

RULES:
1. Ground every claim in the actual content of the call note. Do not invent outcomes.
2. If a planned question wasn't explicitly asked or answered in the call note, mark asked=false.
3. Surprises must be genuinely new information — not things that appeared in the brief.
4. Sharpened next steps should incorporate new information from the call that wasn't in the brief.
5. The coaching note should be actionable and specific, not generic praise or criticism.
6. If the call note is sparse or incomplete, flag this in the overall_assessment and grade accordingly."""


def _format_brief_for_debrief(brief: dict) -> str:
    """Format the pre-call brief into a readable context block."""
    parts = [
        f"COMPANY: {brief.get('company_name', 'Unknown')}",
        f"CALL TYPE: {brief.get('call_type', 'unknown')}",
        "",
        f"NORTH STAR: {brief.get('north_star', 'Not specified')}",
        "",
        "CALL OBJECTIVES:",
    ]
    for i, obj in enumerate(brief.get("call_objectives", []), 1):
        parts.append(f"  {i}. {obj}")

    parts.append("")
    parts.append("SITUATION SUMMARY (pre-call):")
    parts.append(brief.get("situation_summary", ""))

    parts.append("")
    parts.append("WHAT WE KNEW:")
    for item in brief.get("what_we_know", []):
        parts.append(f"  - {item}")

    parts.append("")
    parts.append("WHAT WE DIDN'T KNOW:")
    for item in brief.get("what_we_dont_know", []):
        parts.append(f"  - {item}")

    parts.append("")
    parts.append("PLANNED QUESTIONS:")
    for q in brief.get("questions_to_ask", []):
        parts.append(f"  Q: {q.get('question', '')}")
        parts.append(f"     Purpose: {q.get('strategic_purpose', '')}")

    parts.append("")
    parts.append("THINGS TO AVOID:")
    for item in brief.get("things_to_avoid", []):
        parts.append(f"  - {item}")

    parts.append("")
    parts.append("KEY PROOF POINTS PLANNED:")
    for item in brief.get("key_proof_points", []):
        parts.append(f"  - {item}")

    return "\n".join(parts)


def _format_call_note_for_debrief(call_note: dict) -> str:
    """Format the call note summary into a readable context block."""
    raw = call_note.get("summary_markdown", "")
    title = call_note.get("title", "Call Note")
    created = call_note.get("created_at", "")[:10]

    parts = [f"CALL NOTE: {title} ({created})", ""]

    try:
        summary = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        # Fall back to raw text if not JSON
        return f"CALL NOTE: {title} ({created})\n\n{raw[:3000]}"

    ctx = summary.get("call_context", {})
    if ctx.get("call_type"):
        parts.append(f"Call Type: {ctx['call_type']}")
    if ctx.get("deal_stage"):
        parts.append(f"Deal Stage: {ctx['deal_stage']}")
    parts.append("")

    stakeholders = summary.get("stakeholders", [])
    if stakeholders:
        parts.append("ATTENDEES ON CALL:")
        for s in stakeholders:
            tags = ", ".join(s.get("role_tags", []))
            parts.append(f"  - {s.get('name', '?')} ({s.get('title', '')}){' — ' + tags if tags else ''}")
            if s.get("notes"):
                parts.append(f"    {s['notes']}")
        parts.append("")

    pains = summary.get("pain_points", [])
    if pains:
        parts.append("PAIN POINTS SURFACED:")
        for p in pains:
            urgency = p.get("urgency", "")
            parts.append(f"  [{urgency}] {p.get('pain', '')}")
            if p.get("impact"):
                parts.append(f"    Impact: {p['impact']}")
        parts.append("")

    drivers = summary.get("business_drivers", {})
    if drivers.get("why_now") or drivers.get("business_context"):
        parts.append("BUSINESS DRIVERS:")
        if drivers.get("why_now"):
            parts.append(f"  Why now: {drivers['why_now']}")
        if drivers.get("business_context"):
            parts.append(f"  Context: {drivers['business_context']}")
        parts.append("")

    tech = summary.get("technical_requirements", {})
    tech_items = []
    if tech.get("current_stack"):
        tech_items.append(f"Stack: {', '.join(tech['current_stack'])}")
    if tech.get("technical_goals"):
        tech_items.append(f"Goals: {'; '.join(tech['technical_goals'])}")
    if tech.get("infrastructure_notes"):
        tech_items.append(f"Infra: {tech['infrastructure_notes']}")
    if tech_items:
        parts.append("TECHNICAL:")
        for item in tech_items:
            parts.append(f"  {item}")
        parts.append("")

    comp = summary.get("competitive_ecosystem", {})
    if comp.get("incumbents") or comp.get("also_evaluating"):
        parts.append("COMPETITIVE:")
        if comp.get("incumbents"):
            parts.append(f"  Incumbents: {', '.join(comp['incumbents'])}")
        if comp.get("also_evaluating"):
            parts.append(f"  Also evaluating: {', '.join(comp['also_evaluating'])}")
        parts.append("")

    dc = summary.get("decision_criteria", {})
    if dc.get("must_haves") or dc.get("success_definition"):
        parts.append("DECISION CRITERIA:")
        if dc.get("must_haves"):
            for m in dc["must_haves"]:
                parts.append(f"  Must-have: {m}")
        if dc.get("success_definition"):
            parts.append(f"  Success defined as: {dc['success_definition']}")
        if dc.get("evaluation_timeline"):
            parts.append(f"  Timeline: {dc['evaluation_timeline']}")
        parts.append("")

    objections = summary.get("objections", [])
    if objections:
        parts.append("OBJECTIONS RAISED:")
        for o in objections:
            parts.append(f"  [{o.get('type', '?')} / {o.get('status', '?')}] {o.get('objection', '')}")
        parts.append("")

    next_steps = summary.get("next_steps", [])
    if next_steps:
        parts.append("AGREED NEXT STEPS:")
        for ns in next_steps:
            owner = ns.get("owner_side", "?")
            due = f" (due: {ns['due']})" if ns.get("due") else ""
            parts.append(f"  [{owner}] {ns.get('action', '')}{due}")
        parts.append("")

    sig = summary.get("signal_log", {})
    if sig.get("buying_signals"):
        parts.append("BUYING SIGNALS:")
        for b in sig["buying_signals"]:
            parts.append(f"  + {b}")
        parts.append("")
    if sig.get("risk_flags"):
        parts.append("RISK FLAGS:")
        for r in sig["risk_flags"]:
            parts.append(f"  ! {r}")
        parts.append("")
    if sig.get("open_questions"):
        parts.append("OPEN QUESTIONS AFTER CALL:")
        for q in sig["open_questions"]:
            parts.append(f"  ? {q}")
        parts.append("")

    if summary.get("se_notes"):
        parts.append("SE NOTES:")
        parts.append(f"  {summary['se_notes']}")

    return "\n".join(parts)


async def synthesize_debrief(
    call_note: dict,
    precall_brief: dict,
) -> dict:
    """Compare a pre-call brief against a call note and produce a structured debrief.

    Returns a dict matching the debrief schema.
    """
    brief_section = _format_brief_for_debrief(precall_brief)
    note_section = _format_call_note_for_debrief(call_note)

    user_message = (
        "PRE-CALL BRIEF (what we planned):\n"
        f"{brief_section}\n\n"
        "---\n\n"
        "CALL NOTE (what actually happened):\n"
        f"{note_section}\n\n"
        "---\n\n"
        "Generate the Call Debrief. Respond with ONLY a JSON object."
    )

    client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)

    try:
        response = await client.messages.create(
            model=settings.claude_model,
            max_tokens=4096,
            temperature=0.2,
            system=DEBRIEF_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_message}],
        )

        raw = _strip_fences(extract_text(response))
        data = json.loads(raw)
        return data

    except (json.JSONDecodeError, KeyError, ValueError) as exc:
        logger.warning("Debrief synthesis JSON parsing failed: %s", exc)
        return _fallback_debrief(str(exc))

    except Exception as exc:
        logger.error("Debrief synthesis failed: %s", exc)
        return _fallback_debrief(str(exc))


def _fallback_debrief(error_msg: str) -> dict:
    return {
        "overall_call_grade": "C",
        "overall_assessment": f"Debrief generation failed: {error_msg}",
        "north_star_outcome": {
            "north_star": "",
            "achieved": False,
            "evidence": "Synthesis failed — review artifacts manually.",
        },
        "objectives_scorecard": [],
        "questions_scorecard": [],
        "surprises": [],
        "brief_accuracy": {
            "what_the_brief_got_right": [],
            "what_the_brief_got_wrong": [],
            "gaps_in_preparation": [],
        },
        "sharpened_next_steps": [],
        "coaching_note": "Retry debrief generation or review the call note and brief manually.",
    }
