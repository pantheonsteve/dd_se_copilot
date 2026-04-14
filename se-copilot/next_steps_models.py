"""Pydantic models for the Next Steps Agent."""

from __future__ import annotations

from pydantic import BaseModel, Field


class CloseTimeline(BaseModel):
    """Evidence-backed estimate of when the deal may close — only when artifacts support it."""

    summary: str  # short human-readable window (e.g. decision before FY end, Q2 2026)
    confidence: str  # high | medium | low
    evidence: list[str] = Field(
        default_factory=list,
        description="Each line cites artifact + explicit timing signal",
    )


class NextStep(BaseModel):
    """A single prioritized action item."""

    priority: int  # 1 = most urgent
    action: str  # specific, imperative sentence — never generic
    owner: str  # "SE", "AE", "SE + AE", "Prospect"
    timeframe: str  # "Today", "This week", "Before next call", "Within 2 weeks"
    rationale: str  # why this matters right now, grounded in artifact evidence
    artifact_source: str  # which artifact triggered this
    category: str  # "Discovery" | "Technical" | "Commercial" | "Relationship" | "Internal"


class NextStepsResponse(BaseModel):
    """The full next steps plan for a deal."""

    id: str = ""
    company_name: str
    inferred_deal_stage: str  # prospecting | discovery | demo_complete | evaluation | expansion_or_renewal
    deal_stage_confidence: str = "medium"  # high | medium | low
    next_steps: list[NextStep] = Field(default_factory=list)
    blocking_risks: list[str] = Field(default_factory=list)
    missing_artifacts: list[str] = Field(default_factory=list)
    recommended_focus: str = ""  # single sentence: the one thing that matters most right now
    close_timeline: CloseTimeline | None = None  # only when explicit timing evidence exists
    processing_time_ms: int = 0


class NextStepsSummary(BaseModel):
    """Lightweight summary for list views."""

    id: str
    created_at: str
    company_name: str
    inferred_deal_stage: str
    deal_stage_confidence: str = "medium"
    recommended_focus: str = ""
    total_steps: int = 0
    processing_time_ms: int = 0


class NextStepsRequest(BaseModel):
    """Request to generate next steps for a company."""

    company_name: str
    company_id: str | None = None  # if from the defined companies list
    deal_stage_override: str | None = None  # SE can correct the inferred stage
    additional_context: str | None = None  # freeform SE notes about the deal
