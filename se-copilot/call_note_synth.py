"""Call transcript summarization using Claude — SE framework edition."""

import json
import logging
import re

import anthropic

from anthropic_helpers import extract_text
from config import settings

logger = logging.getLogger(__name__)


def _try_repair_json(raw: str) -> str | None:
    """Best-effort repair of truncated JSON from a max_tokens cutoff.

    Attempts to close any open strings, arrays, and objects so the
    result is parseable.  Returns the repaired string on success,
    or None if repair fails.
    """
    text = raw.rstrip()
    # Strip trailing comma that often precedes the cutoff point
    text = re.sub(r",\s*$", "", text)

    # Close any open quoted string
    if text.count('"') % 2 == 1:
        text += '"'

    # Balance braces / brackets
    opens = text.count("{") - text.count("}")
    opens_arr = text.count("[") - text.count("]")
    text += "]" * opens_arr + "}" * opens

    try:
        json.loads(text)
        return text
    except json.JSONDecodeError:
        return None

CALL_SUMMARY_SYSTEM_PROMPT = """\
You are a Call Summary Engine for Sales Engineers. You receive raw call transcripts \
(which may be noisy, duplicated, or OCR-captured) and produce a structured JSON summary \
following a specific SE framework. Extract signal even from messy transcripts.

Return ONLY a valid JSON object — no markdown fences, no preamble, no trailing text.

The JSON must have exactly these top-level keys:

{
  "call_context": {
    "date": "string or empty",
    "duration_estimate": "string or empty",
    "call_type": "one of: Discovery | Demo | Technical Deep Dive | Follow-Up | QBR | EBR | POC Review | Intro | Other",
    "deal_stage": "string description of where this appears to be in the sales cycle"
  },

  "stakeholders": [
    {
      "name": "string",
      "org": "Prospect | Vendor | Partner",
      "title": "string or empty",
      "role_tags": ["array of short tags e.g. Decision Maker, Technical Owner, Champion, Economic Buyer, End User, Blocker"],
      "notes": "1-2 sentence summary of their perspective or contribution"
    }
  ],

  "technical_requirements": {
    "current_stack": ["list of technologies, platforms, tools mentioned"],
    "integrations_needed": ["list of integration requirements or dependencies"],
    "infrastructure_notes": "free text about scale, cloud, k8s, regions, etc.",
    "security_compliance": ["list of security or compliance requirements mentioned"],
    "technical_goals": ["list of stated technical objectives"]
  },

  "pain_points": [
    {
      "pain": "string description of the pain",
      "impact": "string — business or technical impact if mentioned",
      "urgency": "High | Medium | Low | Unknown"
    }
  ],

  "business_drivers": {
    "why_now": "string — what is driving the evaluation or urgency right now",
    "business_context": "string — relevant business events (M&A, reorg, cost pressure, etc.)"
  },

  "competitive_ecosystem": {
    "incumbents": ["tools or vendors currently in use"],
    "also_evaluating": ["other vendors being evaluated"],
    "required_integrations": ["tools this must integrate with"],
    "notes": "any other competitive or ecosystem context"
  },

  "decision_criteria": {
    "must_haves": ["explicit requirements or blockers"],
    "nice_to_haves": ["mentioned preferences that are not hard requirements"],
    "success_definition": "string — how the prospect defines a successful outcome",
    "evaluation_timeline": "string or empty"
  },

  "objections": [
    {
      "objection": "string",
      "type": "Technical | Commercial | Strategic | Process",
      "status": "Raised | Partially Addressed | Addressed"
    }
  ],

  "next_steps": [
    {
      "action": "string description of the action",
      "owner": "string — person or role responsible",
      "owner_side": "SE | AE | Prospect | Joint",
      "due": "string or empty"
    }
  ],

  "signal_log": {
    "buying_signals": ["list of positive signals observed"],
    "risk_flags": ["list of risk indicators"],
    "open_questions": ["list of unanswered questions that need follow-up"]
  },

  "se_notes": "Free text field for any SE-specific observations that don't fit above — \
product gaps, POC ideas, technical risks, follow-up recommendations."
}

Rules:
1. Preserve specific names, team names, product names, and numbers exactly as spoken.
2. If a field cannot be determined from the transcript, use empty string "" or empty array [].
3. Do not invent information — only extract what is clearly present or strongly implied.
4. The transcript may be noisy or duplicated; de-duplicate content intelligently.
5. Return ONLY the JSON object. No markdown. No explanation."""


def _error_stub(se_notes: str) -> str:
    """Return a minimal valid JSON stub so the frontend doesn't break."""
    return json.dumps({
        "call_context": {"date": "", "duration_estimate": "", "call_type": "Other", "deal_stage": ""},
        "stakeholders": [],
        "technical_requirements": {"current_stack": [], "integrations_needed": [], "infrastructure_notes": "", "security_compliance": [], "technical_goals": []},
        "pain_points": [],
        "business_drivers": {"why_now": "", "business_context": ""},
        "competitive_ecosystem": {"incumbents": [], "also_evaluating": [], "required_integrations": [], "notes": ""},
        "decision_criteria": {"must_haves": [], "nice_to_haves": [], "success_definition": "", "evaluation_timeline": ""},
        "objections": [],
        "next_steps": [],
        "signal_log": {"buying_signals": [], "risk_flags": [], "open_questions": []},
        "se_notes": se_notes,
    })


async def summarize_call_transcript(raw_transcript: str) -> str:
    """Call Claude to produce a structured SE framework summary.

    Returns a JSON string on success, or a fallback markdown string on error.
    """
    client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)

    try:
        response = await client.messages.create(
            model=settings.claude_model,
            max_tokens=16384,
            temperature=0.1,
            system=CALL_SUMMARY_SYSTEM_PROMPT,
            messages=[{
                "role": "user",
                "content": (
                    "Summarize this call transcript using the SE framework:\n\n"
                    f"{raw_transcript}"
                ),
            }],
        )
        raw = extract_text(response).strip()

        if response.stop_reason == "max_tokens":
            logger.warning("Call summary response was truncated (hit max_tokens). Attempting repair.")
            repaired = _try_repair_json(raw)
            if repaired is not None:
                logger.info("Truncated JSON repaired successfully.")
                return repaired
            logger.error("Could not repair truncated JSON. Preview: %s", raw[:300])
            return _error_stub(
                f"Summary was truncated by the model and could not be repaired. "
                f"Raw preview: {raw[:300]}"
            )

        json.loads(raw)
        return raw

    except json.JSONDecodeError as jexc:
        logger.error("Claude returned non-JSON for call summary: %s", jexc)
        repaired = _try_repair_json(raw)
        if repaired is not None:
            logger.info("Non-standard JSON repaired successfully.")
            return repaired
        return _error_stub(
            f"Summary generation failed (JSON parse error). Raw response preview: {raw[:300]}"
        )

    except Exception as exc:
        logger.error("Call transcript summarization failed: %s", exc)
        return _error_stub(f"Summary generation failed: {exc}")
