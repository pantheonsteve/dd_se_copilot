"""Company-scoped conversational chat backed by Claude.

Each turn: gather all artifacts for the company, build a grounding context
block, combine with conversation history, and call Claude.  Conversations
are persisted via company_chat_store so users can resume them.
"""

import asyncio
import json
import logging
import time
from datetime import datetime, timezone

import anthropic

from anthropic_helpers import extract_text
from config import settings
from company_chat_store import (
    add_message,
    auto_title,
    create_conversation,
    get_recent_messages,
)

logger = logging.getLogger(__name__)

_CONTEXT_WINDOW = 10  # messages (5 user/assistant turns)

COMPANY_CHAT_SYSTEM_PROMPT = """\
You are a knowledgeable SE Copilot assistant for Datadog. You help Sales Engineers \
prepare for and understand deals by answering questions about a specific company \
based on all available artifacts.

You have access to the following artifacts for the company in question:
- Sales hypothesis (if generated)
- Call notes from customer conversations
- SE notes (free-text observations from the SE about the account)
- Demo plans and their configurations
- Expansion playbooks with opportunity analysis
- Strategy/research reports
- Pre-call briefs
- Slack channel summaries from internal team discussions

Rules:
1. Ground every claim in a specific artifact — cite what you found (e.g. "the Jan 15 \
call note shows...", "the hypothesis flags...", "the expansion playbook recommends...").
2. If the artifacts don't contain enough information to answer, say so clearly rather \
than speculating. Suggest what artifact or action could fill the gap.
3. Be direct, specific, and concise. Write like a sharp colleague, not a CRM system.
4. When asked about deal status, momentum, or risk, synthesize across ALL available \
artifacts — don't just summarize one.
5. When discussing product capabilities or competitive positioning, tie back to what \
the artifacts reveal about this specific customer's needs.
6. Format responses with markdown for readability (headers, bold, lists) when it helps.
"""


# ---------------------------------------------------------------------------
# Context formatting (adapted from snapshot_synth.py)
# ---------------------------------------------------------------------------

def _format_hypothesis(hyp: dict | None) -> str:
    if not hyp:
        return "SALES HYPOTHESIS: Not generated."
    md = hyp.get("hypothesis_markdown", "")
    confidence = hyp.get("confidence_level", "unknown")
    created = hyp.get("created_at", "")[:10]
    truncated = md[:3000] + ("\n[...truncated]" if len(md) > 3000 else "")
    return f"SALES HYPOTHESIS (generated {created}, confidence: {confidence}):\n{truncated}"


def _format_call_notes(call_notes: list[dict]) -> str:
    if not call_notes:
        return "CALL NOTES: None captured."

    parts = [f"CALL NOTES ({len(call_notes)} total, most recent first):"]
    for i, note in enumerate(call_notes[:6]):
        created = note.get("created_at", "")[:10]
        title = note.get("title") or f"Call {i + 1}"
        parts.append(f"\n--- {title} ({created}) ---")

        raw = note.get("summary_markdown", "")
        if not raw:
            parts.append("  (no summary)")
            continue
        try:
            s = json.loads(raw)
            ctx = s.get("call_context", {})
            if ctx.get("call_type"):
                parts.append(f"  Type: {ctx['call_type']}")
            for p in s.get("pain_points", [])[:3]:
                parts.append(f"  Pain [{p.get('urgency','?')}]: {p.get('pain','')}")
            for o in s.get("objections", [])[:3]:
                parts.append(f"  Objection [{o.get('status','?')}]: {o.get('objection','')}")
            sig = s.get("signal_log", {})
            for b in sig.get("buying_signals", [])[:3]:
                parts.append(f"  + {b}")
            for r in sig.get("risk_flags", [])[:3]:
                parts.append(f"  ! {r}")
            for ns in s.get("next_steps", [])[:3]:
                parts.append(f"  Next step [{ns.get('owner_side','?')}]: {ns.get('action','')}")
            bd = s.get("business_drivers", {})
            if bd.get("why_now"):
                parts.append(f"  Why now: {bd['why_now']}")
            stk = s.get("stakeholders", [])
            for sh in stk[:4]:
                tags = ", ".join(sh.get("role_tags", []))
                parts.append(f"  Stakeholder: {sh.get('name','?')} ({tags})")
            if s.get("se_notes"):
                parts.append(f"  SE notes: {s['se_notes'][:300]}")
        except (json.JSONDecodeError, TypeError):
            parts.append(f"  {raw[:500]}")

    return "\n".join(parts)


def _format_demo_plans(demo_plans: list[dict]) -> str:
    if not demo_plans:
        return "DEMO PLANS: None generated."
    parts = [f"DEMO PLANS ({len(demo_plans)} total):"]
    for p in demo_plans[:3]:
        parts.append(f"  - {p.get('title','Untitled')} ({p.get('created_at','')[:10]}) | "
                     f"Persona: {p.get('persona','')} | Mode: {p.get('demo_mode','')}")
    return "\n".join(parts)


def _format_expansion(playbook: dict | None) -> str:
    if not playbook:
        return "EXPANSION PLAYBOOK: Not generated."
    opps = playbook.get("opportunities", [])
    parts = [f"EXPANSION PLAYBOOK ({playbook.get('created_at','')[:10]}):"]
    parts.append(f"  Footprint: {playbook.get('current_footprint_summary','')}")
    parts.append(f"  Champion: {playbook.get('current_champion','unknown')}")
    parts.append(f"  Recommended next action: {playbook.get('recommended_next_action','')}")
    if opps:
        for o in opps[:4]:
            parts.append(f"  Opp: {o.get('product_area','')} — {o.get('pitch','')} (urgency: {o.get('urgency','?')})")
    return "\n".join(parts)


def _format_reports(reports: list[dict]) -> str:
    if not reports:
        return "STRATEGIC REPORTS: None saved."
    parts = [f"STRATEGIC REPORTS ({len(reports)} total):"]
    for r in reports[:5]:
        parts.append(f"  - {r.get('title') or 'Untitled'} ({r.get('saved_at','')[:10]})")
    return "\n".join(parts)


def _format_slack_summaries(slack_summaries: list[dict]) -> str:
    if not slack_summaries:
        return ""
    parts = [f"SLACK CHANNEL SUMMARIES ({len(slack_summaries)}, most recent first):"]
    for s in slack_summaries[:5]:
        created = s.get("updated_at", s.get("created_at", ""))[:10]
        channel = s.get("channel_name", "").strip()
        parts.append(f"\n--- {channel or 'Slack'} ({created}) ---")
        text = s.get("summary_text", "").strip()
        if text:
            for line in text.splitlines()[:15]:
                parts.append(f"  {line}" if line.strip() else "")
    return "\n".join(parts)


def _format_precall_briefs(briefs: list[dict]) -> str:
    if not briefs:
        return "PRE-CALL BRIEFS: None generated."
    CALL_TYPE_LABELS = {
        "discovery": "Discovery", "followup": "Follow-Up",
        "technical_deep_dive": "Technical Deep Dive", "exec_briefing": "Exec Briefing",
        "poc_kickoff": "POC Kickoff", "poc_review": "POC Review",
        "champion_checkin": "Champion Check-In", "commercial": "Commercial",
    }
    parts = [f"PRE-CALL BRIEFS ({len(briefs)} total):"]
    for b in briefs[:3]:
        ct = CALL_TYPE_LABELS.get(b.get("call_type", ""), b.get("call_type", "Brief"))
        ns = (b.get("north_star") or "")[:120]
        parts.append(f"  - {ct} ({b.get('created_at','')[:10]}): {ns}")
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

    parts = ["SE NOTES (most recent first — newer notes take precedence over older ones):"]
    for i, note in enumerate(sorted_notes[:8]):
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
            if days == 0:
                age_label = "today"
            elif days == 1:
                age_label = "1 day ago"
            elif days < 30:
                age_label = f"{days} days ago"
            else:
                age_label = f"{days} days ago (~{days // 30} months)"
        except (ValueError, TypeError):
            age_label = "unknown age"

        max_len = 1500 if i < 3 else 500
        content = (note.get("content") or "").strip()
        if len(content) > max_len:
            content = content[:max_len] + "\n[...truncated]"

        parts.append(f"\n--- {title} ({date_str}, {age_label}) ---")
        parts.append(content)

    return "\n".join(parts)


def _build_context(artifacts: dict, company_name: str) -> str:
    """Assemble all artifacts into a single context block for the LLM."""
    sections = [
        f"COMPANY: {company_name}",
        "",
        _format_hypothesis(artifacts.get("hypothesis")),
        "",
        _format_call_notes(artifacts.get("call_notes", [])),
        "",
        _format_demo_plans(artifacts.get("demo_plans", [])),
        "",
        _format_expansion(artifacts.get("expansion_playbook")),
        "",
        _format_reports(artifacts.get("reports", [])),
        "",
        _format_precall_briefs(artifacts.get("precall_briefs", [])),
    ]

    notes = _format_company_notes(artifacts.get("company_notes", []))
    if notes:
        sections.extend(["", notes])

    slack = _format_slack_summaries(artifacts.get("slack_summaries", []))
    if slack:
        sections.extend(["", slack])

    return "\n".join(sections)


# ---------------------------------------------------------------------------
# Chat turn
# ---------------------------------------------------------------------------

async def chat_turn(
    company_name: str,
    user_message: str,
    artifacts: dict,
    conversation_id: str | None = None,
) -> dict:
    """Execute one company chat turn.

    Args:
        company_name: The company being discussed.
        user_message: The user's question.
        artifacts: Pre-gathered artifacts dict from _gather_company_artifacts().
        conversation_id: Existing conversation to continue, or None for new.

    Returns:
        {conversation_id, response, elapsed}
    """
    start = time.time()

    if conversation_id is None:
        conversation_id = create_conversation(company_name)

    recent = get_recent_messages(conversation_id, limit=_CONTEXT_WINDOW)

    context = _build_context(artifacts, company_name)

    messages: list[dict] = []
    for m in recent:
        messages.append({"role": m["role"], "content": m["content"]})

    user_content = (
        f"COMPANY ARTIFACTS CONTEXT:\n{context}\n\n"
        f"USER QUESTION: {user_message}"
    )
    messages.append({"role": "user", "content": user_content})

    client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)

    for attempt in range(4):
        try:
            response = await client.messages.create(
                model=settings.claude_model,
                max_tokens=2048,
                temperature=0.3,
                system=COMPANY_CHAT_SYSTEM_PROMPT,
                messages=messages,
            )
            answer = extract_text(response)
            break
        except anthropic.APIStatusError as e:
            if e.status_code in (429, 500, 529) and attempt < 3:
                wait = 2 ** attempt
                logger.warning("API busy, retrying in %ds ...", wait)
                await asyncio.sleep(wait)
            else:
                raise

    elapsed = round(time.time() - start, 1)

    add_message(conversation_id, "user", user_message)
    add_message(conversation_id, "assistant", answer)
    auto_title(conversation_id)

    return {
        "conversation_id": conversation_id,
        "response": answer,
        "elapsed": elapsed,
    }
