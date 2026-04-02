"""Merge SEC EDGAR, Sumble, and BuiltWith data into a unified CompanyResearch output."""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from builtwith_client import BuiltWithResult
from confidence_engine import ConfidenceEngine
from models import (
    CompanyResearch,
    EdgarResearchData,
    SumbleEnrichResponse,
    SumbleJobsResponse,
    SumblePeopleResponse,
)
from signal_extractor import (
    classify_tech_stack,
    extract_competitive_targets,
    extract_hiring_themes,
    extract_hiring_velocity,
    extract_relevant_roles,
    extract_tech_signals,
    recommend_entry_persona,
)

logger = logging.getLogger(__name__)


def merge(
    company_name: str,
    domain: str | None,
    is_public: bool,
    enrich: SumbleEnrichResponse | None,
    jobs: SumbleJobsResponse | None,
    people: SumblePeopleResponse | None,
    edgar: EdgarResearchData | None,
    builtwith: BuiltWithResult | None = None,
) -> CompanyResearch:
    """Combine all data sources into a single CompanyResearch object."""

    data_sources: list[str] = []

    # --- Domain resolution from Sumble ---
    if enrich and enrich.organization.name:
        data_sources.append("sumble_enrich")
        if not domain:
            domain = enrich.organization.domain

    # --- Technology landscape via ConfidenceEngine ---
    sumble_signals = extract_tech_signals(enrich, jobs, people)

    if builtwith and builtwith.technologies:
        data_sources.append("builtwith")

    engine = ConfidenceEngine()
    landscape = engine.classify(
        sumble_signals=sumble_signals,
        builtwith_result=builtwith,
    )
    landscape.domain = domain or ""

    flat_buckets = landscape.to_flat_buckets()

    competitive_targets = [
        t.canonical_name
        for t in landscape.competitive_targets
        if t.canonical_name.lower() != "datadog"
    ]

    # --- Hiring signals from Sumble jobs ---
    hiring_velocity = "unknown"
    hiring_themes: list[str] = []
    relevant_roles: list[dict] = []

    if jobs and jobs.jobs:
        data_sources.append("sumble_jobs")
        hiring_velocity = extract_hiring_velocity(jobs)
        hiring_themes = extract_hiring_themes(jobs)
        relevant_roles = extract_relevant_roles(jobs)

    # --- People / org structure from Sumble ---
    key_personas: list[dict] = []
    entry_persona: dict = {}

    if people:
        data_sources.append("sumble_people")
        key_personas = [
            {
                "name": p.name,
                "title": p.title,
                "seniority": p.seniority,
                "department": p.department,
            }
            for p in people.people[:15]
        ]
        entry_persona = recommend_entry_persona(people, is_public)
    else:
        entry_persona = recommend_entry_persona(
            SumblePeopleResponse(), is_public
        )

    # --- SEC EDGAR data for public companies ---
    strategic_priorities: list[str] = []
    risk_factors: list[str] = []
    technology_investments: list[str] = []

    if edgar and edgar.raw_answer:
        data_sources.append("sec_edgar")
        strategic_priorities = edgar.strategic_priorities
        risk_factors = edgar.risk_factors
        technology_investments = edgar.technology_investments

    # --- Confidence level ---
    if is_public and len(data_sources) >= 3:
        confidence = "high"
    elif len(data_sources) >= 2:
        confidence = "medium"
    else:
        confidence = "low"

    return CompanyResearch(
        company_name=company_name,
        domain=domain or "",
        is_public=is_public,
        strategic_priorities=strategic_priorities,
        risk_factors=risk_factors,
        technology_investments=technology_investments,
        current_observability_tools=flat_buckets["observability"],
        current_cloud_platforms=flat_buckets["cloud"],
        current_infrastructure=flat_buckets["infra"],
        current_security_tools=flat_buckets["security"],
        current_databases=flat_buckets["databases"],
        current_message_queues=flat_buckets["message_queues"],
        current_languages=flat_buckets["languages"],
        current_data_platforms=flat_buckets["data_platforms"],
        current_cicd_tools=flat_buckets["cicd"],
        current_feature_flags=flat_buckets["feature_flags"],
        current_serverless=flat_buckets["serverless"],
        current_networking=flat_buckets["networking"],
        technology_landscape=landscape.model_dump(mode="json"),
        hiring_velocity=hiring_velocity,
        key_hiring_themes=hiring_themes,
        relevant_open_roles=relevant_roles,
        key_personas=key_personas,
        recommended_entry_persona=entry_persona,
        competitive_displacement_targets=competitive_targets,
        data_sources=data_sources,
        research_timestamp=datetime.now(timezone.utc).isoformat(),
        confidence_level=confidence,
    )
