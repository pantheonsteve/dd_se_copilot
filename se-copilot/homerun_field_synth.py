"""Draft Homerun workspace field text via Claude JSON output (SE Copilot template tab)."""

from __future__ import annotations

import json
import logging
import re
from typing import Any

import anthropic

from anthropic_helpers import extract_text
from config import settings
from homerun_browser_automation import (
    HOMERUN_TEMPLATE_GENERATED_HEADINGS,
    HOMERUN_WORKSPACE_TEXTAREA_HEADINGS,
    dim_row_to_fill_strings,
)

SE_NEXT_STEPS_MAX_CHARS = 240
SE_OUTSTANDING_RISKS_MAX_CHARS = 255

# Field-generation prompts: keep artifacts short so the model focuses on the selected opportunity.
_ARTIFACT_LIMITS = {
    "hypothesis_body": 1400,
    "company_note": 450,
    "call_note": 320,
    "precall": 280,
    "slack": 220,
    "demo_titles": 5,
    "report_titles": 5,
    "max_company_notes": 8,
    "max_call_notes": 4,
    "max_precall": 2,
    "max_slack": 2,
}

logger = logging.getLogger(__name__)

_FENCE_RE = re.compile(r"^```(?:json)?\s*\n(.*?)\n```\s*$", re.DOTALL)


def _strip_fences(text: str) -> str:
    m = _FENCE_RE.match(text.strip())
    return m.group(1).strip() if m else text.strip()


HOMERUN_FIELD_SYSTEM_PROMPT = """\
You draft Homerun workspace fields as the assigned Sales Engineer (first person: I / we / my). \
Write like concise internal notes another SE or leader would skim before a call—not marketing, \
not a generic AI summary.

SCOPE (critical):
- There is exactly ONE **selected** Homerun opportunity for this draft; its official name and \
Snowflake snapshot appear under "Selected Homerun opportunity".
- The same customer account may have **other** linked opportunities listed separately. Treat those \
as different deals: never blend renewal scope into a BitsAI deal (or vice versa). If company-wide \
artifacts mention multiple products, only keep what clearly applies to the **selected** opportunity \
name and stage.

Relevance and length:
- Prefer short paragraphs or tight bullets. Omit background that does not help someone executing \
this presale **for this opportunity**.
- Do not paste long hypotheses or call summaries wholesale—extract only lines that matter for each \
field below.

Voice:
- Sound human and accountable ("I'm validating…", "We're blocked on…", "I'll follow up on…").
- Avoid hedging filler ("It is worth noting", "In today's landscape"), vague consultative prose, \
and third-person references to "the SE" (you are the SE).

Facts:
- Do not invent customer facts. If something is unknown, say "TBD" or name the gap briefly.

FIELD INTENT (stay brief):
- **Technical Plan/Status**: What we're proving technically for **this** opp, what's done vs next.
- **Current Status**: Plain-English deal/technical posture for **this** opp (may align with Snowflake \
current status when helpful).
- **SE Next Steps**: Concrete next actions I own; no fluff.
- **Current Environment/Tools**: Only stack/tools relevant to **this** scope.
- **SE Outstanding Risks**: Real risks/blockers for **this** opp (hard cap """ + str(SE_OUTSTANDING_RISKS_MAX_CHARS) + """ characters).
- **Link to Opportunity Documents**: Short pointers (doc names, links if in context)—not essays.

---

OUTPUT FORMAT:

Respond with ONLY a JSON object. Keys MUST be exactly these strings (Homerun UI field labels). \
Do NOT include "SE Leader Next Steps" — that field is maintained only in Homerun.
""" + "\n".join(f'  "{h}"' for h in HOMERUN_TEMPLATE_GENERATED_HEADINGS) + """

Each value is a string (use empty string \"\" only if there is truly nothing useful to say). \
The value for "SE Next Steps" MUST be at most """ + str(SE_NEXT_STEPS_MAX_CHARS) + """ characters total. \
The value for "SE Outstanding Risks" MUST be at most """ + str(SE_OUTSTANDING_RISKS_MAX_CHARS) + """ characters total. \
Do not include any other keys. Do not wrap in markdown fences."""


def _truncate(s: str, max_chars: int) -> str:
    s = (s or "").strip()
    if len(s) <= max_chars:
        return s
    return s[: max_chars - 3] + "..."


def _format_artifacts_for_prompt(artifacts: dict[str, Any]) -> str:
    """Compact artifact summary for field drafting (short—model should extract, not echo)."""
    lim = _ARTIFACT_LIMITS
    parts: list[str] = []

    hyp = artifacts.get("hypothesis")
    if hyp:
        rs = hyp.get("research_summary") or {}
        es = ""
        if isinstance(rs, dict):
            es = (rs.get("executive_summary") or rs.get("summary") or "").strip()
        hm = hyp.get("hypothesis_markdown") or ""
        blob = es or _truncate(hm, lim["hypothesis_body"])
        if blob:
            parts.append(
                "### Hypothesis (excerpt — extract only what applies to the selected opportunity)\n"
                + _truncate(blob, lim["hypothesis_body"])
            )

    for n in (artifacts.get("company_notes") or [])[: lim["max_company_notes"]]:
        title = n.get("title", "")
        content = _truncate(n.get("content", ""), lim["company_note"])
        if title or content:
            parts.append(f"### Company note: {title}\n{content}")

    for cn in (artifacts.get("call_notes") or [])[: lim["max_call_notes"]]:
        title = cn.get("title", "Call")
        sm = _truncate(cn.get("summary_markdown") or "", lim["call_note"])
        if sm:
            parts.append(f"### Call note: {title}\n{sm}")

    for pb in (artifacts.get("precall_briefs") or [])[: lim["max_precall"]]:
        ns = pb.get("north_star") or ""
        ct = pb.get("call_type") or ""
        if ns:
            parts.append(f"### Pre-call brief ({ct})\n{_truncate(ns, lim['precall'])}")

    dps = artifacts.get("demo_plans") or []
    if dps:
        titles = ", ".join(
            p.get("title", "") for p in dps[: lim["demo_titles"]] if p.get("title")
        )
        if titles:
            parts.append("### Demo plans (titles)\n" + titles)

    reps = artifacts.get("reports") or []
    if reps:
        titles = ", ".join(
            r.get("title", r.get("query", "")) for r in reps[: lim["report_titles"]]
        )
        if titles:
            parts.append("### Strategy reports (titles)\n" + titles)

    slack = artifacts.get("slack_summaries") or []
    for s in slack[: lim["max_slack"]]:
        tx = _truncate(s.get("summary_text") or "", lim["slack"])
        if tx:
            parts.append("### Slack context (excerpt)\n" + tx)

    return "\n\n".join(parts) if parts else "(No additional artifacts in SE Copilot.)"


def _format_dim_for_prompt(dim_row: dict[str, Any] | None) -> str:
    if not dim_row:
        return "(No Homerun DIM row loaded — Snowflake may be disabled or opportunity not found.)"
    name = (dim_row.get("OPPORTUNITY_NAME") or "").strip() or "Unknown"
    stage = (dim_row.get("HOMERUN_STAGE") or "").strip() or "Unknown"
    uid = (dim_row.get("OPPORTUNITY_UUID") or "").strip() or "—"
    sf_id = (dim_row.get("SALESFORCE_OPPORTUNITY_ID") or "").strip()
    tl = (dim_row.get("TECHNICAL_LEAD") or "").strip()

    lines = [
        "### Selected Homerun opportunity (authoritative scope for this draft)",
        f"- **Official opportunity name (from Snowflake):** {name}",
        f"- **Homerun stage:** {stage}",
        f"- **OPPORTUNITY_UUID:** `{uid}`",
    ]
    if sf_id:
        lines.append(f"- **Salesforce opportunity id:** {sf_id}")
    if tl:
        lines.append(f"- **Technical lead (if listed):** {tl}")
    lines.append(
        "\nUse the opportunity **name** above to decide what in company artifacts belongs "
        "here vs another deal (e.g. renewal vs product expansion)."
    )

    current = dim_row_to_fill_strings(dim_row)
    if not current:
        lines.append("\n**Current workspace text fields:** (empty in Snowflake snapshot)")
        return "\n".join(lines)

    lines.append("\n**Current workspace text fields (from Snowflake — revise/update, do not blindly repeat):**")
    for h in HOMERUN_WORKSPACE_TEXTAREA_HEADINGS:
        v = current.get(h, "")
        if v:
            lines.append(f"- **{h}:** {_truncate(v, 900)}")
    return "\n".join(lines)


def _format_other_linked_opportunities(rows: list[dict[str, Any]]) -> str:
    if not rows:
        return ""
    lines = [
        "### Other Homerun opportunities linked to this company (NOT selected)",
        "Separate deals—do **not** merge their scope into the fields. Use this list only to avoid "
        "mixing up renewal vs product work (and similar).",
    ]
    for r in rows:
        nm = (r.get("opportunity_name") or "").strip() or "(unnamed)"
        u = (r.get("opportunity_uuid") or "").strip()
        st = (r.get("homerun_stage") or "").strip()
        tail = f" — stage: {st}" if st else ""
        lines.append(f"- **{nm}** (`{u}`){tail}")
    return "\n".join(lines)


def build_homerun_field_user_message(
    user_prompt: str,
    company_name: str,
    company_domain: str,
    company_notes: str,
    artifacts: dict[str, Any],
    dim_row: dict[str, Any] | None,
    *,
    other_linked_opportunities: list[dict[str, Any]] | None = None,
) -> str:
    meta = [
        f"COMPANY: {company_name}",
        f"DOMAIN: {company_domain or '—'}",
    ]
    if company_notes:
        meta.append(f"COMPANY NOTES (SQLite):\n{_truncate(company_notes, 1200)}")

    other = _format_other_linked_opportunities(other_linked_opportunities or [])

    return (
        "## User instructions (highest priority)\n"
        f"{user_prompt.strip() or '(No extra instructions — tighten and complete fields for the selected opportunity only.)'}\n\n"
        "## Company\n"
        + "\n".join(meta)
        + "\n\n## Homerun opportunity snapshot (Snowflake — selected deal)\n"
        + _format_dim_for_prompt(dim_row)
        + ("\n\n" + other if other else "")
        + "\n\n## SE Copilot artifacts (noisy — extract sparingly for the selected opportunity)\n"
        + _format_artifacts_for_prompt(artifacts)
    )


def _parse_field_json(
    raw: str,
) -> dict[str, str]:
    data = json.loads(_strip_fences(raw))
    if not isinstance(data, dict):
        raise ValueError("Expected JSON object")
    out: dict[str, str] = {}
    for h in HOMERUN_TEMPLATE_GENERATED_HEADINGS:
        v = data.get(h)
        if v is None:
            continue
        if isinstance(v, (list, dict)):
            out[h] = json.dumps(v, default=str)
        else:
            out[h] = str(v).strip()
    return out


async def generate_homerun_field_values(
    user_prompt: str,
    company_name: str,
    company_domain: str,
    company_notes: str,
    artifacts: dict[str, Any],
    dim_row: dict[str, Any] | None,
    *,
    other_linked_opportunities: list[dict[str, Any]] | None = None,
) -> dict[str, str]:
    """Call Claude; return values keyed by Homerun UI heading."""
    user_message = build_homerun_field_user_message(
        user_prompt,
        company_name,
        company_domain,
        company_notes,
        artifacts,
        dim_row,
        other_linked_opportunities=other_linked_opportunities,
    )

    client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)
    last_err: Exception | None = None

    for attempt in range(2):
        try:
            response = await client.messages.create(
                model=settings.claude_model,
                max_tokens=4096,
                temperature=0.3,
                system=HOMERUN_FIELD_SYSTEM_PROMPT,
                messages=[{"role": "user", "content": user_message}],
            )
            text = extract_text(response) if response.content else ""
            if not text.strip():
                raise ValueError("Empty response from Claude")
            out = _parse_field_json(text)
            if "SE Next Steps" in out:
                out["SE Next Steps"] = _truncate(out["SE Next Steps"], SE_NEXT_STEPS_MAX_CHARS)
            if "SE Outstanding Risks" in out:
                out["SE Outstanding Risks"] = _truncate(
                    out["SE Outstanding Risks"], SE_OUTSTANDING_RISKS_MAX_CHARS
                )
            return out
        except (json.JSONDecodeError, ValueError, KeyError) as exc:
            last_err = exc
            logger.warning("Homerun field JSON parse failed attempt %s: %s", attempt + 1, exc)
            user_message += (
                "\n\nIMPORTANT: Your previous reply was not valid JSON. "
                "Reply with ONLY a single JSON object, keys exactly as specified, no markdown."
            )
        except Exception as exc:
            logger.exception("Homerun field generation failed: %s", exc)
            raise

    raise last_err or RuntimeError("Homerun field generation failed after retries")
