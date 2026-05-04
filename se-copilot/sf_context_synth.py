"""Claude markdown summary for Salesforce (Snowflake) tabular context."""

from __future__ import annotations

import logging

import anthropic

from anthropic_helpers import extract_text
from config import settings

log = logging.getLogger(__name__)

SF_SUMMARY_SYSTEM_PROMPT = """You summarize Salesforce data (provided as JSON columns + rows) for a Datadog Sales Engineer viewing a single opportunity.

Rules:
- Output **markdown**: tight bullets; bold important metrics or dates when present in the data.
- Use **only** facts from the JSON; do not invent amounts, stages, close dates, contacts, or account facts.
- Frame notes in first person where natural ("I'm seeing…") but stay factual.
- If columns are sparse or empty, say what's missing in one line.
- Stay under ~220 words. No preamble ("Here is a summary")."""


async def summarize_salesforce_context_markdown(
    company_name: str,
    opportunity_name: str | None,
    salesforce_opportunity_id: str,
    payload_json: str,
) -> str:
    """Call Claude; return markdown summary."""
    if not (settings.anthropic_api_key or "").strip():
        raise ValueError("ANTHROPIC_API_KEY is not configured")

    opp = (opportunity_name or "").strip() or "(unknown name)"
    user_message = (
        f"COMPANY: {company_name}\n"
        f"HOMERUN_OPPORTUNITY_NAME: {opp}\n"
        f"SALESFORCE_OPPORTUNITY_ID: {salesforce_opportunity_id}\n\n"
        "DATA_JSON:\n"
        f"{payload_json}"
    )

    client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)
    response = await client.messages.create(
        model=settings.claude_model,
        max_tokens=1024,
        temperature=0.2,
        system=SF_SUMMARY_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_message}],
    )
    text = extract_text(response) if response.content else ""
    if not text.strip():
        raise ValueError("Empty summary from Claude")
    return text.strip()
