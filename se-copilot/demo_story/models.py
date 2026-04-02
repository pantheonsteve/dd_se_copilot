"""Pydantic models for the Demo Story Agent pipeline."""

from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field


class DemoMode(str, Enum):
    PRODUCT_EXPANSION = "product_expansion"
    DISCOVERY_DRIVEN = "discovery_driven"
    COMPETITIVE_DISPLACEMENT = "competitive_displacement"


class DemoPersona(str, Enum):
    VP_ENGINEERING = "vp_engineering"
    PLATFORM_ENGINEER = "platform_engineer"
    SRE_DEVOPS = "sre_devops"
    SECURITY_ENGINEER = "security_engineer"
    DEVELOPER = "developer"
    ENGINEERING_MANAGER = "engineering_manager"
    CTO_CIO = "cto_cio"


class DemoScenario(str, Enum):
    APM = "apm"
    LOG_MANAGEMENT = "log_management"
    INFRASTRUCTURE = "infrastructure"
    SECURITY = "security"
    DIGITAL_EXPERIENCE = "digital_experience"
    INCIDENT_MANAGEMENT = "incident_management"


# --- Request ---


class DemoFormInput(BaseModel):
    demo_mode: DemoMode
    persona: DemoPersona
    company_name: str

    is_public_company: bool = False
    selected_products: list[str] = Field(default_factory=list)
    customer_pain_points: str = ""
    discovery_notes: str = ""
    incumbent_tooling: str = ""
    evaluation_reason: str = ""
    demo_scenario: DemoScenario | None = None


class DemoFromReportInput(BaseModel):
    """Create a demo plan using a saved strategy report as primary context."""
    report_id: str
    persona: DemoPersona
    demo_mode: DemoMode = DemoMode.DISCOVERY_DRIVEN
    additional_context: str = ""
    selected_products: list[str] = Field(default_factory=list)
    incumbent_tooling: str = ""


# --- Orchestrator output ---


class AgentQuery(BaseModel):
    query: str
    purpose: str
    skip: bool = False


class PersonaContext(BaseModel):
    persona_key: str = ""
    default_pain_points: list[str] = Field(default_factory=list)
    customer_specific_pains: list[str] = Field(default_factory=list)
    combined_pain_priority: list[str] = Field(default_factory=list)


class ProductMapping(BaseModel):
    primary_products: list[str] = Field(default_factory=list)
    supporting_products: list[str] = Field(default_factory=list)
    mapping_rationale: str = ""


class MCPToolCall(BaseModel):
    """A single MCP tool invocation to run against the demo environment."""
    tool_name: str
    arguments: dict = Field(default_factory=dict)
    purpose: str = ""


class DemoContextPlan(BaseModel):
    persona_context: PersonaContext = Field(default_factory=PersonaContext)
    librarian_queries: list[AgentQuery] = Field(default_factory=list)
    value_queries: list[AgentQuery] = Field(default_factory=list)
    edgar_queries: list[AgentQuery] = Field(default_factory=list)
    product_mapping: ProductMapping = Field(default_factory=ProductMapping)
    narrative_angle: str = ""
    demo_scenario: DemoScenario | None = None
    mcp_queries: list[MCPToolCall] = Field(default_factory=list)


# --- API Response ---


class DemoSourcesUsed(BaseModel):
    librarian: list[str] = Field(default_factory=list)
    value: list[str] = Field(default_factory=list)
    sec_filings: list[str] = Field(default_factory=list)
    demo_environment: list[str] = Field(default_factory=list)


class DemoPlanResponse(BaseModel):
    demo_plan: str
    context_plan: DemoContextPlan | None = None
    sources_used: DemoSourcesUsed = Field(default_factory=DemoSourcesUsed)
    stage_timings_ms: dict[str, int] = Field(default_factory=dict)
    processing_time_ms: int = 0
    plan_id: str = ""
    pdf_path: str = ""


class DemoPlanSummary(BaseModel):
    id: str
    created_at: str
    company_name: str
    persona: str
    demo_mode: str
    title: str
    processing_time_ms: int = 0
    has_pdf: bool = False
    has_slides: bool = False
