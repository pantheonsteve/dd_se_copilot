"""Programmatic Python API for the SE Copilot pipeline.

Allows downstream services (Tutor, Articulate backend, etc.) to call the
full pipeline without going through HTTP:

    from api import query
    ctx = await query("How does Datadog APM reduce MTTR?", persona="sre_devops_platform_ops")
"""

import time

from ddtrace.llmobs.decorators import workflow

from models import Persona, PipelineContext
from processors import run_all
from retriever import retrieve
from router import classify_query
from synthesizer import synthesize


@workflow(name="api_query")
async def query(
    text: str,
    persona: str | None = None,
    sec_filing_ticker: str | None = None,
) -> PipelineContext:
    """Run the full SE Copilot pipeline and return the enriched PipelineContext.

    Parameters
    ----------
    text:
        The natural-language query.
    persona:
        Optional persona key (e.g. "architect", "tech_executive"). Pass ``None`` to
        skip persona framing.
    sec_filing_ticker:
        Optional stock ticker to restrict SEC 10-K retrieval to a single
        company (e.g. "AAPL").

    Returns
    -------
    PipelineContext with route, agent_responses, synthesis, stage_timings_ms,
    and any extensions added by registered post-processors.
    """
    parsed_persona = Persona(persona) if persona else None
    ctx = PipelineContext(query=text, persona=parsed_persona)

    t0 = time.perf_counter()
    ctx.route = await classify_query(text, parsed_persona)
    if sec_filing_ticker:
        ctx.route.include_sec_filings = True
        if not ctx.route.sec_query:
            ctx.route.sec_query = (
                "What are the key strategic initiatives, technology investments, "
                "digital transformation priorities, operational challenges, and "
                "risk factors described in the annual report?"
            )
    ctx.stage_timings_ms["router"] = int((time.perf_counter() - t0) * 1000)

    t0 = time.perf_counter()
    ctx.agent_responses = await retrieve(
        ctx.route, persona=parsed_persona, sec_filing_ticker=sec_filing_ticker
    )
    ctx.stage_timings_ms["retrieval"] = int((time.perf_counter() - t0) * 1000)

    t0 = time.perf_counter()
    ctx.synthesis = await synthesize(ctx)
    ctx.stage_timings_ms["synthesis"] = int((time.perf_counter() - t0) * 1000)

    t0 = time.perf_counter()
    ctx = await run_all(ctx)
    ctx.stage_timings_ms["processors"] = int((time.perf_counter() - t0) * 1000)

    return ctx
