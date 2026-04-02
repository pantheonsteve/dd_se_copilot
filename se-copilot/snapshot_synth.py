"""Deal Snapshot synthesis — Claude reads all artifacts for a company and
produces a concise, prose-based answer to 'what's going on with this deal?'
Written to serve both the SE and a presales manager reviewing the pipeline."""

import json
import logging
import re
from datetime import datetime, timezone

import anthropic

from anthropic_helpers import extract_text
from config import settings

logger = logging.getLogger(__name__)

_FENCE_RE = re.compile(r"^```(?:json)?\s*\n(.*?)\n```\s*$", re.DOTALL)


def _strip_fences(text: str) -> str:
    m = _FENCE_RE.match(text.strip())
    return m.group(1).strip() if m else text.strip()


SNAPSHOT_SYSTEM_PROMPT = """\
You are a Deal Intelligence Engine for a Datadog presales organization. You receive \
all available artifacts for a specific deal and produce a concise snapshot that \
answers the question: "What is going on with this deal?"

Your output must serve two audiences simultaneously:
- An SE who wants a quick recap before a call or an internal review
- A presales manager scanning their pipeline who needs a clear-eyed verdict

---

TONE AND STYLE:

Write like a sharp, experienced colleague giving a verbal update — not like a CRM \
system generating a status report. Be specific, honest, and direct. If the deal \
looks healthy, say so and say why. If it looks stalled or at risk, say so clearly \
without hedging. Do not use filler phrases like "it's important to note" or \
"as we can see from the data."

No bullet points. No headers. Pure prose paragraphs. Every claim must be grounded \
in a specific artifact — cite what you saw (e.g., "the Jan 15 call note shows...", \
"the hypothesis flags Splunk as a confirmed competitive target...", "no demo plan \
has been generated yet...").

---

HEALTH SIGNAL RULES:

green:  Deal has clear momentum — recent customer engagement, identified champion, \
        buying signals outweigh risk flags, deal is progressing through stages.

yellow: Deal is moving but has meaningful gaps or risks — champion not confirmed, \
        key objections unresolved, artifacts stale (>21 days since last call note), \
        or key stage milestone missing (e.g., demo happened but no POC defined).

red:    Deal is at risk or stalled — no recent engagement (>30 days), economic buyer \
        not identified, significant unresolved objections, strong competitive threat \
        with no displacement strategy, or deal has regressed.

Set health conservatively. If you are uncertain, lean yellow rather than green. \
A manager should be able to trust this signal.

---

OUTPUT FORMAT:

Respond with ONLY a JSON object matching this schema:

{
  "deal_status_line": "One sentence verdict — stage + health signal + the defining characteristic of this deal right now",
  "health": "green | yellow | red",
  "health_rationale": "One sentence: the single most important reason for this health signal",

  "whats_happening": "1-2 paragraphs of narrative. What has been done, what has been learned, \
where the deal stands in the evaluation cycle. Name specific things: which stakeholders have \
been engaged, what pains have been confirmed, what objections have been raised, whether there \
is competitive pressure, how recently the last interaction happened.",

  "momentum_read": "1 paragraph: Is this deal moving or stalled? What is the evidence either way? \
Reference artifact recency, call note signal quality, whether next steps were agreed and \
followed through on, and the presence or absence of key milestones.",

  "risk_to_watch": "1 paragraph: The one or two specific things that could derail this deal. \
Not generic risk — ground it in what the artifacts actually show. Name the specific objection, \
the missing stakeholder, the competitive threat, or the gap that concerns you.",

  "inferred_stage": "prospecting | discovery | demo_complete | active_evaluation | evaluation | expansion_or_renewal | unknown",

  "days_since_last_activity": 0,

  "missing_critical": ["list of missing artifacts or stakeholders that meaningfully reduce confidence in this assessment"]
}

RECENCY WEIGHTING: Each note and artifact includes a date. More recent information should \
be weighted more heavily in your assessment. If newer notes or call notes contradict older \
ones (e.g., a pain point was resolved, a stakeholder changed, competitive landscape shifted), \
treat the newer information as the current ground truth and note the change. Stale information \
(>30 days) should be treated with lower confidence unless corroborated by recent data.

IMPORTANT: If artifact coverage is thin (e.g., only a hypothesis with no call notes), \
acknowledge this explicitly in whats_happening and set health to yellow or red accordingly. \
Do not fabricate a confident assessment from sparse data."""


def _compute_signals(
    call_notes: list[dict],
    hypothesis: dict | None,
    demo_plans: list[dict],
    expansion_playbook: dict | None,
    company_notes: list[dict] | None = None,
) -> dict:
    """Compute structured deal health signals from artifacts algorithmically.

    These are passed as structured context to Claude alongside the narrative content,
    giving it a pre-computed health dashboard to interpret.
    """
    now = datetime.now(timezone.utc)

    # Days since last activity (most recent artifact timestamp)
    timestamps = []
    for note in call_notes:
        if note.get("created_at"):
            timestamps.append(note["created_at"])
    if hypothesis and hypothesis.get("created_at"):
        timestamps.append(hypothesis["created_at"])
    for plan in demo_plans:
        if plan.get("created_at"):
            timestamps.append(plan["created_at"])
    if expansion_playbook and expansion_playbook.get("created_at"):
        timestamps.append(expansion_playbook["created_at"])
    for cn in (company_notes or []):
        ts = cn.get("note_date") or cn.get("created_at", "")
        if ts:
            timestamps.append(ts)

    days_since_last = None
    if timestamps:
        latest = max(timestamps)
        try:
            dt = datetime.fromisoformat(latest.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            days_since_last = (now - dt).days
        except (ValueError, TypeError):
            pass

    # Aggregate buying signals and risk flags across all call notes
    total_buying_signals = 0
    total_risk_flags = 0
    total_unresolved_objections = 0
    has_economic_buyer = False
    has_champion = False

    for note in call_notes:
        raw = note.get("summary_markdown", "")
        try:
            summary = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            continue

        sig = summary.get("signal_log", {})
        total_buying_signals += len(sig.get("buying_signals", []))
        total_risk_flags += len(sig.get("risk_flags", []))

        for obj in summary.get("objections", []):
            if obj.get("status") not in ("Addressed",):
                total_unresolved_objections += 1

        for stakeholder in summary.get("stakeholders", []):
            tags = [t.lower() for t in stakeholder.get("role_tags", [])]
            if "economic buyer" in tags:
                has_economic_buyer = True
            if "champion" in tags:
                has_champion = True

    return {
        "total_call_notes": len(call_notes),
        "days_since_last_activity": days_since_last,
        "total_buying_signals": total_buying_signals,
        "total_risk_flags": total_risk_flags,
        "unresolved_objection_count": total_unresolved_objections,
        "has_demo_plan": len(demo_plans) > 0,
        "has_expansion_playbook": expansion_playbook is not None,
        "has_economic_buyer": has_economic_buyer,
        "has_champion": has_champion,
        "hypothesis_confidence": hypothesis.get("confidence_level", "none") if hypothesis else "none",
    }


def _format_signals(signals: dict) -> str:
    parts = ["COMPUTED DEAL SIGNALS (use these to calibrate the health rating):"]
    parts.append(f"  Total call notes: {signals['total_call_notes']}")
    d = signals.get('days_since_last_activity')
    parts.append(f"  Days since last activity: {d if d is not None else 'unknown'}")
    parts.append(f"  Buying signals (total across all calls): {signals['total_buying_signals']}")
    parts.append(f"  Risk flags (total across all calls): {signals['total_risk_flags']}")
    parts.append(f"  Unresolved objections: {signals['unresolved_objection_count']}")
    parts.append(f"  Has demo plan: {signals['has_demo_plan']}")
    parts.append(f"  Has expansion playbook: {signals['has_expansion_playbook']}")
    parts.append(f"  Economic buyer identified: {signals['has_economic_buyer']}")
    parts.append(f"  Champion identified: {signals['has_champion']}")
    parts.append(f"  Hypothesis confidence: {signals['hypothesis_confidence']}")
    return "\n".join(parts)


def _format_hypothesis(hyp: dict | None) -> str:
    if not hyp:
        return "SALES HYPOTHESIS: Not generated."
    md = hyp.get("hypothesis_markdown", "")
    confidence = hyp.get("confidence_level", "unknown")
    created = hyp.get("created_at", "")[:10]
    truncated = md[:2500] + ("\n[...truncated]" if len(md) > 2500 else "")
    return f"SALES HYPOTHESIS (generated {created}, confidence: {confidence}):\n{truncated}"


def _format_call_notes(call_notes: list[dict]) -> str:
    if not call_notes:
        return "CALL NOTES: None captured."

    parts = ["CALL NOTES (most recent first):"]
    for i, note in enumerate(call_notes[:5]):
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
            for b in sig.get("buying_signals", [])[:2]:
                parts.append(f"  + {b}")
            for r in sig.get("risk_flags", [])[:2]:
                parts.append(f"  ! {r}")
            for ns in s.get("next_steps", [])[:3]:
                parts.append(f"  Next step [{ns.get('owner_side','?')}]: {ns.get('action','')}")
            bd = s.get("business_drivers", {})
            if bd.get("why_now"):
                parts.append(f"  Why now: {bd['why_now']}")
            if s.get("se_notes"):
                parts.append(f"  SE notes: {s['se_notes'][:200]}")
        except (json.JSONDecodeError, TypeError):
            parts.append(f"  {raw[:400]}")

    return "\n".join(parts)


def _format_demo_plans(demo_plans: list[dict]) -> str:
    if not demo_plans:
        return "DEMO PLANS: None generated."
    parts = ["DEMO PLANS:"]
    for p in demo_plans[:2]:
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
        parts.append(f"  Phases: {len(opps)}, top urgency: {opps[0].get('urgency','?')}")
    return "\n".join(parts)


def _format_company_notes(company_notes: list[dict]) -> str:
    """Format SE-authored company notes with recency annotations."""
    if not company_notes:
        return "SE NOTES: None captured."

    now = datetime.now(timezone.utc)
    sorted_notes = sorted(
        company_notes,
        key=lambda n: n.get("note_date") or n.get("created_at", ""),
        reverse=True,
    )

    parts = ["SE NOTES (most recent first — newer notes should be weighted more heavily; "
             "if newer information contradicts older information, the newer information takes precedence):"]
    for i, note in enumerate(sorted_notes[:8]):
        date_str = note.get("note_date") or note.get("created_at", "")[:10]
        title = note.get("title", f"Note {i + 1}")
        age_label = ""
        try:
            dt = datetime.fromisoformat(date_str + "T00:00:00+00:00") if len(date_str) == 10 else datetime.fromisoformat(date_str.replace("Z", "+00:00"))
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


def _format_slack_summaries(slack_summaries: list[dict]) -> str:
    if not slack_summaries:
        return ""
    parts = [f"SLACK CHANNEL SUMMARIES ({len(slack_summaries)}, most recent first):"]
    parts.append("Internal team discussions — highest-recency, highest-confidence context.")
    for s in slack_summaries[:5]:
        created = s.get("updated_at", s.get("created_at", ""))[:10]
        channel = s.get("channel_name", "").strip()
        parts.append(f"\n--- {channel or 'Slack'} ({created}) ---")
        text = s.get("summary_text", "").strip()
        if text:
            for line in text.splitlines():
                parts.append(f"  {line}" if line.strip() else "")
    return "\n".join(parts)


async def synthesize_snapshot(
    company_name: str,
    hypothesis: dict | None,
    call_notes: list[dict],
    demo_plans: list[dict],
    expansion_playbook: dict | None,
    reports: list[dict],
    additional_context: str | None = None,
    slack_summaries: list[dict] | None = None,
    company_notes: list[dict] | None = None,
) -> dict:
    """Call Claude to produce the Deal Snapshot.

    Returns a dict matching the snapshot schema.
    """
    signals = _compute_signals(call_notes, hypothesis, demo_plans, expansion_playbook, company_notes)

    user_parts = [
        f"COMPANY / OPPORTUNITY: {company_name}",
        "",
        _format_signals(signals),
        "",
        _format_hypothesis(hypothesis),
        "",
        _format_company_notes(company_notes or []),
        "",
        _format_call_notes(call_notes),
        "",
        _format_demo_plans(demo_plans),
        "",
        _format_expansion(expansion_playbook),
    ]

    if reports:
        parts = ["STRATEGIC REPORTS:"]
        for r in reports[:3]:
            parts.append(f"  - {r.get('title') or r.get('query','Untitled')} ({r.get('saved_at','')[:10]})")
        user_parts.extend(["", "\n".join(parts)])

    if slack_summaries:
        slack_section = _format_slack_summaries(slack_summaries)
        if slack_section:
            user_parts.extend(["", slack_section])

    if additional_context:
        user_parts.extend(["", f"ADDITIONAL CONTEXT FROM SE/MANAGER:\n{additional_context}"])

    user_parts.extend(["", "Generate the Deal Snapshot. Respond with ONLY a JSON object."])

    user_message = "\n".join(user_parts)
    client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)

    try:
        response = await client.messages.create(
            model=settings.claude_model,
            max_tokens=2000,
            temperature=0.3,
            system=SNAPSHOT_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_message}],
        )

        raw = _strip_fences(extract_text(response))
        data = json.loads(raw)

        # Inject computed signals into the response for display
        data["computed_signals"] = signals
        # Override days_since_last_activity with our precise calculation
        if signals.get("days_since_last_activity") is not None:
            data["days_since_last_activity"] = signals["days_since_last_activity"]

        return data

    except (json.JSONDecodeError, KeyError, ValueError) as exc:
        logger.warning("Deal snapshot synthesis JSON parsing failed: %s", exc)
        return _fallback_snapshot(company_name, str(exc))

    except Exception as exc:
        logger.error("Deal snapshot synthesis failed: %s", exc)
        return _fallback_snapshot(company_name, str(exc))


def _fallback_snapshot(company_name: str, error_msg: str) -> dict:
    return {
        "deal_status_line": f"Snapshot generation failed for {company_name}.",
        "health": "yellow",
        "health_rationale": f"Could not synthesize: {error_msg}",
        "whats_happening": "Snapshot generation failed. Please retry.",
        "momentum_read": "",
        "risk_to_watch": "",
        "inferred_stage": "unknown",
        "days_since_last_activity": None,
        "missing_critical": [],
        "computed_signals": {},
    }
