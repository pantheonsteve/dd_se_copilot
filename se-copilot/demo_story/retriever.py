"""Retrieve context from downstream RAG agents and the demo environment via MCP."""

import asyncio
import logging

from ddtrace.llmobs.decorators import workflow

from config import settings
from models import AgentResponse
from retriever import query_agent

from .environment_agent import query_demo_environment
from .models import DemoContextPlan

logger = logging.getLogger(__name__)


@workflow(name="retrieve_demo_context")
async def retrieve_demo_context(
    context_plan: DemoContextPlan,
    is_public_company: bool,
    sec_ticker: str | None = None,
) -> dict[str, list[AgentResponse]]:
    """Execute all agent queries from the context plan in parallel.

    Returns a dict keyed by agent type ("librarian", "value", "sec_filings",
    "demo_environment") where each value is a list of AgentResponse objects.
    """
    tasks: list[tuple[str, int, asyncio.Task[AgentResponse]]] = []

    for i, q in enumerate(context_plan.librarian_queries):
        task = asyncio.ensure_future(
            query_agent(settings.technical_agent_url, q.query)
        )
        tasks.append(("librarian", i, task))

    for i, q in enumerate(context_plan.value_queries):
        task = asyncio.ensure_future(
            query_agent(settings.value_agent_url, q.query)
        )
        tasks.append(("value", i, task))

    if is_public_company and settings.sec_edgar_agent_url:
        for i, q in enumerate(context_plan.edgar_queries):
            if q.skip:
                continue
            task = asyncio.ensure_future(
                query_agent(
                    settings.sec_edgar_agent_url,
                    q.query,
                    ticker=sec_ticker,
                )
            )
            tasks.append(("sec_filings", i, task))

    if settings.datadog_api_key and settings.datadog_app_key:
        task = asyncio.ensure_future(
            query_demo_environment(
                context_plan.demo_scenario,
                context_plan.mcp_queries or None,
            )
        )
        tasks.append(("demo_environment", 0, task))

    if not tasks:
        return {}

    await asyncio.gather(
        *(t for _, _, t in tasks), return_exceptions=True
    )

    results: dict[str, list[AgentResponse]] = {
        "librarian": [],
        "value": [],
        "sec_filings": [],
        "demo_environment": [],
    }

    for agent_type, _idx, task in tasks:
        exc = task.exception()
        if exc is not None:
            logger.error("Demo retriever — agent '%s' raised: %s", agent_type, exc)
            results[agent_type].append(AgentResponse(error=str(exc)))
        else:
            results[agent_type].append(task.result())

    return results
