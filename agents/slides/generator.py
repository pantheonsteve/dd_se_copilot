"""Core slide generation logic — calls Claude and parses the JSON response."""

import json
import logging
import re

import anthropic

from config import settings
from models import SlideDeck
from prompt import SLIDE_SYSTEM_PROMPT

logger = logging.getLogger(__name__)

_FENCE_RE = re.compile(r"^```(?:json)?\s*\n(.*?)\n```\s*$", re.DOTALL)


def _strip_fences(text: str) -> str:
    """Remove markdown code fences that Claude sometimes wraps around JSON."""
    m = _FENCE_RE.match(text.strip())
    return m.group(1).strip() if m else text.strip()


def _validate_deck(deck: SlideDeck) -> SlideDeck:
    """Ensure slide numbers are sequential and every slide has both text fields."""
    for i, slide in enumerate(deck.slides, start=1):
        if slide.slide_number != i:
            logger.warning(
                "Slide number mismatch: expected %d, got %d — renumbering",
                i,
                slide.slide_number,
            )
            slide.slide_number = i
        if not slide.customer_facing_text:
            logger.warning("Slide %d missing customer_facing_text", i)
        if not slide.internal_speaker_notes:
            logger.warning("Slide %d missing internal_speaker_notes", i)
    return deck


async def generate_slides(demo_plan: str) -> SlideDeck:
    """Send the demo plan to Claude and return a validated SlideDeck."""
    client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)

    response = await client.messages.create(
        model=settings.claude_model,
        max_tokens=8192,
        temperature=0.3,
        system=SLIDE_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": demo_plan}],
    )

    raw = _strip_fences(response.content[0].text)
    data = json.loads(raw)
    deck = SlideDeck.model_validate(data)
    return _validate_deck(deck)
