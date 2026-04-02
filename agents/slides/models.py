"""Pydantic models for the Slide Generation Agent."""

from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field


class SlideTag(str, Enum):
    AGENDA = "agenda"
    ALIGNMENT = "alignment"
    DEMO_INTRO = "demo_intro"
    RECAP = "recap"
    PLAN = "plan"
    NEXT_STEPS = "next_steps"
    BACKUP = "backup"


class SourceSummary(BaseModel):
    customer_name: str | None = None
    demo_goal: str = ""
    timebox_minutes: int = 60
    key_forcing_event: str | None = None
    primary_competitors_or_tools: list[str] = Field(default_factory=list)


class Slide(BaseModel):
    slide_number: int
    title: str
    customer_facing_text: list[str] = Field(default_factory=list)
    internal_speaker_notes: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)


class SlideDeck(BaseModel):
    deck_title: str
    audience: str
    source_summary: SourceSummary
    slides: list[Slide] = Field(default_factory=list)


# --- Request / Response ---


class GenerateRequest(BaseModel):
    demo_plan: str


class GenerateResponse(BaseModel):
    slide_deck: SlideDeck
    processing_time_ms: int = 0
