"""Slide generation — turns a demo plan into structured JSON slides.

Can operate in two modes:
  1. Inline: calls Claude directly from within se-copilot (default).
  2. Remote: proxies to the standalone agents/slides service if configured.
"""

import json
import logging
import re

import anthropic
import httpx

from ddtrace.llmobs import LLMObs
from ddtrace.llmobs.decorators import llm, task, workflow

from anthropic_helpers import extract_text
from config import settings

logger = logging.getLogger(__name__)

_FENCE_RE = re.compile(r"^```(?:json)?\s*\n(.*?)\n```\s*$", re.DOTALL)

SLIDE_SYSTEM_PROMPT = """\
You are a Sales Engineering "demo anchor slide" generation agent.

Goal
- Take a detailed demo plan and produce a JSON object that an orchestrator can render into customer-facing slides.
- Every slide must include:
  1) customer-facing text that can be copied directly into a deck
  2) internal speaker notes (talk track, discovery questions, proof points, reminders)
- Output must be JSON ONLY (no markdown).

Hard requirements
1) Strict separation:
   - Put only customer-safe language in `customer_facing_text`.
   - Put discovery questions, talk track, internal product notes, competitive framing, \
implementation details, and any uncertain metrics in `internal_speaker_notes` ONLY.
2) Human-friendly slide structure:
   - No placeholders like "Main Bullets."
   - Each slide title and section header must read naturally in a live customer demo.
3) Demo2Win-aligned opening:
   - Slide 1 must be an Agenda slide.
   - Slide 2 must be a "What we heard" alignment slide (Goals/Objectives, Initiatives, \
Risks/Challenges) OR a short human-friendly equivalent that still clearly covers those \
three categories.
   - Slide 2 must include a customer-facing confirmation question (e.g., "Did we capture \
this correctly?").
4) Keep the deck small and demo-driven:
   - Default 6-10 slides (unless the plan clearly requires more).
   - Use "Demo chapter" slides to introduce each live demo segment.
   - Include a "Phased plan / timeline" slide and a "Next steps" slide.
5) No invented facts:
   - Do not invent customer quotes, metrics, ticket volumes, deadlines, renewal dates, \
or tool counts.
   - If the demo plan includes a metric, you may include it only in \
`internal_speaker_notes` unless the plan explicitly states it is customer-approved and \
safe to share.
6) Style rules for customer-facing text:
   - Minimal text: target 25-60 words per slide (excluding agenda timestamps).
   - Short bullets (max 10 words each where possible).
   - Outcome-first phrasing.
   - Avoid internal jargon; when using product names, keep them simple and consistent.

Input format you will receive
- A "demo plan" with: audience/personas, customer background, pains, current state, \
desired future state, success criteria, demo storyline, product areas to show, proof \
points, risks/objections, competitive context, timeline/forcing events, and next steps.

Output format (JSON ONLY)
Return this exact top-level schema:

{
  "deck_title": "string",
  "audience": "string",
  "source_summary": {
    "customer_name": "string or null",
    "demo_goal": "string",
    "timebox_minutes": number,
    "key_forcing_event": "string or null",
    "primary_competitors_or_tools": ["string"]
  },
  "slides": [
    {
      "slide_number": number,
      "title": "string",
      "customer_facing_text": [
        "line 1",
        "line 2",
        "... (each entry is a line to render; orchestrator will handle layout)"
      ],
      "internal_speaker_notes": [
        "talk track line 1",
        "discovery question: ...?",
        "proof point (internal): ...",
        "do/don't: ...",
        "... (bulleted as separate strings)"
      ],
      "tags": ["agenda" | "alignment" | "demo_intro" | "recap" | "plan" | "next_steps" \
| "backup"]
    }
  ]
}

Generation procedure
1) Parse the demo plan and extract:
   - customer's stated priorities and pains (in their words if provided)
   - current state and negative outcomes
   - desired future state and positive outcomes
   - demo chapters (what will be shown live)
   - timeline / forcing function and success criteria
2) Build slide outline:
   - Slide 1: Agenda (timebox + chapters)
   - Slide 2: What we heard (alignment + confirm question)
   - Slides 3-N-2: Demo chapter intro slides (1 per major chapter)
   - Second-to-last: Phased plan / timeline
   - Last: Next steps (scope + success criteria + stakeholders)
3) Write customer-facing text:
   - Make it read like it belongs in a real deck.
   - Remove anything speculative or overly technical.
4) Write internal speaker notes:
   - Include the discovery questions you intend to ask during that slide.
   - Include specific click-path beats, proof points, competitive positioning, and \
objection handling.
   - Include "if asked" backup info.
5) Validate:
   - Ensure every slide has both fields.
   - Ensure slide numbers are sequential.
   - Ensure JSON is valid.

Now generate the JSON slide output from this demo plan:"""


def _strip_fences(text: str) -> str:
    m = _FENCE_RE.match(text.strip())
    return m.group(1).strip() if m else text.strip()


def _validate_slides(data: dict) -> dict:
    """Ensure slide numbers are sequential and every slide has both text fields."""
    for i, slide in enumerate(data.get("slides", []), start=1):
        if slide.get("slide_number") != i:
            logger.warning("Renumbering slide %s -> %d", slide.get("slide_number"), i)
            slide["slide_number"] = i
        if not slide.get("customer_facing_text"):
            slide["customer_facing_text"] = []
            logger.warning("Slide %d missing customer_facing_text", i)
        if not slide.get("internal_speaker_notes"):
            slide["internal_speaker_notes"] = []
            logger.warning("Slide %d missing internal_speaker_notes", i)
    return data


@llm(model_name=settings.claude_model, name="generate_slides_inline", model_provider="anthropic")
async def _generate_inline(demo_plan: str, _retries: int = 2) -> dict:
    """Call Claude directly to generate the slide deck JSON."""
    client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)

    last_error: Exception | None = None
    for attempt in range(_retries + 1):
        response = await client.messages.create(
            model=settings.claude_model,
            max_tokens=8192,
            temperature=0.3,
            system=SLIDE_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": demo_plan}],
        )

        text = extract_text(response) if response.content else ""

        LLMObs.annotate(
            input_data=[
                {"role": "system", "content": SLIDE_SYSTEM_PROMPT},
                {"role": "user", "content": demo_plan},
            ],
            output_data=[{"role": "assistant", "content": text}],
            metadata={"temperature": 0.3, "max_tokens": 8192, "attempt": attempt},
            metrics={
                "input_tokens": response.usage.input_tokens,
                "output_tokens": response.usage.output_tokens,
                "total_tokens": response.usage.input_tokens + response.usage.output_tokens,
            },
        )

        if not text.strip():
            last_error = ValueError(
                f"Claude returned empty response (attempt {attempt + 1}/{_retries + 1}, "
                f"stop_reason={response.stop_reason})"
            )
            logger.warning(str(last_error))
            continue

        try:
            raw = _strip_fences(text)
            data = json.loads(raw)
            return _validate_slides(data)
        except json.JSONDecodeError as exc:
            last_error = exc
            logger.warning(
                "Slide JSON parse failed (attempt %d/%d): %s — response preview: %.200s",
                attempt + 1, _retries + 1, exc, text[:200],
            )
            continue

    raise last_error or ValueError("Slide generation failed after all retries")


@task(name="generate_slides_remote")
async def _generate_remote(demo_plan: str) -> dict:
    """Proxy to the standalone slide agent service."""
    async with httpx.AsyncClient(timeout=120) as client:
        resp = await client.post(
            settings.slide_agent_url,
            json={"demo_plan": demo_plan},
        )
        resp.raise_for_status()
        result = resp.json()
        return result.get("slide_deck", result)


@workflow(name="generate_slide_deck")
async def generate_slide_deck(demo_plan: str) -> dict:
    """Generate a slide deck from a demo plan.

    Uses the remote slide agent if configured and reachable, otherwise
    falls back to inline generation via Claude.
    """
    if settings.slide_agent_url:
        try:
            return await _generate_remote(demo_plan)
        except Exception as exc:
            logger.warning(
                "Remote slide agent failed, falling back to inline: %s", exc
            )

    return await _generate_inline(demo_plan)
