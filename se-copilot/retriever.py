"""Agent communication layer for querying RAG agents."""

import asyncio
import logging

import httpx

from ddtrace.llmobs import LLMObs
from ddtrace.llmobs.decorators import retrieval, workflow

from config import settings
from models import AgentResponse, Persona, RouteDecision, RouteType

logger = logging.getLogger(__name__)


@retrieval(name="query_agent")
async def query_agent(url: str, question: str, timeout: float | None = None,
                      ticker: str | None = None,
                      persona: Persona | None = None) -> AgentResponse:
    """Send a query to a single RAG agent and return its response."""
    timeout = timeout or settings.agent_timeout_seconds

    try:
        payload: dict = {"question": question, "llm": "claude"}
        if ticker:
            payload["ticker"] = ticker
        if persona:
            payload["persona"] = persona.value

        LLMObs.annotate(
            input_data=question,
            metadata={"agent_url": url, "ticker": ticker or "", "persona": persona.value if persona else ""},
        )

        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(url, json=payload)
            resp.raise_for_status()
            data = resp.json()

            if "error" in data:
                LLMObs.annotate(output_data=[{"text": data["error"], "name": "error"}])
                return AgentResponse(error=data["error"])

            result = AgentResponse(
                answer=data.get("answer", ""),
                sources=data.get("sources", []),
                elapsed=data.get("elapsed", 0.0),
            )
            LLMObs.annotate(output_data=[
                {"text": result.answer, "name": src, "score": 1.0}
                for src in result.sources
            ] if result.sources else [{"text": result.answer, "name": "response"}])
            return result

    except httpx.TimeoutException:
        logger.error("Agent at %s timed out after %ss", url, timeout)
        return AgentResponse(error=f"Agent timed out after {timeout}s")
    except httpx.HTTPStatusError as exc:
        logger.error("Agent at %s returned HTTP %s", url, exc.response.status_code)
        return AgentResponse(error=f"Agent returned HTTP {exc.response.status_code}")
    except httpx.ConnectError:
        logger.error("Cannot connect to agent at %s", url)
        return AgentResponse(error=f"Cannot connect to agent at {url}")
    except Exception as exc:
        logger.error("Unexpected error querying agent at %s: %s", url, exc)
        return AgentResponse(error=str(exc))


@workflow(name="retrieve")
async def retrieve(
    route: RouteDecision,
    persona: Persona | None = None,
    sec_filing_ticker: str | None = None,
) -> dict[str, AgentResponse]:
    """Retrieve answers from agents based on the routing decision.

    Returns a dict keyed by agent name ("technical", "value", "case_studies").
    Only agents that were actually queried will be present.
    """
    tasks: dict[str, asyncio.Task[AgentResponse]] = {}

    if route.route in (RouteType.TECHNICAL, RouteType.BOTH):
        tasks["technical"] = asyncio.ensure_future(
            query_agent(settings.technical_agent_url, route.technical_query or "", persona=persona)
        )

    if route.route in (RouteType.VALUE, RouteType.BOTH):
        tasks["value"] = asyncio.ensure_future(
            query_agent(settings.value_agent_url, route.value_query or "", persona=persona)
        )

    if route.include_case_studies and settings.case_studies_agent_url:
        query_text = route.case_study_query or route.value_query or route.technical_query or ""
        tasks["case_studies"] = asyncio.ensure_future(
            query_agent(settings.case_studies_agent_url, query_text, persona=persona)
        )

    if route.include_sec_filings and settings.sec_edgar_agent_url:
        query_text = route.sec_query or route.value_query or route.technical_query or ""
        tasks["sec_filings"] = asyncio.ensure_future(
            query_agent(
                settings.sec_edgar_agent_url,
                query_text,
                ticker=sec_filing_ticker,
                persona=persona,
            )
        )

    if route.include_buyer_persona and settings.buyer_persona_agent_url:
        query_text = route.persona_query or route.value_query or route.technical_query or ""
        tasks["buyer_persona"] = asyncio.ensure_future(
            query_agent(settings.buyer_persona_agent_url, query_text, persona=persona)
        )

    if not tasks:
        return {}

    await asyncio.gather(*tasks.values(), return_exceptions=True)

    results: dict[str, AgentResponse] = {}
    for name, task in tasks.items():
        exc = task.exception()
        if exc is not None:
            logger.error("Agent '%s' raised: %s", name, exc)
            results[name] = AgentResponse(error=str(exc))
        else:
            results[name] = task.result()

    return results
