"""Pydantic models for the Account Expansion Playbook."""

from __future__ import annotations

from pydantic import BaseModel, Field


# --- Nested Models ---


class ProductRecommendation(BaseModel):
    """A specific Datadog product recommendation — validated by the Librarian agent."""

    product_name: str
    sku_or_tier: str | None = None
    key_capabilities: list[str] = Field(default_factory=list)
    why_this_product: str = ""
    replaces: list[str] = Field(default_factory=list)


class PersonaTarget(BaseModel):
    """The target buyer for an expansion opportunity."""

    name: str | None = None
    title: str
    why_this_person: str = ""
    relationship_to_champion: str | None = None


class ExpansionOpportunity(BaseModel):
    """A single expansion opportunity within the playbook."""

    phase: int
    opportunity_name: str

    products: list[ProductRecommendation] = Field(default_factory=list)

    target_team_or_bu: str = ""
    target_persona: PersonaTarget

    business_case: str = ""
    urgency: str = "medium"
    trigger_from_previous: str | None = None

    displaces: list[str] = Field(default_factory=list)
    displacement_confidence: str = "unverified"

    case_study_reference: str | None = None
    roi_evidence: str | None = None

    conversation_opener: str = ""
    discovery_questions: list[str] = Field(default_factory=list)
    success_metrics: list[str] = Field(default_factory=list)
    estimated_timeline: str = ""

    opportunity_type: str = "product_expansion"


# --- Top-Level Playbook ---


class ExpansionPlaybook(BaseModel):
    """The complete sequenced expansion plan."""

    company_name: str
    domain: str = ""
    generated_at: str = ""

    current_footprint_summary: str = ""
    current_champion: str | None = None

    opportunities: list[ExpansionOpportunity] = Field(default_factory=list)

    total_opportunities: int = 0
    opportunity_types: dict[str, int] = Field(default_factory=dict)
    estimated_total_expansion_arr: str | None = None

    content_gaps: list[str] = Field(default_factory=list)
    key_assumptions: list[str] = Field(default_factory=list)
    recommended_next_action: str = ""


# --- Existing Footprint (input) ---


class ExistingFootprint(BaseModel):
    """What Datadog products are already deployed in the account."""

    products: list[str] = Field(default_factory=list)
    teams_using: list[str] = Field(default_factory=list)
    known_champions: list[str] = Field(default_factory=list)
    approximate_spend: str | None = None
    deployment_scope: str | None = None


# --- Request / Response ---


class ExpansionRequest(BaseModel):
    company_name: str
    domain: str | None = None
    existing_footprint: ExistingFootprint | None = None
    hypothesis_id: str | None = None
    strategic_overview_id: str | None = None
    additional_context: str | None = None


class ExpansionResponse(BaseModel):
    id: str = ""
    company_name: str
    domain: str = ""
    playbook: ExpansionPlaybook
    stage_timings_ms: dict[str, int] = Field(default_factory=dict)
    processing_time_ms: int = 0


class ExpansionSummary(BaseModel):
    id: str
    created_at: str
    company_name: str
    domain: str = ""
    total_opportunities: int = 0
    processing_time_ms: int = 0
