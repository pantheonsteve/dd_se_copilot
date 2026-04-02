"""Pre-Call Brief synthesis — Claude generates a tight, one-page brief for an
upcoming customer call, grounded in available deal artifacts."""

import json
import logging
import re
from datetime import datetime, timezone

import anthropic

from anthropic_helpers import extract_text
from config import settings
from precall_models import CallType, PreCallBrief

logger = logging.getLogger(__name__)

_FENCE_RE = re.compile(r"^```(?:json)?\s*\n(.*?)\n```\s*$", re.DOTALL)


def _strip_fences(text: str) -> str:
    m = _FENCE_RE.match(text.strip())
    return m.group(1).strip() if m else text.strip()


# ---------------------------------------------------------------------------
# Call-type specific instructions — appended to the system prompt
# ---------------------------------------------------------------------------

_CALL_TYPE_INSTRUCTIONS: dict[str, str] = {
    CallType.DISCOVERY: """\
CALL TYPE: DISCOVERY
This is an early-stage call to understand the prospect's environment, pain points, \
and priorities. The brief should be heavily weighted toward questions and "what we \
don't know yet." The SE's job on this call is to listen more than talk.

- call_objectives must focus on qualifying 3 specific things (e.g., confirming the \
  tech stack signal from the hypothesis, identifying the primary pain owner, \
  understanding evaluation timeline)
- questions_to_ask should include at least 2 questions that validate or invalidate \
  specific signals from the hypothesis (tech stack, competitive tools, hiring themes)
- what_we_dont_know should be longer than what_we_know — if we know everything, \
  this isn't a discovery call
- things_to_avoid: do NOT pitch features on a discovery call. Include this as a \
  reminder if the demo plan exists but discovery is incomplete.""",

    CallType.FOLLOWUP: """\
CALL TYPE: FOLLOW-UP
This call continues a prior conversation. Context continuity is critical.

- situation_summary must reference what happened in the most recent call note — \
  what was discussed, what was committed to, what changed
- call_objectives must reflect commitments made in the previous call. If the last \
  call note shows agreed next steps, those become the agenda for this call
- questions_to_ask should probe open questions and unresolved objections from \
  the most recent call note's signal_log.open_questions and objections fields
- what_we_know should be populated primarily from prior call note data""",

    CallType.TECHNICAL_DEEP_DIVE: """\
CALL TYPE: TECHNICAL DEEP DIVE
This is a detailed architecture and requirements session with technical stakeholders.

- call_objectives must include: confirming technical requirements, demonstrating \
  a specific technical capability, and identifying any technical blockers to POC
- questions_to_ask should be deeply technical — specific to their stack, scale, \
  integration requirements, and environment. Reference actual technologies from \
  the hypothesis tech stack.
- key_proof_points should include technically credible references (architecture \
  patterns, integration docs, performance benchmarks from technical library)
- things_to_avoid: avoid commercial conversations on this call — if pricing comes \
  up, acknowledge and defer. Include this reminder.
- north_star should be framed as a technical outcome (e.g., "Walk away with \
  confirmed architecture requirements and a POC scope agreed")""",

    CallType.EXEC_BRIEFING: """\
CALL TYPE: EXEC BRIEFING
This is an executive-level conversation. The audience cares about outcomes, \
risk, and strategy — not features.

- situation_summary must frame the deal in business terms, not technical ones
- call_objectives must be business-outcome focused: alignment on strategic fit, \
  surfacing exec sponsorship, connecting Datadog value to their stated priorities \
  (use 10-K / hypothesis strategic signals)
- questions_to_ask should be strategic: ask about business priorities, \
  organizational changes, competitive pressures. Maximum 3 questions — \
  execs don't like being interrogated.
- things_to_avoid: NEVER go deep on technical features with an exec. \
  Avoid mentioning product names unless the exec brings them up.
- key_proof_points should be business outcomes with named companies and \
  quantified results (revenue protected, cost saved, MTTR reduced by X%)
- north_star should be a business alignment statement""",

    CallType.POC_KICKOFF: """\
CALL TYPE: POC KICKOFF
This call launches a proof of concept. Clarity on scope and success criteria \
is the entire purpose.

- call_objectives must include: agreeing on POC scope, defining success criteria, \
  confirming technical environment access, establishing communication cadence
- questions_to_ask must include: how will they measure success, who needs to \
  see the results, what would make them NOT move forward (this surfaces hidden blockers)
- what_we_dont_know should flag anything about the environment or stakeholders \
  that hasn't been confirmed yet
- things_to_avoid: do not let the POC scope expand on this call — flag scope \
  creep as a risk
- north_star: "Leave this call with a signed-off POC success criteria doc and \
  a kickoff checklist" (adapt to the specific situation)""",

    CallType.POC_REVIEW: """\
CALL TYPE: POC REVIEW
This call evaluates POC results and determines next commercial steps.

- situation_summary must include context on what was being tested and what \
  the agreed success criteria were (from prior call notes)
- call_objectives: assess whether success criteria were met, address any gaps, \
  and advance toward a commercial next step
- questions_to_ask must include: what worked, what didn't, who else needs to \
  see the results, what the path to procurement looks like
- things_to_avoid: do not get defensive if POC results were mixed — \
  include a reminder to stay solution-focused
- key_proof_points: prepare evidence for any capability gaps surfaced during the POC
- north_star should be framed as a commercial milestone (e.g., "Confirm SE \
  technical win and hand off to AE for commercial discussion")""",

    CallType.CHAMPION_CHECKIN: """\
CALL TYPE: CHAMPION CHECK-IN
This is a relationship call with your internal champion. The goal is to \
coach them and gather internal intelligence.

- situation_summary should reflect the deal dynamics and champion's position \
  within the org based on call notes and hypothesis persona data
- call_objectives: understand internal sentiment, coach champion on internal \
  selling, surface new stakeholders or blockers
- questions_to_ask should focus on internal dynamics: who is engaged, who \
  is skeptical, what questions leadership is asking, whether budget is confirmed
- things_to_avoid: do not put the champion in an awkward position by asking \
  them to share information they shouldn't. Keep questions comfortable.
- north_star: "Understand the internal political landscape and leave the \
  champion feeling supported and confident" (adapt to context)""",

    CallType.COMMERCIAL: """\
CALL TYPE: COMMERCIAL CONVERSATION
This call focuses on pricing, procurement, or contract negotiation.

- call_objectives: confirm deal structure, address commercial objections, \
  agree on timeline to close
- questions_to_ask should focus on procurement process, decision-makers, \
  budget approval chain, and timing. Be direct.
- things_to_avoid: do not make unilateral concessions on pricing — \
  include a reminder to involve AE/leadership before committing
- key_proof_points: prepare ROI and TCO evidence — the commercial conversation \
  is where business case evidence matters most
- north_star should be a commercial milestone (e.g., "Confirm budget approval \
  path and get to a signed order form by [date]")""",
}


PRECALL_SYSTEM_PROMPT = """\
You are a Pre-Call Brief Engine for Sales Engineers. You receive deal artifacts for \
a specific account and generate a tight, one-page brief the SE reads in the 15 minutes \
before a customer call. The brief must be immediately actionable — specific to THIS company \
and THIS call, not generic sales advice.

---

CORE PRINCIPLES:

1. SPECIFICITY IS EVERYTHING. Every question, proof point, and talking point must \
   reference something specific about this company. "How are you handling alert fatigue?" \
   is acceptable. "Tell me about your monitoring needs." is not. If you can't make it \
   specific to the artifacts, don't include it.

2. GROUND EVERYTHING IN ARTIFACTS. If you reference a pain point, it must come from \
   a call note or hypothesis. If you cite a proof point, it must be grounded in value \
   library or case study data in the context provided. No fabrication.

3. QUESTIONS MUST HAVE PURPOSE. Every question in questions_to_ask must have a \
   strategic_purpose that explains what the SE is really trying to learn. A question \
   without a purpose is noise.

4. CALL OBJECTIVES = EXACTLY 3. Not 2, not 5. Three concrete, achievable outcomes for \
   this specific call. Each should be completable within the call timeframe.

5. NORTH STAR IS ONE SENTENCE. The most important single outcome that makes this \
   call a win. If the SE remembers nothing else from the brief, the north star \
   tells them what to protect.

6. ATTENDEE PREP IS PERSONA-SPECIFIC. For each attendee, use data from the \
   hypothesis personas or call notes to ground the what_they_care_about and \
   how_to_engage fields. If no data is available, make a reasonable inference \
   from their title and flag it as inferred.

---

OUTPUT FORMAT:

Respond with ONLY a JSON object matching this schema exactly:

{
  "situation_summary": "3-4 sentences describing where the deal stands right now",

  "what_we_know": [
    "specific confirmed fact about the account or deal"
  ],

  "what_we_dont_know": [
    "specific open question or gap"
  ],

  "call_objectives": [
    "objective 1 — specific, achievable on this call",
    "objective 2",
    "objective 3"
  ],

  "questions_to_ask": [
    {
      "question": "the actual question to ask",
      "strategic_purpose": "what you're really learning",
      "follow_up_if": "if they say X, ask Y — or null"
    }
  ],

  "attendee_prep": [
    {
      "name": "person's name",
      "inferred_role": "their role/title",
      "what_they_care_about": "1 sentence grounded in data or inferred from title",
      "how_to_engage": "1 tactical sentence"
    }
  ],

  "things_to_avoid": [
    "specific landmine or topic to sidestep"
  ],

  "key_proof_points": [
    "2-3 specific case studies, benchmarks, or data points most relevant to this call"
  ],

  "north_star": "single sentence: the one outcome that makes this call a win"
}"""


def _format_hypothesis_brief(hyp: dict | None) -> str:
    if not hyp:
        return "SALES HYPOTHESIS: Not available."

    md = hyp.get("hypothesis_markdown", "")
    confidence = hyp.get("confidence_level", "unknown")
    created = hyp.get("created_at", "")[:10]
    truncated = md[:2500] + ("\n[...truncated]" if len(md) > 2500 else "")
    return f"SALES HYPOTHESIS (generated {created}, confidence: {confidence}):\n{truncated}"


def _format_call_notes_brief(call_notes: list[dict]) -> str:
    if not call_notes:
        return "CALL NOTES: None captured yet."

    parts = ["CALL NOTES (most recent first):"]
    for i, note in enumerate(call_notes[:3]):
        created = note.get("created_at", "")[:10]
        title = note.get("title") or f"Call {i + 1}"
        parts.append(f"\n--- {title} ({created}) ---")

        summary_raw = note.get("summary_markdown", "")
        if not summary_raw:
            parts.append("  (no summary)")
            continue

        try:
            summary = json.loads(summary_raw)
            ctx = summary.get("call_context", {})
            if ctx.get("call_type"):
                parts.append(f"  Type: {ctx['call_type']}")

            pains = summary.get("pain_points", [])
            for p in pains[:3]:
                parts.append(f"  Pain [{p.get('urgency', '?')}]: {p.get('pain', '')}")

            objections = summary.get("objections", [])
            for o in objections[:2]:
                parts.append(f"  Objection [{o.get('status', '?')}]: {o.get('objection', '')}")

            open_q = summary.get("signal_log", {}).get("open_questions", [])
            for q in open_q[:3]:
                parts.append(f"  Open Q: {q}")

            ns_list = summary.get("next_steps", [])
            for ns in ns_list[:3]:
                parts.append(f"  Committed: [{ns.get('owner_side', '?')}] {ns.get('action', '')}")

            se_notes = summary.get("se_notes", "")
            if se_notes:
                parts.append(f"  SE Notes: {se_notes[:300]}")

        except (json.JSONDecodeError, TypeError):
            parts.append(f"  {summary_raw[:400]}")

    return "\n".join(parts)


def _format_demo_plan_brief(demo_plan: dict | None) -> str:
    if not demo_plan:
        return "DEMO PLAN: Not generated yet."

    title = demo_plan.get("title", "Demo Plan")
    persona = demo_plan.get("persona", "")
    mode = demo_plan.get("demo_mode", "")
    created = demo_plan.get("created_at", "")[:10]
    md = demo_plan.get("markdown", "") or demo_plan.get("demo_plan", "")
    truncated = md[:1500] + ("\n[...truncated]" if len(md) > 1500 else "")
    return (
        f"DEMO PLAN: {title} ({created}) | Persona: {persona} | Mode: {mode}\n"
        f"{truncated}"
    )


def _format_attendees(attendees: list[str]) -> str:
    if not attendees:
        return "ATTENDEES: Not specified."
    return "ATTENDEES:\n" + "\n".join(f"  - {a}" for a in attendees)


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

        max_len = 800 if i < 3 else 300
        content = (note.get("content") or "").strip()
        if len(content) > max_len:
            content = content[:max_len] + "\n[...truncated]"

        parts.append(f"\n--- {title} ({date_str}, {age_label}) ---")
        parts.append(content)

    return "\n".join(parts)


def _format_slack_summaries(slack_summaries: list[dict]) -> str:
    if not slack_summaries:
        return ""
    parts = [f"SLACK CHANNEL SUMMARIES ({len(slack_summaries)}, most recent first):"]
    parts.append("Internal team discussions — treat as highest-confidence, most recent intelligence.")
    for s in slack_summaries[:5]:
        created = s.get("updated_at", s.get("created_at", ""))[:10]
        channel = s.get("channel_name", "").strip()
        parts.append(f"\n--- {channel or 'Slack'} ({created}) ---")
        text = s.get("summary_text", "").strip()
        if text:
            for line in text.splitlines():
                parts.append(f"  {line}" if line.strip() else "")
    return "\n".join(parts)


async def synthesize_precall_brief(
    company_name: str,
    call_type: CallType,
    attendees: list[str],
    call_objective: str,
    hypothesis: dict | None,
    call_notes: list[dict],
    demo_plan: dict | None,
    additional_context: str = "",
    slack_summaries: list[dict] | None = None,
    company_notes: list[dict] | None = None,
) -> dict:
    """Call Claude to produce the Pre-Call Brief.

    Returns a dict matching the PreCallBrief schema (minus processing_time_ms).
    """
    type_instructions = _CALL_TYPE_INSTRUCTIONS.get(call_type, "")

    system_prompt = PRECALL_SYSTEM_PROMPT
    if type_instructions:
        system_prompt = f"{PRECALL_SYSTEM_PROMPT}\n\n---\n\n{type_instructions}"

    hyp_section = _format_hypothesis_brief(hypothesis)
    notes_section = _format_call_notes_brief(call_notes)
    demo_section = _format_demo_plan_brief(demo_plan)
    attendees_section = _format_attendees(attendees)

    user_parts = [
        f"COMPANY: {company_name}",
        f"CALL TYPE: {call_type.value}",
        "",
        attendees_section,
        "",
        hyp_section,
        "",
        notes_section,
        "",
        demo_section,
    ]

    if company_notes:
        cn_section = _format_company_notes(company_notes)
        if cn_section:
            user_parts.extend(["", cn_section])

    if call_objective:
        user_parts.extend(["", f"SE'S STATED CALL OBJECTIVE: {call_objective}"])

    if slack_summaries:
        slack_section = _format_slack_summaries(slack_summaries)
        if slack_section:
            user_parts.extend(["", slack_section])

    if additional_context:
        user_parts.extend(["", f"ADDITIONAL CONTEXT FROM SE:\n{additional_context}"])

    user_parts.extend([
        "",
        "Generate the Pre-Call Brief. Respond with ONLY a JSON object.",
    ])

    user_message = "\n".join(user_parts)
    client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)

    try:
        response = await client.messages.create(
            model=settings.claude_model,
            max_tokens=16000,
            system=system_prompt,
            messages=[{"role": "user", "content": user_message}],
        )

        block_types = [b.type for b in response.content]
        text = extract_text(response)
        if not text.strip():
            logger.warning(
                "Pre-Call Brief: model returned no text. stop_reason=%s, "
                "block_types=%s, usage=%s",
                response.stop_reason,
                block_types,
                getattr(response, "usage", None),
            )
            return _fallback_brief(
                company_name,
                call_type.value,
                f"Model returned empty text (stop_reason={response.stop_reason}, blocks={block_types})",
            )

        raw = _strip_fences(text)
        data = json.loads(raw)
        return data

    except (json.JSONDecodeError, KeyError, ValueError) as exc:
        logger.warning("Pre-Call Brief synthesis JSON parsing failed: %s", exc)
        return _fallback_brief(company_name, call_type.value, str(exc))

    except Exception as exc:
        logger.error("Pre-Call Brief synthesis failed: %s", exc)
        return _fallback_brief(company_name, call_type.value, str(exc))


def _fallback_brief(company_name: str, call_type: str, error_msg: str) -> dict:
    return {
        "situation_summary": f"Brief generation failed: {error_msg}",
        "what_we_know": [],
        "what_we_dont_know": [],
        "call_objectives": ["Review available artifacts manually before the call"],
        "questions_to_ask": [],
        "attendee_prep": [],
        "things_to_avoid": [],
        "key_proof_points": [],
        "north_star": "Retry brief generation or prepare manually.",
    }
