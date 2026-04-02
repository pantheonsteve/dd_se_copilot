"""Dual-path research router: public (SEC EDGAR + Sumble + BuiltWith) or private (Sumble + BuiltWith)."""

from __future__ import annotations

import asyncio
import logging

from builtwith_client import BuiltWithClient, BuiltWithResult
from config import settings
from edgar_client import EdgarClient
from models import (
    CompanyResearch,
    EdgarResearchData,
    SumbleEnrichResponse,
    SumbleJobsResponse,
    SumblePeopleResponse,
)
from research_merger import merge
from sumble_client import SumbleClient

logger = logging.getLogger(__name__)


async def research_company(
    company_name: str,
    domain: str | None,
    sumble: SumbleClient,
    edgar: EdgarClient,
) -> CompanyResearch:
    """Run the full research pipeline for a company.

    1. Check SEC EDGAR to determine public/private status.
    2. Fetch Sumble data (always, if domain is available).
    3. Fetch EDGAR intelligence (public companies only).
    4. Merge everything into a unified CompanyResearch.
    """

    # Step 1: public/private detection via lightweight CIK lookup.
    # Try the full name first, then fall back to stripped suffixes.
    edgar_results = await edgar.search_company(company_name)
    if not edgar_results:
        import re
        stripped = re.sub(
            r"\s*\b(Corporation|Corp\.?|Incorporated|Inc\.?|Company|Co\.?"
            r"|Ltd\.?|Limited|LLC|PLC|Group|Holdings?)\s*$",
            "", company_name, flags=re.IGNORECASE,
        ).strip()
        if stripped and stripped.lower() != company_name.lower():
            edgar_results = await edgar.search_company(stripped)
    is_public = len(edgar_results) > 0

    if is_public:
        top_match = edgar_results[0]
        logger.info(
            "Company '%s' identified as PUBLIC: %s (%s)",
            company_name, top_match.get("name"), top_match.get("ticker"),
        )
    else:
        logger.info("Company '%s' identified as PRIVATE (no SEC EDGAR match)", company_name)

    # Step 2: launch data fetches in parallel
    enrich_result: SumbleEnrichResponse | None = None
    jobs_result: SumbleJobsResponse | None = None
    people_result: SumblePeopleResponse | None = None
    edgar_result: EdgarResearchData | None = None
    builtwith_result: BuiltWithResult | None = None

    tasks: dict[str, asyncio.Task] = {}

    if domain:
        tasks["enrich"] = asyncio.ensure_future(sumble.enrich_organization(domain))
        tasks["jobs"] = asyncio.ensure_future(sumble.find_jobs(domain))
        tasks["people"] = asyncio.ensure_future(sumble.find_people(domain))

        if settings.builtwith_api_key:
            bw_client = BuiltWithClient(
                api_key=settings.builtwith_api_key,
                cache_dir=settings.builtwith_cache_dir,
            )
            tasks["builtwith"] = asyncio.ensure_future(bw_client.lookup(domain))

    if is_public:
        top = edgar_results[0]
        tasks["edgar"] = asyncio.ensure_future(
            edgar.fetch_intelligence(
                company_name=top.get("name", company_name),
                ticker=top["ticker"],
                cik=top.get("cik", ""),
            )
        )

    if tasks:
        await asyncio.gather(*tasks.values(), return_exceptions=True)

    for name, task in tasks.items():
        exc = task.exception()
        if exc is not None:
            logger.error("Research task '%s' failed: %s", name, exc)
            continue
        result = task.result()
        if name == "enrich":
            enrich_result = result
        elif name == "jobs":
            jobs_result = result
        elif name == "people":
            people_result = result
        elif name == "edgar":
            edgar_result = result
        elif name == "builtwith":
            builtwith_result = result

    # Step 3: merge into unified output
    return merge(
        company_name=company_name,
        domain=domain,
        is_public=is_public,
        enrich=enrich_result,
        jobs=jobs_result,
        people=people_result,
        edgar=edgar_result,
        builtwith=builtwith_result,
    )
