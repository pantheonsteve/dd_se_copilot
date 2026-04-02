"""Pydantic request/response models for the SE Copilot Router service."""

from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class Persona(str, Enum):
    ARCHITECT = "architect"
    CLOUD_ENGINEER = "cloud_engineer"
    SRE_DEVOPS_PLATFORM_OPS = "sre_devops_platform_ops"
    SOFTWARE_ENGINEER = "software_engineer"
    FRONTEND_ENGINEER = "frontend_engineer"
    NETWORK_ENGINEER = "network_engineer"
    TECH_EXECUTIVE = "tech_executive"
    FINOPS = "finops"
    PRODUCT_MANAGER_ANALYST = "product_manager_analyst"
    SQL_POWER_USER = "sql_power_user"
    CLOUD_GOVERNANCE_COMPLIANCE = "cloud_governance_compliance"
    BIZ_USER = "biz_user"

    # Backward-compatible values kept for existing clients/tests.
    CTO = "cto"
    DEVOPS_LEAD = "devops_lead"
    SECURITY_ENGINEER = "security_engineer"
    PLATFORM_ENGINEER = "platform_engineer"


class RouteType(str, Enum):
    TECHNICAL = "TECHNICAL"
    VALUE = "VALUE"
    BOTH = "BOTH"


class ConfidenceLevel(str, Enum):
    HIGH = "HIGH"
    MEDIUM = "MEDIUM"
    LOW = "LOW"


# --- Request Models ---


class QueryRequest(BaseModel):
    query: str
    persona: Persona | None = None
    include_talk_track: bool = True
    sec_filing_ticker: str | None = None
    company_context: str | None = None
    hypothesis_context: str | None = None


# --- Internal Models ---


class RouteDecision(BaseModel):
    route: RouteType
    technical_query: str | None = None
    value_query: str | None = None
    case_study_query: str | None = None
    sec_query: str | None = None
    persona_query: str | None = None
    include_case_studies: bool = False
    include_sec_filings: bool = False
    include_buyer_persona: bool = False
    reasoning: str = ""


class AgentResponse(BaseModel):
    answer: str = ""
    sources: list[str] = Field(default_factory=list)
    elapsed: float = 0.0
    error: str | None = None


class SourcesUsed(BaseModel):
    technical: list[str] = Field(default_factory=list)
    value: list[str] = Field(default_factory=list)
    case_studies: list[str] = Field(default_factory=list)
    sec_filings: list[str] = Field(default_factory=list)
    buyer_persona: list[str] = Field(default_factory=list)


class SynthesizedResponse(BaseModel):
    synthesized_answer: str
    technical_confidence: ConfidenceLevel
    value_confidence: ConfidenceLevel
    sources_used: SourcesUsed
    content_gaps: list[str] = Field(default_factory=list)
    discovery_questions: list[str] = Field(default_factory=list)
    talk_track_version: str = ""


class PipelineContext(BaseModel):
    """Full pipeline state shared across all stages and post-processors."""
    model_config = {"arbitrary_types_allowed": True}

    query: str
    persona: Persona | None = None
    route: RouteDecision | None = None
    agent_responses: dict[str, AgentResponse] = Field(default_factory=dict)
    synthesis: SynthesizedResponse | None = None
    stage_timings_ms: dict[str, int] = Field(default_factory=dict)
    extensions: dict[str, Any] = Field(default_factory=dict)
    hypothesis_context: str | None = None


# --- API Response Models ---


class QueryResponse(BaseModel):
    query: str
    persona: Persona | None = None
    route: RouteType
    routing_reasoning: str
    synthesized_answer: str
    talk_track: str | None = None
    technical_confidence: ConfidenceLevel
    value_confidence: ConfidenceLevel
    sources: SourcesUsed
    content_gaps: list[str] = Field(default_factory=list)
    discovery_questions: list[str] = Field(default_factory=list)
    stage_timings_ms: dict[str, int] = Field(default_factory=dict)
    processing_time_ms: int


class SaveReportRequest(BaseModel):
    response: QueryResponse
    title: str | None = None


class SavedReport(BaseModel):
    id: str
    saved_at: str
    title: str | None = None
    response: QueryResponse


class ReportSummary(BaseModel):
    id: str
    saved_at: str
    title: str | None = None
    query: str
    route: RouteType
    processing_time_ms: int


class GapEntry(BaseModel):
    timestamp: str
    query: str
    route: str
    gaps: list[str]


class AgentInventoryItem(BaseModel):
    agent: str
    url: str
    status: str
    total_chunks: int = 0
    unique_sources: int = 0
    categories: dict[str, int] = Field(default_factory=dict)
    companies: list[dict] = Field(default_factory=list)


class InventoryResponse(BaseModel):
    agents: list[AgentInventoryItem] = Field(default_factory=list)


class HealthStatus(BaseModel):
    status: str
    technical_agent: str
    value_agent: str
    sec_edgar_agent: str = ""
    buyer_persona_agent: str = ""
    company_research_agent: str = ""
    claude_api: str


# --- Hypothesis Models ---


class HypothesisRequest(BaseModel):
    company_name: str
    domain: str | None = None
    additional_context: str | None = None


class HypothesisResponse(BaseModel):
    id: str
    company_name: str
    domain: str = ""
    is_public: bool = False
    confidence_level: str = "low"
    hypothesis_markdown: str = ""
    data_sources: list[str] = Field(default_factory=list)
    research_summary: dict = Field(default_factory=dict)
    stage_timings_ms: dict[str, int] = Field(default_factory=dict)
    processing_time_ms: int = 0


class HypothesisSummary(BaseModel):
    id: str
    created_at: str
    company_name: str
    domain: str = ""
    is_public: bool = False
    confidence_level: str = "low"
    processing_time_ms: int = 0
