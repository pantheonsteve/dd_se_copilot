"""Pydantic models for the Personalized Release Notes Digest agent."""

from __future__ import annotations

from pydantic import BaseModel, Field


class ReleaseItem(BaseModel):
    """A single Datadog release note item parsed from the RSS feed."""

    title: str
    link: str = ""              # permalink from <guid> element
    published: str = ""
    summary: str = ""           # plain-text description stripped of HTML
    feed_links: list[dict] = [] # all <a href> links extracted from the CDATA description
                                # each entry: {"url": str, "text": str}


class RelevantRelease(BaseModel):
    """A release note that has been scored and annotated for a specific customer."""

    title: str
    link: str = ""              # changelog / release notes permalink from <guid>
    docs_link: str = ""         # best docs.datadoghq.com link (from feed or generated)
    feed_links: list[dict] = [] # all links extracted from the feed description
    published: str = ""
    relevance_score: int = 0    # 1-10: how relevant to this customer
    why_it_matters: str = ""    # customer-specific explanation
    talk_track: str = ""        # SE talking point (internal only)
    category: str = ""          # e.g. "APM", "Infrastructure", "Security", "Logs", etc.


class ReleaseDigestRequest(BaseModel):
    """Request to generate a personalized release notes digest for a customer."""

    company_name: str
    max_releases: int = 20  # how many releases to fetch from the RSS feed
    min_relevance_score: int = 6  # only include releases scoring at or above this threshold
    additional_context: str = ""  # any extra SE context about what to focus on

    # Optional: pull specific saved artifacts by ID for richer context
    hypothesis_id: str | None = None
    call_note_ids: list[str] = Field(default_factory=list)
    demo_plan_id: str | None = None


class ReleaseDigestResponse(BaseModel):
    """The full personalized release notes digest for a customer."""

    id: str = ""
    company_name: str

    # Newsletter content
    headline: str = ""  # e.g. "Your Datadog Update: 3 releases you need to see"
    intro_paragraph: str = ""  # personalised opening paragraph for the email/doc
    featured_releases: list[RelevantRelease] = Field(default_factory=list)  # top 3 must-reads
    other_relevant_releases: list[RelevantRelease] = Field(default_factory=list)  # everything else above threshold
    additional_releases: list[RelevantRelease] = Field(default_factory=list)  # all remaining releases below threshold
    closing_paragraph: str = ""  # personalised closing with next-step nudge

    # Meta
    total_releases_reviewed: int = 0
    releases_above_threshold: int = 0
    created_at: str = ""
    processing_time_ms: int = 0


class ReleaseDigestSummary(BaseModel):
    """Lightweight summary for listing saved digests."""

    id: str
    company_name: str
    created_at: str
    headline: str = ""
    featured_count: int = 0
    total_releases_reviewed: int = 0
    processing_time_ms: int = 0
