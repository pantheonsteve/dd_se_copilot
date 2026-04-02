"""Pydantic models for the Pre-Call Brief Generator."""

from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field


class CallType(str, Enum):
    DISCOVERY = "discovery"
    FOLLOWUP = "followup"
    TECHNICAL_DEEP_DIVE = "technical_deep_dive"
    EXEC_BRIEFING = "exec_briefing"
    POC_KICKOFF = "poc_kickoff"
    POC_REVIEW = "poc_review"
    CHAMPION_CHECKIN = "champion_checkin"
    COMMERCIAL = "commercial"


class CallQuestion(BaseModel):
    """A prepared question with strategic context."""

    question: str
    strategic_purpose: str  # what you're really learning from asking this
    follow_up_if: str | None = None  # "if they say X, probe with Y"


class AttendeeBrief(BaseModel):
    """One-line prep for each known attendee."""

    name: str
    inferred_role: str  # from call notes or hypothesis personas
    what_they_care_about: str  # 1 sentence grounded in artifact data
    how_to_engage: str  # 1 sentence tactical tip for this person


class PreCallBrief(BaseModel):
    """The full pre-call brief — readable in under 5 minutes."""

    company_name: str
    call_type: str

    # Situation
    situation_summary: str  # 3-4 sentences: where we are in the deal right now

    # What we know vs. don't know
    what_we_know: list[str] = Field(default_factory=list)  # confirmed facts
    what_we_dont_know: list[str] = Field(default_factory=list)  # open questions

    # This call
    call_objectives: list[str] = Field(default_factory=list)  # exactly 3: what success looks like
    questions_to_ask: list[CallQuestion] = Field(default_factory=list)  # 4-6 prepared questions

    # Attendee prep
    attendee_prep: list[AttendeeBrief] = Field(default_factory=list)

    # Landmines + quick refs
    things_to_avoid: list[str] = Field(default_factory=list)  # objections likely to surface
    key_proof_points: list[str] = Field(default_factory=list)  # 2-3 most relevant proof points

    # The one thing
    north_star: str = ""  # single sentence: what makes this call a win

    processing_time_ms: int = 0


class PreCallBriefRequest(BaseModel):
    """Request to generate a pre-call brief."""

    company_name: str
    call_type: CallType
    attendees: list[str] = Field(default_factory=list)  # freeform, e.g. "Sarah Chen - VP Eng"
    call_objective: str = ""  # SE's stated goal for this specific call
    additional_context: str = ""  # anything the SE wants Claude to know

    # Optional: pull specific saved artifacts by ID
    hypothesis_id: str | None = None
    call_note_ids: list[str] = Field(default_factory=list)  # specific call notes to include
    demo_plan_id: str | None = None
