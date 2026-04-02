"""Pydantic models for the Company Research Agent."""

from __future__ import annotations

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Request
# ---------------------------------------------------------------------------

class ResearchRequest(BaseModel):
    company_name: str
    domain: str | None = None
    additional_context: str | None = None


# ---------------------------------------------------------------------------
# Sumble API response models
# ---------------------------------------------------------------------------

class SumbleTechnology(BaseModel):
    """A technology detected via Sumble enrichment."""
    name: str = ""
    jobs_count: int = 0
    people_count: int = 0
    teams_count: int = 0
    last_job_post: str | None = None


class SumbleOrganization(BaseModel):
    name: str = ""
    domain: str = ""
    slug: str = ""
    technologies: list[SumbleTechnology] = Field(default_factory=list)
    technologies_found: str = ""


class SumbleJob(BaseModel):
    title: str = ""
    department: str = ""
    location: str = ""
    posted_date: str = ""
    description: str = ""
    technologies_mentioned: list[str] = Field(default_factory=list)
    teams: str = ""
    url: str = ""


class SumblePerson(BaseModel):
    name: str = ""
    title: str = ""
    seniority: str = ""
    department: str = ""
    linkedin_url: str = ""
    url: str = ""


class SumbleEnrichResponse(BaseModel):
    organization: SumbleOrganization = Field(default_factory=SumbleOrganization)
    raw: dict = Field(default_factory=dict)


class SumbleJobsResponse(BaseModel):
    jobs: list[SumbleJob] = Field(default_factory=list)
    total_count: int = 0
    raw: dict = Field(default_factory=dict)


class SumblePeopleResponse(BaseModel):
    people: list[SumblePerson] = Field(default_factory=list)
    total_count: int = 0
    raw: dict = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# SEC EDGAR research data (parsed from RAG agent responses)
# ---------------------------------------------------------------------------

class EdgarResearchData(BaseModel):
    ticker: str = ""
    company_name: str = ""
    filing_date: str = ""
    strategic_priorities: list[str] = Field(default_factory=list)
    risk_factors: list[str] = Field(default_factory=list)
    technology_investments: list[str] = Field(default_factory=list)
    financial_highlights: list[str] = Field(default_factory=list)
    raw_answer: str = ""


# ---------------------------------------------------------------------------
# Unified output schema
# ---------------------------------------------------------------------------

class CompanyResearch(BaseModel):
    company_name: str
    domain: str = ""
    is_public: bool = False

    # Strategic context
    strategic_priorities: list[str] = Field(default_factory=list)
    risk_factors: list[str] = Field(default_factory=list)
    technology_investments: list[str] = Field(default_factory=list)

    # Tech stack (from Sumble)
    current_observability_tools: list[str] = Field(default_factory=list)
    current_cloud_platforms: list[str] = Field(default_factory=list)
    current_infrastructure: list[str] = Field(default_factory=list)
    current_security_tools: list[str] = Field(default_factory=list)
    current_databases: list[str] = Field(default_factory=list)
    current_message_queues: list[str] = Field(default_factory=list)
    current_languages: list[str] = Field(default_factory=list)
    current_data_platforms: list[str] = Field(default_factory=list)
    current_cicd_tools: list[str] = Field(default_factory=list)
    current_feature_flags: list[str] = Field(default_factory=list)
    current_serverless: list[str] = Field(default_factory=list)
    current_networking: list[str] = Field(default_factory=list)

    # Classified technology landscape (from ConfidenceEngine)
    technology_landscape: dict = Field(default_factory=dict)

    # Hiring signals (from Sumble Jobs)
    hiring_velocity: str = "unknown"
    key_hiring_themes: list[str] = Field(default_factory=list)
    relevant_open_roles: list[dict] = Field(default_factory=list)

    # People / Org structure (from Sumble People)
    key_personas: list[dict] = Field(default_factory=list)
    recommended_entry_persona: dict = Field(default_factory=dict)

    # Competitive landscape
    competitive_displacement_targets: list[str] = Field(default_factory=list)

    # Company profile
    industry: str = ""
    employee_count: int | None = None
    description: str = ""

    # Metadata
    data_sources: list[str] = Field(default_factory=list)
    research_timestamp: str = ""
    confidence_level: str = "low"
