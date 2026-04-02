"""SE Copilot Router — FastAPI service that routes queries to RAG agents and synthesizes responses."""

import asyncio
import json
import logging
import os
import time
from pathlib import Path

import httpx
import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pythonjsonlogger.json import JsonFormatter

load_dotenv()

from ddtrace.llmobs import LLMObs
from ddtrace.llmobs.decorators import workflow, task

LLMObs.enable(
    ml_app=os.getenv("DATADOG_APP_NAME", "se-copilot"),
    api_key=os.getenv("DATADOG_API_KEY"),
    site=os.getenv("DATADOG_SITE", "datadoghq.com"),
    agentless_enabled=True,
)

from config import settings
from gap_logger import aggregate_gaps, log_gaps
from pydantic import BaseModel as _BaseModel

from models import (
    AgentInventoryItem,
    AgentResponse,
    HealthStatus,
    HypothesisRequest,
    HypothesisResponse,
    HypothesisSummary,
    InventoryResponse,
    PipelineContext,
    QueryRequest,
    QueryResponse,
    SaveReportRequest,
    SavedReport,
)
from processors import run_all
from report_store import delete_report, get_report, list_reports, save_report
from retriever import query_agent, retrieve
from router import classify_query
from synthesizer import synthesize
from hypothesis_synth import synthesize_hypothesis
from call_note_synth import summarize_call_transcript
from call_note_store import (
    delete_call_note,
    get_call_note,
    list_call_notes,
    save_call_note,
)
from call_note_export import export_call_note_markdown, generate_call_note_pdf_async
from hypothesis_store import (
    delete_hypothesis,
    find_hypothesis_by_company,
    get_hypothesis,
    list_hypotheses,
    save_hypothesis,
)
from expansion_models import (
    ExistingFootprint,
    ExpansionPlaybook,
    ExpansionRequest,
    ExpansionResponse,
    ExpansionSummary,
)
from expansion_synth import synthesize_expansion_playbook
from expansion_store import (
    delete_expansion_playbook,
    find_playbook_by_company,
    get_expansion_playbook,
    list_expansion_playbooks,
    save_expansion_playbook,
)
from next_steps_models import NextStepsRequest, NextStepsResponse, NextStepsSummary
from next_steps_store import (
    delete_next_steps,
    find_next_steps_by_company,
    get_next_steps,
    list_next_steps,
    save_next_steps,
)
from next_steps_synth import synthesize_next_steps
from precall_models import PreCallBriefRequest, PreCallBrief, CallType
from precall_synth import synthesize_precall_brief
from precall_store import (
    delete_precall_brief,
    find_briefs_by_company,
    get_precall_brief,
    list_precall_briefs,
    save_precall_brief,
)
from precall_export import generate_precall_pdf_async, generate_precall_pdf
from debrief_synth import synthesize_debrief
from slack_store import (
    delete_slack_summary,
    get_slack_summary,
    list_slack_summaries_for_company,
    save_slack_summary,
    update_slack_summary,
)
from snapshot_synth import synthesize_snapshot
from snapshot_store import save_snapshot, get_latest_snapshot
from company_chat import chat_turn as company_chat_turn
from company_chat_store import (
    delete_conversation as delete_company_conversation,
    get_conversation as get_company_conversation,
    list_conversations as list_company_conversations,
)
from release_digest_models import ReleaseDigestRequest, ReleaseDigestResponse, ReleaseDigestSummary
from release_digest_synth import synthesize_release_digest
from release_digest_store import (
    delete_digest,
    find_digests_by_company,
    get_digest,
    list_digests,
    save_digest,
)
from release_digest_export import generate_digest_pdf_async
from librarian_product_query import (
    query_librarian_product_list,
    query_librarian_product_validation,
)

from company_store import (
    create_company as create_company_record,
    create_note as create_company_note,
    delete_company as delete_company_record,
    delete_note as delete_company_note,
    get_all_linked_resource_ids,
    get_company as get_company_record,
    link_resource as link_company_resource,
    list_companies as list_defined_companies,
    list_notes as list_company_notes,
    list_resources as list_company_resources,
    unlink_resource as unlink_company_resource,
    update_company as update_company_record,
    update_note_date as update_company_note_date,
)
from demo_story.data import PERSONA_DEFAULTS
from demo_story.models import DemoFormInput, DemoFromReportInput, DemoPlanResponse, DemoPlanSummary
from demo_story.pipeline import generate_demo_plan, generate_demo_plan_from_report
from demo_story.slide_generator import generate_slide_deck
from demo_story.store import (
    delete_demo_plan,
    get_demo_plan,
    get_loops,
    get_slides,
    list_demo_plans,
    reparse_loops,
    save_slides,
    update_loop,
)

_handler = logging.StreamHandler()
_handler.setFormatter(JsonFormatter(
    fmt="%(asctime)s %(levelname)s %(name)s %(message)s",
    rename_fields={"asctime": "timestamp", "levelname": "level"},
))
logging.root.handlers = [_handler]
logging.root.setLevel(getattr(logging, settings.log_level.upper(), logging.INFO))

logger = logging.getLogger(__name__)

app = FastAPI(title="SE Copilot Router")

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"(chrome-extension://.*|http://localhost(:\d+)?)",
    allow_methods=["*"],
    allow_headers=["*"],
)


async def _timed(coro):
    """Await a coroutine and return (result, elapsed_ms)."""
    t0 = time.perf_counter()
    result = await coro
    ms = int((time.perf_counter() - t0) * 1000)
    return result, ms


@task(name="build_response")
def build_response(ctx: PipelineContext, req: QueryRequest, total_ms: int) -> QueryResponse:
    """Map a completed PipelineContext to the flat API response model."""
    synth = ctx.synthesis
    assert synth is not None
    assert ctx.route is not None

    return QueryResponse(
        query=req.query,
        persona=req.persona,
        route=ctx.route.route,
        routing_reasoning=ctx.route.reasoning,
        synthesized_answer=synth.synthesized_answer,
        talk_track=synth.talk_track_version if req.include_talk_track else None,
        technical_confidence=synth.technical_confidence,
        value_confidence=synth.value_confidence,
        sources=synth.sources_used,
        content_gaps=synth.content_gaps,
        discovery_questions=synth.discovery_questions,
        stage_timings_ms=ctx.stage_timings_ms,
        processing_time_ms=total_ms,
    )

def _format_hypothesis_context(rs: dict) -> str:
    """Build a plain-text context block from a hypothesis research_summary."""
    parts: list[str] = []

    # Include confidence summary if technology landscape is available
    landscape = rs.get("technology_landscape", {})
    summary = landscape.get("confidence_summary", {})
    if summary:
        parts.append(
            f"Tech Confidence: {summary.get('confirmed', 0)} confirmed, "
            f"{summary.get('likely', 0)} likely, "
            f"{summary.get('unverified', 0)} unverified "
            f"({summary.get('total', 0)} total)"
        )
        sources = summary.get("sources_used", [])
        if sources:
            parts.append(f"Tech Data Sources: {', '.join(sources)}")

    _fields = [
        ("current_observability_tools", "Current Observability Tools"),
        ("current_cloud_platforms", "Cloud Platforms"),
        ("current_infrastructure", "Infrastructure"),
        ("current_databases", "Databases"),
        ("current_message_queues", "Message Queues / Streaming"),
        ("current_languages", "Languages / Frameworks"),
        ("current_data_platforms", "Data Platforms"),
        ("current_cicd_tools", "CI/CD Tools"),
        ("current_feature_flags", "Feature Flags"),
        ("current_serverless", "Serverless"),
        ("current_networking", "Networking / CDN"),
        ("competitive_displacement_targets", "Competitive Displacement Targets"),
        ("key_hiring_themes", "Key Hiring Themes"),
    ]
    for key, label in _fields:
        if rs.get(key):
            parts.append(f"{label}: {', '.join(rs[key])}")
    if rs.get("hiring_velocity"):
        parts.append(f"Hiring Velocity: {rs['hiring_velocity']}")
    entry = rs.get("recommended_entry_persona", {})
    if entry.get("title"):
        parts.append(f"Recommended Entry Persona: {entry['title']}")
        if entry.get("rationale"):
            parts.append(f"  Rationale: {entry['rationale']}")
    if rs.get("relevant_open_roles"):
        roles = rs["relevant_open_roles"][:5]
        role_strs = [f"{r.get('title', 'N/A')} ({r.get('department', '')})" for r in roles]
        parts.append(f"Key Open Roles: {'; '.join(role_strs)}")
    return "\n".join(parts)


@workflow(name="handle_query")
@app.post("/api/query")
async def handle_query(req: QueryRequest) -> QueryResponse:
    start = time.perf_counter()

    ctx = PipelineContext(query=req.query, persona=req.persona)

    ctx.route, route_ms = await _timed(classify_query(req.query, req.persona))
    ctx.stage_timings_ms["router"] = route_ms

    if req.sec_filing_ticker:
        ctx.route.include_sec_filings = True
        if not ctx.route.sec_query:
            ctx.route.sec_query = (
                "What are the key strategic initiatives, technology investments, "
                "digital transformation priorities, operational challenges, and "
                "risk factors described in the annual report?"
            )

    logger.info("Routed query", extra={
        "query": req.query[:80], "route": ctx.route.route.value,
        "reasoning": ctx.route.reasoning, "elapsed_ms": route_ms,
    })

    ctx.agent_responses, retrieve_ms = await _timed(
        retrieve(ctx.route, persona=req.persona, sec_filing_ticker=req.sec_filing_ticker)
    )
    ctx.stage_timings_ms["retrieval"] = retrieve_ms
    logger.info("Retrieved agent responses", extra={"elapsed_ms": retrieve_ms})

    if req.company_context and not req.sec_filing_ticker:
        ctx.agent_responses["sec_filings"] = AgentResponse(
            answer=req.company_context,
            sources=["User-provided company context"],
        )

    # Inject hypothesis intelligence (tech stack, competitive, hiring) if provided
    if req.hypothesis_context:
        ctx.hypothesis_context = req.hypothesis_context

    ctx.synthesis, synth_ms = await _timed(synthesize(ctx))
    ctx.stage_timings_ms["synthesis"] = synth_ms
    logger.info("Synthesized response", extra={"elapsed_ms": synth_ms})

    ctx, proc_ms = await _timed(run_all(ctx))
    ctx.stage_timings_ms["processors"] = proc_ms

    if ctx.synthesis and ctx.synthesis.content_gaps:
        log_gaps(ctx.synthesis.content_gaps, req.query, ctx.route.route.value)

    elapsed_ms = int((time.perf_counter() - start) * 1000)

    return build_response(ctx, req, elapsed_ms)

@task(name="get_gaps")
@app.get("/api/gaps")
async def get_gaps():
    return aggregate_gaps()

@task(name="create_report")
@app.post("/api/reports")
async def create_report(req: SaveReportRequest) -> SavedReport:
    return save_report(req.response, title=req.title)

@task(name="get_reports")
@app.get("/api/reports")
async def get_reports():
    return list_reports()

@task(name="get_report_by_id")
@app.get("/api/reports/{report_id}")
async def get_report_by_id(report_id: str):
    report = get_report(report_id)
    if report is None:
        return {"error": "Report not found"}
    return report

@task(name="delete_report_by_id")
@app.delete("/api/reports/{report_id}")
async def delete_report_by_id(report_id: str):
    deleted = delete_report(report_id)
    return {"deleted": deleted}

@task(name="inventory")
@app.get("/api/inventory")
async def inventory() -> InventoryResponse:
    # RAG agents (have /api/stats)
    rag_agents = [
        ("librarian", settings.technical_agent_url),
        ("value", settings.value_agent_url),
    ]
    if settings.case_studies_agent_url:
        rag_agents.append(("case_studies", settings.case_studies_agent_url))
    if settings.sec_edgar_agent_url:
        rag_agents.append(("sec_edgar", settings.sec_edgar_agent_url))
    if settings.buyer_persona_agent_url:
        rag_agents.append(("buyer_persona", settings.buyer_persona_agent_url))

    # Standalone agents (have /api/health instead of /api/stats)
    standalone_agents: list[tuple[str, str]] = []
    if settings.company_research_agent_url:
        standalone_agents.append(("company_research", settings.company_research_agent_url))
    if settings.slide_agent_url:
        standalone_agents.append(("slides", settings.slide_agent_url))

    items: list[AgentInventoryItem] = []

    async with httpx.AsyncClient(timeout=10) as client:
        for name, query_url in rag_agents:
            base_url = query_url.replace("/api/query", "")
            stats_url = f"{base_url}/api/stats"
            item = AgentInventoryItem(agent=name, url=base_url, status="unknown")

            try:
                resp = await client.get(stats_url)
                resp.raise_for_status()
                data = resp.json()
                item.status = "ok"
                item.total_chunks = data.get("total_chunks", 0)
                item.unique_sources = data.get("unique_sources", 0)
                item.categories = data.get("categories", {})
            except Exception as exc:
                item.status = f"error: {exc}"

            if name == "sec_edgar" and item.status == "ok":
                try:
                    companies_url = f"{base_url}/api/edgar/companies"
                    resp = await client.get(companies_url)
                    resp.raise_for_status()
                    item.companies = resp.json().get("companies", [])
                except Exception:
                    pass

            items.append(item)

        for name, agent_url in standalone_agents:
            base_url = agent_url.rsplit("/api/", 1)[0]
            health_url = f"{base_url}/api/health"
            item = AgentInventoryItem(agent=name, url=base_url, status="unknown")

            try:
                resp = await client.get(health_url)
                resp.raise_for_status()
                item.status = "ok"
            except Exception as exc:
                item.status = f"error: {exc}"

            items.append(item)

    return InventoryResponse(agents=items)

@task(name="health_check")
@app.get("/api/health")
async def health_check() -> HealthStatus:
    tech_status = "unknown"
    value_status = "unknown"
    sec_edgar_status = ""
    buyer_persona_status = ""
    company_research_status = ""
    claude_status = "ok" if settings.anthropic_api_key else "missing_api_key"

    async with httpx.AsyncClient(timeout=5) as client:
        try:
            tech_url = settings.technical_agent_url.replace("/api/query", "/api/stats")
            resp = await client.get(tech_url)
            resp.raise_for_status()
            tech_status = "ok"
        except Exception as exc:
            tech_status = f"error: {exc}"

        try:
            value_url = settings.value_agent_url.replace("/api/query", "/api/stats")
            resp = await client.get(value_url)
            resp.raise_for_status()
            value_status = "ok"
        except Exception as exc:
            value_status = f"error: {exc}"

        if settings.sec_edgar_agent_url:
            try:
                sec_url = settings.sec_edgar_agent_url.replace("/api/query", "/api/stats")
                resp = await client.get(sec_url)
                resp.raise_for_status()
                sec_edgar_status = "ok"
            except Exception as exc:
                sec_edgar_status = f"error: {exc}"
        if settings.buyer_persona_agent_url:
            try:
                persona_url = settings.buyer_persona_agent_url.replace("/api/query", "/api/stats")
                resp = await client.get(persona_url)
                resp.raise_for_status()
                buyer_persona_status = "ok"
            except Exception as exc:
                buyer_persona_status = f"error: {exc}"
        if settings.company_research_agent_url:
            try:
                research_url = settings.company_research_agent_url.replace("/api/research", "/api/health")
                resp = await client.get(research_url)
                resp.raise_for_status()
                company_research_status = "ok"
            except Exception as exc:
                company_research_status = f"error: {exc}"

    required_statuses = [tech_status, value_status, claude_status]
    if settings.buyer_persona_agent_url:
        required_statuses.append(buyer_persona_status)
    overall = "healthy" if all(s == "ok" for s in required_statuses) else "degraded"

    return HealthStatus(
        status=overall,
        technical_agent=tech_status,
        value_agent=value_status,
        sec_edgar_agent=sec_edgar_status,
        buyer_persona_agent=buyer_persona_status,
        company_research_agent=company_research_status,
        claude_api=claude_status,
    )


# ---------------------------------------------------------------------------
# SEC EDGAR proxy — proxies search/ingest to the SEC EDGAR agent
# ---------------------------------------------------------------------------


class _EdgarIngestRequest(_BaseModel):
    ticker: str
    cik: str = ""
    company_name: str = ""

@task(name="edgar_search")
@app.get("/api/edgar/search")
async def edgar_search(q: str = ""):
    if not settings.sec_edgar_agent_url:
        return {"results": [], "error": "SEC EDGAR agent not configured"}
    base_url = settings.sec_edgar_agent_url.replace("/api/query", "")
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(f"{base_url}/api/edgar/search", params={"q": q})
        resp.raise_for_status()
        return resp.json()

@task(name="edgar_ingest")
@app.post("/api/edgar/ingest")
async def edgar_ingest(req: _EdgarIngestRequest):
    if not settings.sec_edgar_agent_url:
        return {"error": "SEC EDGAR agent not configured"}
    base_url = settings.sec_edgar_agent_url.replace("/api/query", "")
    async with httpx.AsyncClient(timeout=300) as client:
        resp = await client.post(
            f"{base_url}/api/edgar/ingest",
            json={"ticker": req.ticker, "cik": req.cik, "company_name": req.company_name},
        )
        resp.raise_for_status()
        return resp.json()


# ---------------------------------------------------------------------------
# Demo Story Agent endpoints
# ---------------------------------------------------------------------------

@workflow(name="handle_demo_plan")
@app.post("/api/demo-plan")
async def handle_demo_plan(req: DemoFormInput) -> DemoPlanResponse:
    return await generate_demo_plan(req)

@workflow(name="handle_demo_plan_from_report")
@app.post("/api/demo-plan/from-report")
async def handle_demo_plan_from_report(req: DemoFromReportInput) -> DemoPlanResponse:
    try:
        return await generate_demo_plan_from_report(req)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))

@task(name="demo_personas")
@app.get("/api/demo-plan/personas")
async def demo_personas():
    return {
        key: {"title": val["title"], "default_pains": val["default_pains"], "kpis": val["kpis"]}
        for key, val in PERSONA_DEFAULTS.items()
    }

@task(name="get_demo_plans")
@app.get("/api/demo-plans")
async def get_demo_plans() -> list[DemoPlanSummary]:
    return list_demo_plans()

@task(name="get_demo_plan_by_id")
@app.get("/api/demo-plans/{plan_id}")
async def get_demo_plan_by_id(plan_id: str):
    plan = get_demo_plan(plan_id)
    if plan is None:
        return {"error": "Plan not found"}
    return plan

@task(name="get_demo_plan_pdf")
@app.get("/api/demo-plans/{plan_id}/pdf")
async def get_demo_plan_pdf(plan_id: str):
    plan = get_demo_plan(plan_id)
    if plan is None:
        return {"error": "Plan not found"}
    pdf_path = plan.get("pdf_path", "")
    if not pdf_path or not Path(pdf_path).exists():
        return {"error": "PDF not available"}
    return FileResponse(
        pdf_path,
        media_type="application/pdf",
        filename=f"demo_plan_{plan_id}.pdf",
    )

@workflow(name="generate_slides_for_plan")
@app.post("/api/demo-plans/{plan_id}/slides")
async def generate_slides_for_plan(plan_id: str):
    plan = get_demo_plan(plan_id)
    if plan is None:
        return {"error": "Plan not found"}
    markdown = plan.get("markdown", "")
    if not markdown:
        return {"error": "Plan has no markdown content"}

    start = time.perf_counter()
    try:
        slide_deck = await generate_slide_deck(markdown)
    except Exception as exc:
        logger.exception("Slide generation failed for plan %s", plan_id)
        return {"error": str(exc)}
    elapsed_ms = int((time.perf_counter() - start) * 1000)

    result = {
        "slide_deck": slide_deck,
        "processing_time_ms": elapsed_ms,
    }
    save_slides(plan_id, json.dumps(result))
    logger.info("Generated and saved slides for plan %s in %d ms", plan_id, elapsed_ms)
    return result

@task(name="get_slides_for_plan")
@app.get("/api/demo-plans/{plan_id}/slides")
async def get_slides_for_plan(plan_id: str):
    raw = get_slides(plan_id)
    if not raw:
        return {"error": "No slides found for this plan"}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {"error": "Stored slides data is corrupt"}

@task(name="get_demo_plan_loops")
@app.get("/api/demo-plans/{plan_id}/loops")
async def get_demo_plan_loops(plan_id: str):
    loops = get_loops(plan_id)
    if not loops:
        plan = get_demo_plan(plan_id)
        if plan is None:
            return {"error": "Plan not found"}
    return loops

@task(name="update_demo_plan_loop")
@app.patch("/api/demo-plans/{plan_id}/loops/{loop_id}")
async def update_demo_plan_loop(plan_id: str, loop_id: int, body: dict):
    updated = update_loop(plan_id, loop_id, body)
    if updated is None:
        return {"error": "Loop not found or no valid fields provided"}
    return updated

@task(name="reparse_demo_plan_loops")
@app.post("/api/demo-plans/{plan_id}/reparse")
async def reparse_demo_plan_loops(plan_id: str):
    count = reparse_loops(plan_id)
    return {"plan_id": plan_id, "loops_parsed": count}

@task(name="delete_demo_plan_by_id")
@app.delete("/api/demo-plans/{plan_id}")
async def delete_demo_plan_by_id(plan_id: str):
    deleted = delete_demo_plan(plan_id)
    return {"deleted": deleted}


# ---------------------------------------------------------------------------
# Sales Hypothesis endpoints
# ---------------------------------------------------------------------------


@workflow(name="handle_hypothesis")
@app.post("/api/hypothesis")
async def handle_hypothesis(req: HypothesisRequest) -> HypothesisResponse:
    start = time.perf_counter()
    stage_timings: dict[str, int] = {}

    # Step 1: Call Company Research Agent
    research_data: dict = {}
    if settings.company_research_agent_url:
        t0 = time.perf_counter()
        try:
            async with httpx.AsyncClient(timeout=120) as client:
                resp = await client.post(
                    settings.company_research_agent_url,
                    json={
                        "company_name": req.company_name,
                        "domain": req.domain,
                    },
                )
                resp.raise_for_status()
                data = resp.json()
                research_data = data.get("research", {})
        except Exception as exc:
            logger.error("Company Research Agent failed: %s", exc)
            research_data = {
                "company_name": req.company_name,
                "domain": req.domain or "",
                "is_public": False,
                "confidence_level": "low",
                "data_sources": [],
            }
        stage_timings["research"] = int((time.perf_counter() - t0) * 1000)
    else:
        research_data = {
            "company_name": req.company_name,
            "domain": req.domain or "",
            "is_public": False,
            "confidence_level": "low",
            "data_sources": [],
        }

    # Step 2: Dispatch to agents in parallel using research context
    t0 = time.perf_counter()
    agent_tasks: dict[str, asyncio.Task[AgentResponse]] = {}

    entry_persona = research_data.get("recommended_entry_persona", {})
    persona_title = entry_persona.get("title", "VP of Engineering")
    strategic = research_data.get("strategic_priorities", [])
    competitive = research_data.get("competitive_displacement_targets", [])
    tech_investments = research_data.get("technology_investments", [])
    current_stack = (
        research_data.get("current_observability_tools", [])
        + research_data.get("current_cloud_platforms", [])
        + research_data.get("current_infrastructure", [])
    )

    if settings.buyer_persona_agent_url:
        persona_query = (
            f"What are the key goals, KPIs, decision criteria, objections, "
            f"and discovery tactics for a {persona_title}? "
            f"The company is focused on: {', '.join(strategic[:3]) if strategic else 'general cloud operations'}."
        )
        agent_tasks["buyer_persona"] = asyncio.ensure_future(
            query_agent(settings.buyer_persona_agent_url, persona_query)
        )

    if settings.value_agent_url:
        value_topics = strategic[:3] + competitive[:2]
        value_query = (
            f"What customer stories, business outcomes, and ROI evidence do we have "
            f"related to: {', '.join(value_topics) if value_topics else 'observability platform consolidation'}? "
            f"Focus on competitive displacement and business value."
        )
        agent_tasks["value"] = asyncio.ensure_future(
            query_agent(settings.value_agent_url, value_query)
        )

    if settings.case_studies_agent_url:
        industry = research_data.get("industry", "")
        case_query = (
            f"Find case studies for companies in {industry or 'technology'} industry "
            f"that involve {', '.join(competitive[:2]) if competitive else 'observability'} "
            f"consolidation or platform modernization. Include outcome metrics."
        )
        agent_tasks["case_studies"] = asyncio.ensure_future(
            query_agent(settings.case_studies_agent_url, case_query)
        )

    if settings.technical_agent_url:
        tech_query = (
            f"What Datadog capabilities map to these technologies and investments: "
            f"{', '.join(tech_investments[:3] + current_stack[:3]) if (tech_investments or current_stack) else 'cloud monitoring, APM, log management'}? "
            f"Include specific product features and integration details."
        )
        agent_tasks["technical"] = asyncio.ensure_future(
            query_agent(settings.technical_agent_url, tech_query)
        )

    if agent_tasks:
        await asyncio.gather(*agent_tasks.values(), return_exceptions=True)

    agent_responses: dict[str, AgentResponse] = {}
    for name, atask in agent_tasks.items():
        exc = atask.exception()
        if exc is not None:
            logger.error("Hypothesis agent '%s' raised: %s", name, exc)
            agent_responses[name] = AgentResponse(error=str(exc))
        else:
            agent_responses[name] = atask.result()

    stage_timings["agents"] = int((time.perf_counter() - t0) * 1000)

    # Augment data_sources with successfully queried agents
    _agent_display = {
        "buyer_persona": "buyer_persona",
        "value": "value_library",
        "case_studies": "case_studies",
        "technical": "technical_library",
    }
    existing_sources: list[str] = research_data.get("data_sources", [])
    for agent_name, ar in agent_responses.items():
        label = _agent_display.get(agent_name, agent_name)
        if ar.answer and not ar.error and label not in existing_sources:
            existing_sources.append(label)
    research_data["data_sources"] = existing_sources

    # Step 3: Assemble existing company artifacts (if a matching defined company exists)
    t0 = time.perf_counter()
    existing_artifacts: dict | None = None
    company_norm = _normalize_company_name(req.company_name).lower()
    for dc in list_defined_companies():
        if _normalize_company_name(dc["name"]).lower() == company_norm:
            # Found a matching defined company — pull all its artifacts
            all_notes = list_call_notes()
            company_call_notes = [
                get_call_note(n["id"])
                for n in all_notes
                if (
                    n.get("company_name", "").lower() == req.company_name.lower()
                    or _normalize_company_name(n.get("company_name", "")).lower() == company_norm
                ) and n.get("id")
            ]
            company_call_notes = [n for n in company_call_notes if n]

            demo_summaries = [
                p for p in list_demo_plans()
                if _normalize_company_name(p.company_name).lower() == company_norm
                or p.company_name.lower() == req.company_name.lower()
            ]
            demo_plans_full = []
            for p in demo_summaries[:3]:
                plan = get_demo_plan(p.id)
                if plan:
                    demo_plans_full.append(plan)

            exp_summaries = [
                e for e in list_expansion_playbooks()
                if _normalize_company_name(e.company_name).lower() == company_norm
                or e.company_name.lower() == req.company_name.lower()
            ]
            expansion = get_expansion_playbook(exp_summaries[0].id) if exp_summaries else None

            precall_briefs = find_briefs_by_company(req.company_name)
            # Load full brief data for situation summary and attendees
            precall_full = []
            for b in precall_briefs[:3]:
                full = get_precall_brief(b["id"])
                if full:
                    precall_full.append(full)

            reports = [
                {"id": r.id, "title": r.title or r.query, "saved_at": r.saved_at}
                for r in list_reports()
                if company_norm in _normalize_company_name(r.title or r.query or "").lower()
                or req.company_name.lower() in (r.title or r.query or "").lower()
            ]

            slack_summaries = list_slack_summaries_for_company(req.company_name)

            company_notes = list_company_notes(dc["id"])

            if company_call_notes or demo_plans_full or expansion or precall_full or reports or slack_summaries or company_notes:
                existing_artifacts = {
                    "call_notes": company_call_notes,
                    "demo_plans": demo_plans_full,
                    "expansion_playbook": expansion,
                    "precall_briefs": precall_full,
                    "reports": reports,
                    "slack_summaries": slack_summaries,
                    "company_notes": company_notes,
                }
                if existing_artifacts:
                    research_data["data_sources"] = list(set(
                        research_data.get("data_sources", []) + ["existing_artifacts"]
                    ))
                logger.info(
                    "Hypothesis for '%s': loaded %d call notes, %d demo plans, "
                    "%d briefs, %s expansion playbook",
                    req.company_name,
                    len(company_call_notes),
                    len(demo_plans_full),
                    len(precall_full),
                    "with" if expansion else "no",
                )
            break
    stage_timings["artifact_assembly"] = int((time.perf_counter() - t0) * 1000)

    # Step 4: Synthesize with Claude
    t0 = time.perf_counter()
    synthesis = await synthesize_hypothesis(
        research=research_data,
        agent_responses=agent_responses,
        additional_context=req.additional_context,
        existing_artifacts=existing_artifacts,
    )
    stage_timings["synthesis"] = int((time.perf_counter() - t0) * 1000)

    elapsed_ms = int((time.perf_counter() - start) * 1000)

    response = HypothesisResponse(
        id="",
        company_name=req.company_name,
        domain=research_data.get("domain", req.domain or ""),
        is_public=research_data.get("is_public", False),
        confidence_level=synthesis.get("confidence_level", "low"),
        hypothesis_markdown=synthesis.get("hypothesis_markdown", ""),
        data_sources=research_data.get("data_sources", []),
        research_summary=research_data,
        stage_timings_ms=stage_timings,
        processing_time_ms=elapsed_ms,
    )

    # Step 4: Persist
    hyp_id = save_hypothesis(response)
    response.id = hyp_id

    logger.info(
        "Generated hypothesis %s for '%s' in %d ms",
        hyp_id, req.company_name, elapsed_ms,
    )

    return response


@task(name="get_hypotheses")
@app.get("/api/hypotheses")
async def get_hypotheses() -> list[HypothesisSummary]:
    return list_hypotheses()


@task(name="get_hypothesis_by_id")
@app.get("/api/hypotheses/{hyp_id}")
async def get_hypothesis_by_id(hyp_id: str):
    hyp = get_hypothesis(hyp_id)
    if hyp is None:
        return {"error": "Hypothesis not found"}
    return hyp


@task(name="find_hypothesis_for_company")
@app.get("/api/hypotheses/by-company/{company_name}")
async def find_hypothesis_for_company(company_name: str):
    hyp = find_hypothesis_by_company(company_name)
    if hyp is None:
        return {"found": False}
    return {"found": True, **hyp}

@task(name="delete_hypothesis_by_id")
@app.delete("/api/hypotheses/{hyp_id}")
async def delete_hypothesis_by_id(hyp_id: str):
    deleted = delete_hypothesis(hyp_id)
    return {"deleted": deleted}


@workflow(name="refresh_hypothesis")
@app.post("/api/hypotheses/{hyp_id}/refresh")
async def refresh_hypothesis(hyp_id: str):
    existing = get_hypothesis(hyp_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="Hypothesis not found")

    req = HypothesisRequest(
        company_name=existing["company_name"],
        domain=existing.get("domain"),
    )

    delete_hypothesis(hyp_id)

    return await handle_hypothesis(req)


# ---------------------------------------------------------------------------
# Account Expansion Playbook endpoints
# ---------------------------------------------------------------------------


@workflow(name="handle_expansion_playbook")
@app.post("/api/expansion-playbook")
async def handle_expansion_playbook(req: ExpansionRequest) -> ExpansionResponse:
    start = time.perf_counter()
    stage_timings: dict[str, int] = {}

    # --- Step 1: Gather context (hypothesis, strategic overview, or fresh research) ---
    research_data: dict = {}
    hypothesis_data: dict | None = None
    strategic_overview_data: dict | None = None

    if req.hypothesis_id:
        t0 = time.perf_counter()
        hypothesis_data = get_hypothesis(req.hypothesis_id)
        if hypothesis_data:
            research_data = hypothesis_data.get("research_summary", {})
        stage_timings["load_hypothesis"] = int((time.perf_counter() - t0) * 1000)

    if req.strategic_overview_id:
        t0 = time.perf_counter()
        strategic_overview_data = get_report(req.strategic_overview_id)
        stage_timings["load_overview"] = int((time.perf_counter() - t0) * 1000)

    if not research_data:
        if settings.company_research_agent_url:
            t0 = time.perf_counter()
            try:
                async with httpx.AsyncClient(timeout=120) as client:
                    resp = await client.post(
                        settings.company_research_agent_url,
                        json={
                            "company_name": req.company_name,
                            "domain": req.domain,
                        },
                    )
                    resp.raise_for_status()
                    data = resp.json()
                    research_data = data.get("research", {})
            except Exception as exc:
                logger.error("Company Research Agent failed: %s", exc)
                research_data = {
                    "company_name": req.company_name,
                    "domain": req.domain or "",
                    "is_public": False,
                    "confidence_level": "low",
                    "data_sources": [],
                }
            stage_timings["research"] = int((time.perf_counter() - t0) * 1000)
        else:
            research_data = {
                "company_name": req.company_name,
                "domain": req.domain or "",
                "is_public": False,
                "confidence_level": "low",
                "data_sources": [],
            }

    # --- Step 2: Extract context signals for agent queries ---
    strategic = research_data.get("strategic_priorities", [])
    competitive = research_data.get("competitive_displacement_targets", [])
    tech_investments = research_data.get("technology_investments", [])
    industry = research_data.get("industry", "")
    existing_products = (
        req.existing_footprint.products if req.existing_footprint else []
    )

    # Also extract competitive targets from the tiered technology landscape
    landscape_techs = research_data.get("technology_landscape", {}).get("technologies", [])
    competitive_from_landscape = [
        t.get("canonical_name", "")
        for t in landscape_techs
        if t.get("is_competitive_target")
    ]
    all_competitive = list(set(competitive + competitive_from_landscape))

    # --- Step 3: Parallel agent queries ---
    t0 = time.perf_counter()
    agent_tasks: dict[str, asyncio.Task[AgentResponse]] = {}

    # Librarian: product validation (always called)
    agent_tasks["librarian"] = asyncio.ensure_future(
        query_librarian_product_validation(
            competitive_tools=all_competitive,
            strategic_priorities=strategic + tech_investments,
            existing_products=existing_products,
        )
    )

    # Buyer Persona agent
    if settings.buyer_persona_agent_url:
        personas = research_data.get("key_personas", [])
        persona_titles = [p.get("title", "") for p in personas[:5] if p.get("title")]
        if not persona_titles:
            entry = research_data.get("recommended_entry_persona", {})
            persona_titles = [entry.get("title", "VP of Engineering")]

        persona_query = (
            f"For these personas: {', '.join(persona_titles)} — "
            f"which Datadog products align with each persona's KPIs and buying criteria? "
            f"The company's priorities are: {', '.join(strategic[:3]) if strategic else 'cloud modernization'}. "
            f"Which persona is the most likely buyer for each product?"
        )
        agent_tasks["buyer_persona"] = asyncio.ensure_future(
            query_agent(settings.buyer_persona_agent_url, persona_query)
        )

    # Value agent
    if settings.value_agent_url:
        value_topics = strategic[:3] + all_competitive[:2]
        value_query = (
            f"What ROI evidence, customer stories, or business value data exists for "
            f"Datadog products in the {industry or 'technology'} industry? "
            f"Focus on: {', '.join(value_topics) if value_topics else 'platform consolidation'}. "
            f"Include quantified outcomes and deployment timelines."
        )
        agent_tasks["value"] = asyncio.ensure_future(
            query_agent(settings.value_agent_url, value_query)
        )

    # Case Studies agent
    if settings.case_studies_agent_url:
        case_query = (
            f"Find case studies for companies in the {industry or 'technology'} industry "
            f"that expanded their Datadog usage or displaced competitive tools like "
            f"{', '.join(all_competitive[:3]) if all_competitive else 'legacy monitoring'}. "
            f"Include quantified outcomes: MTTR reduction, cost savings, deployment speed."
        )
        agent_tasks["case_studies"] = asyncio.ensure_future(
            query_agent(settings.case_studies_agent_url, case_query)
        )

    if agent_tasks:
        await asyncio.gather(*agent_tasks.values(), return_exceptions=True)

    agent_responses: dict[str, AgentResponse] = {}
    for name, atask in agent_tasks.items():
        exc = atask.exception()
        if exc is not None:
            logger.error("Expansion agent '%s' raised: %s", name, exc)
            agent_responses[name] = AgentResponse(error=str(exc))
        else:
            agent_responses[name] = atask.result()

    stage_timings["agents"] = int((time.perf_counter() - t0) * 1000)

    # --- Step 4: Synthesize the expansion playbook ---
    t0 = time.perf_counter()
    playbook_data = await synthesize_expansion_playbook(
        research=research_data,
        agent_responses=agent_responses,
        existing_footprint=req.existing_footprint,
        hypothesis_data=hypothesis_data,
        strategic_overview_data=strategic_overview_data,
        additional_context=req.additional_context,
    )
    stage_timings["synthesis"] = int((time.perf_counter() - t0) * 1000)

    elapsed_ms = int((time.perf_counter() - start) * 1000)

    playbook = ExpansionPlaybook(**playbook_data)
    response = ExpansionResponse(
        company_name=req.company_name,
        domain=research_data.get("domain", req.domain or ""),
        playbook=playbook,
        stage_timings_ms=stage_timings,
        processing_time_ms=elapsed_ms,
    )

    # --- Step 5: Persist ---
    pb_id = save_expansion_playbook(
        response,
        hypothesis_id=req.hypothesis_id or "",
        overview_id=req.strategic_overview_id or "",
        footprint_dict=(
            req.existing_footprint.model_dump() if req.existing_footprint else None
        ),
    )
    response.id = pb_id

    logger.info(
        "Generated expansion playbook %s for '%s' (%d opportunities) in %d ms",
        pb_id, req.company_name, playbook.total_opportunities, elapsed_ms,
    )

    return response


@task(name="get_expansion_playbooks")
@app.get("/api/expansion-playbooks")
async def get_expansion_playbooks() -> list[ExpansionSummary]:
    return list_expansion_playbooks()


@task(name="find_expansion_for_company")
@app.get("/api/expansion-playbooks/by-company/{company_name}")
async def find_expansion_for_company(company_name: str):
    pb = find_playbook_by_company(company_name)
    if pb is None:
        return {"found": False}
    return {"found": True, **pb}


@task(name="get_expansion_playbook_by_id")
@app.get("/api/expansion-playbooks/{pb_id}")
async def get_expansion_playbook_by_id(pb_id: str):
    pb = get_expansion_playbook(pb_id)
    if pb is None:
        return {"error": "Expansion playbook not found"}
    return pb


@task(name="delete_expansion_playbook_by_id")
@app.delete("/api/expansion-playbooks/{pb_id}")
async def delete_expansion_playbook_by_id(pb_id: str):
    deleted = delete_expansion_playbook(pb_id)
    return {"deleted": deleted}


# ---------------------------------------------------------------------------
# Call Notes endpoints
# ---------------------------------------------------------------------------


class _CallNoteCreate(_BaseModel):
    raw_transcript: str
    title: str = ""
    company_id: str = ""
    summary_json: str = ""  # pre-parsed JSON if provided by client


@workflow(name="handle_call_note")
@app.post("/api/call-notes")
async def handle_call_note(req: _CallNoteCreate):
    if not req.raw_transcript.strip():
        raise HTTPException(status_code=400, detail="Transcript text is required")

    start = time.perf_counter()

    company_name = ""
    if req.company_id:
        company = get_company_record(req.company_id)
        if company:
            company_name = company["name"]

    summary_markdown = await summarize_call_transcript(req.raw_transcript)

    elapsed_ms = int((time.perf_counter() - start) * 1000)

    note = save_call_note(
        raw_transcript=req.raw_transcript,
        summary_markdown=summary_markdown,  # now stores JSON string
        title=req.title,
        company_id=req.company_id,
        company_name=company_name,
        processing_time_ms=elapsed_ms,
    )

    if req.company_id:
        try:
            link_company_resource(req.company_id, "call_note", note["id"])
        except (ValueError, Exception) as exc:
            logger.warning("Could not auto-link call note to company: %s", exc)

    logger.info(
        "Saved call note %s (company=%s) in %d ms",
        note["id"], company_name or "none", elapsed_ms,
    )

    return note


@task(name="get_call_notes")
@app.get("/api/call-notes")
async def get_call_notes():
    return {"call_notes": list_call_notes()}


@task(name="get_call_note_by_id")
@app.get("/api/call-notes/{note_id}")
async def get_call_note_by_id(note_id: str):
    note = get_call_note(note_id)
    if note is None:
        raise HTTPException(status_code=404, detail="Call note not found")
    return note


@task(name="delete_call_note_by_id")
@app.delete("/api/call-notes/{note_id}")
async def delete_call_note_by_id(note_id: str):
    deleted = delete_call_note(note_id)
    return {"deleted": deleted}


@task(name="get_call_note_pdf")
@app.get("/api/call-notes/{note_id}/pdf")
async def get_call_note_pdf(note_id: str):
    note = get_call_note(note_id)
    if note is None:
        raise HTTPException(status_code=404, detail="Call note not found")
    pdf_path = await generate_call_note_pdf_async(
        note_id=note_id,
        summary_json=note["summary_markdown"],
        title=note.get("title", ""),
        company_name=note.get("company_name", ""),
    )
    return FileResponse(
        str(pdf_path),
        media_type="application/pdf",
        filename=f"call_note_{note_id}.pdf",
    )


@task(name="get_call_note_markdown")
@app.get("/api/call-notes/{note_id}/markdown")
async def get_call_note_markdown(note_id: str):
    note = get_call_note(note_id)
    if note is None:
        raise HTTPException(status_code=404, detail="Call note not found")
    md_text = export_call_note_markdown(
        summary_json=note["summary_markdown"],
        title=note.get("title", ""),
        company_name=note.get("company_name", ""),
    )
    return {"note_id": note_id, "markdown": md_text}


@task(name="get_librarian_products")
@app.get("/api/librarian/products")
async def get_librarian_products():
    """Proxy to the Librarian agent for the canonical Datadog product list."""
    resp = await query_librarian_product_list()
    if resp.error:
        return {"error": resp.error, "products": []}
    return {"answer": resp.answer, "sources": resp.sources}


# ---------------------------------------------------------------------------
# Linked artifacts lookup
# ---------------------------------------------------------------------------

_COMPANY_SUFFIX_RE = __import__("re").compile(
    r"\s*\b(corporation|corp\.?|incorporated|inc\.?|company|co\.?|ltd\.?|"
    r"limited|llc|plc|group|holdings?|enterprises?|international|intl\.?)\s*$",
    __import__("re").IGNORECASE,
)


def _normalize_company_name(name: str) -> str:
    """Strip common corporate suffixes for grouping."""
    return _COMPANY_SUFFIX_RE.sub("", name).strip()


@task(name="linked_artifacts")
@app.get("/api/linked-artifacts/{company_name}")
async def linked_artifacts(company_name: str):
    """Find all related artifacts (hypothesis, strategy reports, demo plans) for a company."""
    company_lower = company_name.lower()
    company_norm = _normalize_company_name(company_name).lower()
    result: dict = {
        "company_name": company_name, "hypothesis": None,
        "reports": [], "demo_plans": [], "expansion_playbooks": [],
    }

    hyp = find_hypothesis_by_company(company_name)
    if hyp:
        result["hypothesis"] = {
            "id": hyp["id"],
            "created_at": hyp["created_at"],
            "confidence_level": hyp["confidence_level"],
            "is_public": hyp["is_public"],
        }

    for report_summary in list_reports():
        title = (report_summary.title or report_summary.query or "").lower()
        title_norm = _normalize_company_name(title).lower()
        if company_lower in title or company_norm in title_norm:
            result["reports"].append({
                "id": report_summary.id,
                "title": report_summary.title or report_summary.query,
                "saved_at": report_summary.saved_at,
                "route": report_summary.route,
            })

    for plan_summary in list_demo_plans():
        plan_norm = _normalize_company_name(plan_summary.company_name).lower()
        if plan_norm == company_norm or company_lower in plan_summary.company_name.lower():
            result["demo_plans"].append({
                "id": plan_summary.id,
                "title": plan_summary.title,
                "created_at": plan_summary.created_at,
                "persona": plan_summary.persona,
                "demo_mode": plan_summary.demo_mode,
            })

    for exp_summary in list_expansion_playbooks():
        exp_norm = _normalize_company_name(exp_summary.company_name).lower()
        if exp_norm == company_norm or company_lower in exp_summary.company_name.lower():
            result["expansion_playbooks"].append({
                "id": exp_summary.id,
                "created_at": exp_summary.created_at,
                "total_opportunities": exp_summary.total_opportunities,
            })

    return result


# ---------------------------------------------------------------------------
# Company CRUD & resource linking
# ---------------------------------------------------------------------------


class _CompanyCreate(_BaseModel):
    name: str
    domain: str = ""
    notes: str = ""


class _CompanyUpdate(_BaseModel):
    name: str | None = None
    domain: str | None = None
    notes: str | None = None


class _ResourceLink(_BaseModel):
    resource_type: str
    resource_id: str


@task(name="create_company")
@app.post("/api/companies")
async def api_create_company(body: _CompanyCreate):
    if not body.name.strip():
        raise HTTPException(status_code=400, detail="Company name is required")
    company = create_company_record(body.name, body.domain, body.notes)
    return company


@task(name="update_company")
@app.put("/api/companies/{company_id}")
async def api_update_company(company_id: str, body: _CompanyUpdate):
    updated = update_company_record(company_id, body.name, body.domain, body.notes)
    if not updated:
        raise HTTPException(status_code=404, detail="Company not found")
    return updated


@task(name="delete_company")
@app.delete("/api/companies/{company_id}")
async def api_delete_company(company_id: str):
    if not delete_company_record(company_id):
        raise HTTPException(status_code=404, detail="Company not found")
    return {"ok": True}


@task(name="get_company")
@app.get("/api/companies/defined/{company_id}")
async def api_get_company(company_id: str):
    company = get_company_record(company_id)
    if not company:
        raise HTTPException(status_code=404, detail="Company not found")
    return company


@task(name="link_resource")
@app.post("/api/companies/{company_id}/resources")
async def api_link_resource(company_id: str, body: _ResourceLink):
    if not get_company_record(company_id):
        raise HTTPException(status_code=404, detail="Company not found")
    try:
        link = link_company_resource(company_id, body.resource_type, body.resource_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return link


@task(name="unlink_resource")
@app.delete("/api/companies/{company_id}/resources/{resource_type}/{resource_id}")
async def api_unlink_resource(company_id: str, resource_type: str, resource_id: str):
    if not unlink_company_resource(company_id, resource_type, resource_id):
        raise HTTPException(status_code=404, detail="Link not found")
    return {"ok": True}


class _NoteCreate(_BaseModel):
    title: str
    content: str
    note_date: str | None = None


class _NoteUpdateDate(_BaseModel):
    note_date: str


@task(name="create_company_note")
@app.post("/api/companies/{company_id}/notes")
async def api_create_company_note(company_id: str, body: _NoteCreate):
    if not get_company_record(company_id):
        raise HTTPException(status_code=404, detail="Company not found")
    if not body.title.strip():
        raise HTTPException(status_code=400, detail="Title is required")
    if not body.content.strip():
        raise HTTPException(status_code=400, detail="Content is required")
    return create_company_note(company_id, body.title, body.content, body.note_date)


@task(name="list_company_notes")
@app.get("/api/companies/{company_id}/notes")
async def api_list_company_notes(company_id: str):
    if not get_company_record(company_id):
        raise HTTPException(status_code=404, detail="Company not found")
    return {"notes": list_company_notes(company_id)}


@task(name="update_company_note_date")
@app.patch("/api/companies/{company_id}/notes/{note_id}")
async def api_update_company_note_date(company_id: str, note_id: str, body: _NoteUpdateDate):
    if not get_company_record(company_id):
        raise HTTPException(status_code=404, detail="Company not found")
    if not body.note_date.strip():
        raise HTTPException(status_code=400, detail="Date is required")
    result = update_company_note_date(note_id, body.note_date)
    if not result:
        raise HTTPException(status_code=404, detail="Note not found")
    return result


@task(name="delete_company_note")
@app.delete("/api/companies/{company_id}/notes/{note_id}")
async def api_delete_company_note(company_id: str, note_id: str):
    if not delete_company_note(note_id):
        raise HTTPException(status_code=404, detail="Note not found")
    return {"ok": True}


@task(name="list_companies")
@app.get("/api/companies")
async def list_companies():
    """Aggregate explicitly defined companies and auto-discovered ones from artifacts."""

    linked_ids = get_all_linked_resource_ids()

    # --- 1. Build defined companies with their manually linked resources ---
    defined_results: list[dict] = []
    for dc in list_defined_companies():
        entry: dict = {
            "id": dc["id"], "name": dc["name"], "key": _normalize_company_name(dc["name"]).lower() or dc["id"],
            "domain": dc["domain"], "notes": dc["notes"],
            "is_defined": True,
            "hypotheses": [], "reports": [], "demo_plans": [],
            "expansion_playbooks": [], "call_notes": [], "precall_briefs": [], "latest_activity": dc["created_at"],
        }
        for lr in list_company_resources(dc["id"]):
            rt, rid = lr["resource_type"], lr["resource_id"]
            if rt == "hypothesis":
                hyp = get_hypothesis(rid)
                if hyp:
                    entry["hypotheses"].append({
                        "id": hyp["id"], "created_at": hyp["created_at"],
                        "confidence_level": hyp["confidence_level"], "is_public": hyp["is_public"],
                    })
                    if hyp["created_at"] > entry["latest_activity"]:
                        entry["latest_activity"] = hyp["created_at"]
            elif rt == "report":
                rpt = get_report(rid)
                if rpt:
                    entry["reports"].append({
                        "id": rpt.id, "title": rpt.title or "",
                        "saved_at": rpt.saved_at, "route": rpt.response.route if rpt.response else "",
                    })
                    if rpt.saved_at > entry["latest_activity"]:
                        entry["latest_activity"] = rpt.saved_at
            elif rt == "demo_plan":
                plan = get_demo_plan(rid)
                if plan:
                    entry["demo_plans"].append({
                        "id": plan.get("id", rid), "title": plan.get("title", ""),
                        "created_at": plan.get("created_at", ""),
                        "persona": plan.get("persona", ""), "demo_mode": plan.get("demo_mode", ""),
                    })
                    if plan.get("created_at", "") > entry["latest_activity"]:
                        entry["latest_activity"] = plan["created_at"]
            elif rt == "expansion_playbook":
                exp = get_expansion_playbook(rid)
                if exp:
                    entry["expansion_playbooks"].append({
                        "id": exp.get("id", rid), "created_at": exp.get("created_at", ""),
                        "total_opportunities": exp.get("total_opportunities", 0),
                    })
                    if exp.get("created_at", "") > entry["latest_activity"]:
                        entry["latest_activity"] = exp["created_at"]
            elif rt == "call_note":
                cn = get_call_note(rid)
                if cn:
                    entry["call_notes"].append({
                        "id": cn["id"], "created_at": cn["created_at"],
                        "title": cn["title"],
                        "summary_preview": (cn.get("summary_markdown") or "")[:200],
                    })
                    if cn["created_at"] > entry["latest_activity"]:
                        entry["latest_activity"] = cn["created_at"]
            elif rt == "precall_brief":
                pb = get_precall_brief(rid)
                if pb:
                    entry["precall_briefs"].append({
                        "id": pb.get("id", rid),
                        "created_at": pb.get("created_at", ""),
                        "call_type": pb.get("call_type", ""),
                        "north_star": pb.get("north_star", ""),
                    })
                    if pb.get("created_at", "") > entry["latest_activity"]:
                        entry["latest_activity"] = pb["created_at"]
        defined_results.append(entry)

    # --- 2. Build auto-discovered companies from artifacts not manually linked ---
    dynamic: dict[str, dict] = {}

    def _ensure(name: str) -> dict:
        key = _normalize_company_name(name).lower()
        if not key:
            return dynamic.setdefault("unknown", {
                "name": name, "key": "unknown", "is_defined": False,
                "hypotheses": [], "reports": [], "demo_plans": [],
                "expansion_playbooks": [], "call_notes": [], "precall_briefs": [], "latest_activity": "",
            })
        if key not in dynamic:
            dynamic[key] = {
                "name": name, "key": key, "is_defined": False,
                "hypotheses": [], "reports": [], "demo_plans": [],
                "expansion_playbooks": [], "call_notes": [], "precall_briefs": [], "latest_activity": "",
            }
        return dynamic[key]

    for hyp_summary in list_hypotheses():
        if ("hypothesis", hyp_summary.id) in linked_ids:
            continue
        c = _ensure(hyp_summary.company_name)
        c["hypotheses"].append({
            "id": hyp_summary.id, "created_at": hyp_summary.created_at,
            "confidence_level": hyp_summary.confidence_level, "is_public": hyp_summary.is_public,
        })
        if hyp_summary.created_at > c["latest_activity"]:
            c["latest_activity"] = hyp_summary.created_at

    _re = __import__("re")
    for report_summary in list_reports():
        if ("report", report_summary.id) in linked_ids:
            continue
        title = report_summary.title or report_summary.query or ""
        name = _re.split(r"\s*[-—–|]\s*", title, maxsplit=1)[0].strip()
        name = _re.sub(
            r"\s*(Strategic Overview|Executive Report|Report)\s*$",
            "", name, flags=_re.IGNORECASE,
        ).strip()
        if not name:
            continue
        c = _ensure(name)
        c["reports"].append({
            "id": report_summary.id, "title": title,
            "saved_at": report_summary.saved_at, "route": report_summary.route,
        })
        if report_summary.saved_at > c["latest_activity"]:
            c["latest_activity"] = report_summary.saved_at

    for plan_summary in list_demo_plans():
        if ("demo_plan", plan_summary.id) in linked_ids:
            continue
        c = _ensure(plan_summary.company_name)
        c["demo_plans"].append({
            "id": plan_summary.id, "title": plan_summary.title,
            "created_at": plan_summary.created_at,
            "persona": plan_summary.persona, "demo_mode": plan_summary.demo_mode,
        })
        if plan_summary.created_at > c["latest_activity"]:
            c["latest_activity"] = plan_summary.created_at

    for exp_summary in list_expansion_playbooks():
        if ("expansion_playbook", exp_summary.id) in linked_ids:
            continue
        c = _ensure(exp_summary.company_name)
        c["expansion_playbooks"].append({
            "id": exp_summary.id, "created_at": exp_summary.created_at,
            "total_opportunities": exp_summary.total_opportunities,
        })
        if exp_summary.created_at > c["latest_activity"]:
            c["latest_activity"] = exp_summary.created_at

    for pb_summary in list_precall_briefs():
        if ("precall_brief", pb_summary["id"]) in linked_ids:
            continue
        c = _ensure(pb_summary["company_name"])
        c["precall_briefs"].append({
            "id": pb_summary["id"],
            "created_at": pb_summary["created_at"],
            "call_type": pb_summary["call_type"],
            "north_star": pb_summary["north_star"],
        })
        if pb_summary["created_at"] > c["latest_activity"]:
            c["latest_activity"] = pb_summary["created_at"]

    # --- 3. Merge: defined first (sorted by activity), then dynamic (sorted by activity) ---
    defined_sorted = sorted(defined_results, key=lambda c: c["latest_activity"], reverse=True)
    dynamic_sorted = sorted(dynamic.values(), key=lambda c: c["latest_activity"], reverse=True)
    return {"companies": defined_sorted + dynamic_sorted}


@task(name="company_profile")
@app.get("/api/companies/{key}/profile")
async def company_profile(key: str):
    """Return comprehensive data for a single company landing page."""
    key_lower = key.lower()

    # Try to find defined company first (by id or normalized name)
    company_meta = None
    for dc in list_defined_companies():
        if dc["id"] == key or _normalize_company_name(dc["name"]).lower() == key_lower:
            company_meta = {
                "id": dc["id"], "name": dc["name"], "domain": dc["domain"],
                "notes": dc["notes"], "is_defined": True, "created_at": dc["created_at"],
            }
            break

    if not company_meta:
        # Auto-discovered: derive name from artifacts
        for hyp in list_hypotheses():
            if _normalize_company_name(hyp.company_name).lower() == key_lower:
                company_meta = {"name": hyp.company_name, "key": key_lower, "is_defined": False}
                break
        if not company_meta:
            for plan in list_demo_plans():
                if _normalize_company_name(plan.company_name).lower() == key_lower:
                    company_meta = {"name": plan.company_name, "key": key_lower, "is_defined": False}
                    break
        if not company_meta:
            for exp in list_expansion_playbooks():
                if _normalize_company_name(exp.company_name).lower() == key_lower:
                    company_meta = {"name": exp.company_name, "key": key_lower, "is_defined": False}
                    break
        if not company_meta:
            for pb in list_precall_briefs():
                if _normalize_company_name(pb["company_name"]).lower() == key_lower:
                    company_meta = {"name": pb["company_name"], "key": key_lower, "is_defined": False}
                    break

    if not company_meta:
        raise HTTPException(status_code=404, detail="Company not found")

    company_name = company_meta["name"]

    artifacts = _gather_company_artifacts(company_name)

    hypotheses_data = []
    hyp = artifacts["hypothesis"]
    if hyp:
        hypotheses_data.append({
            "id": hyp["id"], "created_at": hyp["created_at"],
            "confidence_level": hyp.get("confidence_level"),
            "is_public": hyp.get("is_public", False),
            "executive_summary": hyp.get("executive_summary", ""),
            "value_hypotheses": hyp.get("value_hypotheses", []),
        })

    reports_data = [
        {"id": r["id"], "title": r["title"], "saved_at": r["saved_at"]}
        for r in artifacts["reports"]
    ]

    demo_plans_data = [
        {"id": p["id"], "title": p["title"], "created_at": p["created_at"],
         "persona": p.get("persona", ""), "demo_mode": p.get("demo_mode", "")}
        for p in artifacts["demo_plans"]
    ]

    expansion_data = []
    ep = artifacts["expansion_playbook"]
    if ep:
        expansion_data.append({
            "id": ep.get("id", ""), "created_at": ep.get("created_at", ""),
            "total_opportunities": ep.get("total_opportunities", 0),
        })

    call_notes_data = [
        {"id": cn["id"], "created_at": cn["created_at"],
         "title": cn.get("title", ""), "company_name": cn.get("company_name", ""),
         "summary_preview": (cn.get("summary_markdown") or "")[:300]}
        for cn in artifacts["call_notes"]
    ]

    precall_data = [
        {"id": pb.get("id", ""), "created_at": pb.get("created_at", ""),
         "call_type": pb.get("call_type", ""), "north_star": pb.get("north_star", "")}
        for pb in artifacts["precall_briefs"]
    ]

    slack_data = artifacts["slack_summaries"]

    digests = find_digests_by_company(company_name)
    digests_data = [
        {"id": d["id"], "created_at": d["created_at"],
         "title": d.get("title", "Release Digest")}
        for d in digests
    ]

    next_steps_record = find_next_steps_by_company(company_name)
    next_steps_data = None
    if next_steps_record:
        next_steps_data = {
            "id": next_steps_record["id"],
            "created_at": next_steps_record["created_at"],
            "summary_preview": (next_steps_record.get("markdown") or "")[:400],
        }

    # Stats
    counts = {
        "hypotheses": len(hypotheses_data),
        "reports": len(reports_data),
        "demo_plans": len(demo_plans_data),
        "expansion_playbooks": len(expansion_data),
        "call_notes": len(call_notes_data),
        "precall_briefs": len(precall_data),
        "slack_summaries": len(slack_data),
        "release_digests": len(digests_data),
    }
    completeness = sum(1 for k in ("hypotheses", "reports", "demo_plans") if counts[k] > 0)
    total_artifacts = sum(counts.values())

    dates = []
    for h in hypotheses_data:
        dates.append(h["created_at"])
    for r in reports_data:
        dates.append(r["saved_at"])
    for p in demo_plans_data:
        dates.append(p["created_at"])
    for cn in call_notes_data:
        dates.append(cn["created_at"])
    for pb in precall_data:
        dates.append(pb["created_at"])
    latest_activity = max(dates) if dates else company_meta.get("created_at", "")

    cached_snapshot = get_latest_snapshot(company_name)

    notes_list = []
    if company_meta.get("is_defined") and company_meta.get("id"):
        notes_list = list_company_notes(company_meta["id"])

    return {
        "company": company_meta,
        "hypotheses": hypotheses_data,
        "reports": reports_data,
        "demo_plans": demo_plans_data,
        "expansion_playbooks": expansion_data,
        "call_notes": call_notes_data,
        "precall_briefs": precall_data,
        "slack_summaries": slack_data,
        "release_digests": digests_data,
        "next_steps": next_steps_data,
        "notes_list": notes_list,
        "cached_snapshot": cached_snapshot,
        "stats": {
            "counts": counts,
            "completeness": completeness,
            "completeness_max": 3,
            "total_artifacts": total_artifacts,
            "latest_activity": latest_activity,
        },
    }


# ---------------------------------------------------------------------------
# Next Steps Agent endpoints
# ---------------------------------------------------------------------------


@workflow(name="handle_next_steps")
@app.post("/api/next-steps")
async def handle_next_steps(req: NextStepsRequest) -> NextStepsResponse:
    start = time.perf_counter()

    # --- Assemble all available artifacts for this company ---
    company_name = req.company_name

    # Hypothesis — prefer by ID if company is defined, otherwise by name
    hypothesis: dict | None = None
    if req.company_id:
        company = get_company_record(req.company_id)
        if company:
            company_name = company["name"]
    hypothesis = find_hypothesis_by_company(company_name)

    # Call notes — fetch all, sorted newest first (store already does this)
    all_notes = list_call_notes()
    company_norm = _normalize_company_name(company_name).lower()
    call_notes = [
        get_call_note(n["id"])
        for n in all_notes
        if (
            n.get("company_name", "").lower() == company_name.lower()
            or _normalize_company_name(n.get("company_name", "")).lower() == company_norm
        )
        and n.get("id")
    ]
    # Filter out any None results
    call_notes = [n for n in call_notes if n]

    # Demo plans
    demo_plan_summaries = [
        p for p in list_demo_plans()
        if _normalize_company_name(p.company_name).lower() == company_norm
        or p.company_name.lower() == company_name.lower()
    ]
    demo_plans_brief = [
        {"id": p.id, "title": p.title, "created_at": p.created_at,
         "persona": p.persona, "demo_mode": p.demo_mode}
        for p in demo_plan_summaries
    ]

    # Expansion playbook — most recent
    expansion_playbook: dict | None = None
    exp_summaries = [
        e for e in list_expansion_playbooks()
        if _normalize_company_name(e.company_name).lower() == company_norm
        or e.company_name.lower() == company_name.lower()
    ]
    if exp_summaries:
        expansion_playbook = get_expansion_playbook(exp_summaries[0].id)

    # Reports
    reports_brief = [
        {"id": r.id, "title": r.title or r.query, "saved_at": r.saved_at, "route": r.route}
        for r in list_reports()
        if company_norm in _normalize_company_name(r.title or r.query or "").lower()
        or company_name.lower() in (r.title or r.query or "").lower()
    ]

    elapsed_ms = int((time.perf_counter() - start) * 1000)

    slack_summaries = list_slack_summaries_for_company(company_name)

    company_notes: list[dict] = []
    for dc in list_defined_companies():
        if _normalize_company_name(dc["name"]).lower() == company_norm:
            company_notes = list_company_notes(dc["id"])
            break

    synthesis = await synthesize_next_steps(
        company_name=company_name,
        hypothesis=hypothesis,
        call_notes=call_notes,
        demo_plans=demo_plans_brief,
        expansion_playbook=expansion_playbook,
        reports=reports_brief,
        deal_stage_override=req.deal_stage_override,
        additional_context=req.additional_context,
        slack_summaries=slack_summaries,
        company_notes=company_notes,
    )

    total_ms = int((time.perf_counter() - start) * 1000)

    from next_steps_models import NextStep
    response = NextStepsResponse(
        company_name=company_name,
        inferred_deal_stage=synthesis["inferred_deal_stage"],
        deal_stage_confidence=synthesis["deal_stage_confidence"],
        next_steps=[NextStep(**s) for s in synthesis["next_steps"]],
        blocking_risks=synthesis["blocking_risks"],
        missing_artifacts=synthesis["missing_artifacts"],
        recommended_focus=synthesis["recommended_focus"],
        processing_time_ms=total_ms,
    )

    record_id = save_next_steps(response)
    response.id = record_id

    logger.info(
        "Generated next steps %s for '%s' (stage=%s) in %d ms",
        record_id, company_name, response.inferred_deal_stage, total_ms,
    )
    return response


@task(name="get_next_steps_list")
@app.get("/api/next-steps")
async def get_next_steps_list() -> list[NextStepsSummary]:
    return list_next_steps()


# NOTE: specific sub-paths must come BEFORE the /{record_id} catch-all.

@task(name="find_next_steps_for_company")
@app.get("/api/next-steps/by-company/{company_name}")
async def find_next_steps_for_company(company_name: str):
    record = find_next_steps_by_company(company_name)
    if record is None:
        return {"found": False}
    return {"found": True, **record}


@workflow(name="refresh_next_steps")
@app.post("/api/next-steps/{record_id}/refresh")
async def refresh_next_steps(record_id: str):
    existing = get_next_steps(record_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="Next steps record not found")
    delete_next_steps(record_id)
    req = NextStepsRequest(company_name=existing["company_name"])
    return await handle_next_steps(req)


@task(name="get_next_steps_by_id")
@app.get("/api/next-steps/{record_id}")
async def get_next_steps_by_id(record_id: str):
    record = get_next_steps(record_id)
    if record is None:
        return {"error": "Next steps record not found"}
    return record


@task(name="delete_next_steps_by_id")
@app.delete("/api/next-steps/{record_id}")
async def delete_next_steps_by_id(record_id: str):
    deleted = delete_next_steps(record_id)
    return {"deleted": deleted}


# ---------------------------------------------------------------------------
# Pre-Call Brief endpoints
# ---------------------------------------------------------------------------


@workflow(name="handle_precall_brief")
@app.post("/api/precall-brief")
async def handle_precall_brief(req: PreCallBriefRequest) -> PreCallBrief:
    start = time.perf_counter()

    company_norm = _normalize_company_name(req.company_name).lower()

    # --- Resolve hypothesis ---
    hypothesis: dict | None = None
    if req.hypothesis_id:
        hypothesis = find_hypothesis_by_company(req.company_name)  # fallback by name if ID lookup not wired
        # Direct ID lookup via store
        from hypothesis_store import get_hypothesis as _get_hyp
        hypothesis = _get_hyp(req.hypothesis_id) or hypothesis
    else:
        hypothesis = find_hypothesis_by_company(req.company_name)

    # --- Resolve call notes ---
    call_notes: list[dict] = []
    if req.call_note_ids:
        for nid in req.call_note_ids:
            note = get_call_note(nid)
            if note:
                call_notes.append(note)
    else:
        # Auto-fetch most recent 3 call notes for this company
        all_notes = list_call_notes()
        matching = [
            n for n in all_notes
            if (
                n.get("company_name", "").lower() == req.company_name.lower()
                or _normalize_company_name(n.get("company_name", "")).lower() == company_norm
            )
        ]
        for n in matching[:3]:
            note = get_call_note(n["id"])
            if note:
                call_notes.append(note)

    # --- Resolve demo plan ---
    demo_plan: dict | None = None
    if req.demo_plan_id:
        demo_plan = get_demo_plan(req.demo_plan_id)
    else:
        plan_summaries = [
            p for p in list_demo_plans()
            if _normalize_company_name(p.company_name).lower() == company_norm
            or p.company_name.lower() == req.company_name.lower()
        ]
        if plan_summaries:
            demo_plan = get_demo_plan(plan_summaries[0].id)

    slack_summaries_pc = list_slack_summaries_for_company(req.company_name)

    company_notes_pc: list[dict] = []
    for dc in list_defined_companies():
        if _normalize_company_name(dc["name"]).lower() == company_norm:
            company_notes_pc = list_company_notes(dc["id"])
            break

    synthesis = await synthesize_precall_brief(
        company_name=req.company_name,
        call_type=req.call_type,
        attendees=req.attendees,
        call_objective=req.call_objective,
        hypothesis=hypothesis,
        call_notes=call_notes,
        demo_plan=demo_plan,
        additional_context=req.additional_context,
        slack_summaries=slack_summaries_pc,
        company_notes=company_notes_pc,
    )

    total_ms = int((time.perf_counter() - start) * 1000)

    from precall_models import CallQuestion, AttendeeBrief
    return PreCallBrief(
        company_name=req.company_name,
        call_type=req.call_type.value,
        situation_summary=synthesis.get("situation_summary", ""),
        what_we_know=synthesis.get("what_we_know", []),
        what_we_dont_know=synthesis.get("what_we_dont_know", []),
        call_objectives=synthesis.get("call_objectives", []),
        questions_to_ask=[
            CallQuestion(**q) for q in synthesis.get("questions_to_ask", [])
        ],
        attendee_prep=[
            AttendeeBrief(**a) for a in synthesis.get("attendee_prep", [])
        ],
        things_to_avoid=synthesis.get("things_to_avoid", []),
        key_proof_points=synthesis.get("key_proof_points", []),
        north_star=synthesis.get("north_star", ""),
        processing_time_ms=total_ms,
    )


@task(name="get_call_types")
@app.get("/api/precall-brief/call-types")
async def get_call_types():
    """Return available call types for the frontend dropdown."""
    return {
        "call_types": [
            {"value": ct.value, "label": ct.value.replace("_", " ").title()}
            for ct in CallType
        ]
    }


@task(name="save_precall_brief_endpoint")
@app.post("/api/precall-briefs")
async def save_precall_brief_endpoint(brief: PreCallBrief):
    """Persist a generated pre-call brief and auto-link it to the company."""
    # Find matching defined company by name so we can link the resource
    company_id = ""
    company_norm = _normalize_company_name(brief.company_name).lower()
    for dc in list_defined_companies():
        if _normalize_company_name(dc["name"]).lower() == company_norm:
            company_id = dc["id"]
            break

    record_id = save_precall_brief(
        brief=brief.model_dump(),
        company_id=company_id,
        processing_time_ms=brief.processing_time_ms,
    )

    # Auto-link to company if one was found
    if company_id:
        try:
            link_company_resource(company_id, "precall_brief", record_id)
        except (ValueError, Exception) as exc:
            logger.warning("Could not auto-link pre-call brief to company: %s", exc)

    return {"id": record_id, "saved": True, "company_id": company_id}


@task(name="list_precall_briefs_endpoint")
@app.get("/api/precall-briefs")
async def list_precall_briefs_endpoint():
    return {"briefs": list_precall_briefs()}


# NOTE: specific sub-paths must be registered BEFORE the /{record_id} catch-all
# or FastAPI will swallow them.

@task(name="get_precall_briefs_by_company")
@app.get("/api/precall-briefs/by-company/{company_name}")
async def get_precall_briefs_by_company(company_name: str):
    briefs = find_briefs_by_company(company_name)
    return {"briefs": briefs}


@task(name="get_precall_brief_pdf")
@app.get("/api/precall-briefs/{record_id}/pdf")
async def get_precall_brief_pdf(record_id: str):
    brief = get_precall_brief(record_id)
    if brief is None:
        raise HTTPException(status_code=404, detail="Brief not found")
    try:
        pdf_path = await generate_precall_pdf_async(record_id=record_id, brief=brief)
    except Exception as exc:
        logger.exception("Pre-call brief PDF generation failed for %s", record_id)
        raise HTTPException(status_code=500, detail=str(exc))
    return FileResponse(
        str(pdf_path),
        media_type="application/pdf",
        filename=f"precall_brief_{record_id}.pdf",
    )


@task(name="get_precall_brief_by_id")
@app.get("/api/precall-briefs/{record_id}")
async def get_precall_brief_by_id(record_id: str):
    record = get_precall_brief(record_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Brief not found")
    return record


@task(name="delete_precall_brief_endpoint")
@app.delete("/api/precall-briefs/{record_id}")
async def delete_precall_brief_endpoint(record_id: str):
    deleted = delete_precall_brief(record_id)
    return {"deleted": deleted}


class _SnapshotRequest(_BaseModel):
    company_name: str
    additional_context: str | None = None


def _gather_company_artifacts(company_name: str) -> dict:
    """Collect all artifacts associated with a company by normalized name.

    Returns a dict with keys: hypothesis, call_notes, demo_plans,
    expansion_playbook, reports, slack_summaries, precall_briefs,
    company_notes.
    """
    company_norm = _normalize_company_name(company_name).lower()

    hypothesis = find_hypothesis_by_company(company_name)

    all_notes = list_call_notes()
    call_notes = [
        get_call_note(n["id"])
        for n in all_notes
        if (
            n.get("company_name", "").lower() == company_name.lower()
            or _normalize_company_name(n.get("company_name", "")).lower() == company_norm
        )
        and n.get("id")
    ]
    call_notes = [n for n in call_notes if n]

    demo_plan_summaries = [
        p for p in list_demo_plans()
        if _normalize_company_name(p.company_name).lower() == company_norm
        or p.company_name.lower() == company_name.lower()
    ]
    demo_plans = [
        {"id": p.id, "title": p.title, "created_at": p.created_at,
         "persona": p.persona, "demo_mode": p.demo_mode}
        for p in demo_plan_summaries
    ]

    expansion_playbook: dict | None = None
    exp_summaries = [
        e for e in list_expansion_playbooks()
        if _normalize_company_name(e.company_name).lower() == company_norm
        or e.company_name.lower() == company_name.lower()
    ]
    if exp_summaries:
        expansion_playbook = get_expansion_playbook(exp_summaries[0].id)

    reports = [
        {"id": r.id, "title": r.title or r.query, "saved_at": r.saved_at}
        for r in list_reports()
        if company_norm in _normalize_company_name(r.title or r.query or "").lower()
        or company_name.lower() in (r.title or r.query or "").lower()
    ]

    slack_summaries = list_slack_summaries_for_company(company_name)

    precall_briefs = find_briefs_by_company(company_name)

    # Load structured company notes (from defined company if one matches)
    company_notes: list[dict] = []
    for dc in list_defined_companies():
        if _normalize_company_name(dc["name"]).lower() == company_norm:
            company_notes = list_company_notes(dc["id"])
            break

    return {
        "hypothesis": hypothesis,
        "call_notes": call_notes,
        "demo_plans": demo_plans,
        "expansion_playbook": expansion_playbook,
        "reports": reports,
        "slack_summaries": slack_summaries,
        "precall_briefs": precall_briefs,
        "company_notes": company_notes,
    }


@workflow(name="generate_deal_snapshot")
@app.post("/api/deal-snapshot")
async def generate_deal_snapshot(req: _SnapshotRequest):
    """Generate a concise deal snapshot answering 'what is going on with this deal?'"""
    start = time.perf_counter()
    artifacts = _gather_company_artifacts(req.company_name)

    result = await synthesize_snapshot(
        company_name=req.company_name,
        hypothesis=artifacts["hypothesis"],
        call_notes=artifacts["call_notes"],
        demo_plans=artifacts["demo_plans"],
        expansion_playbook=artifacts["expansion_playbook"],
        reports=artifacts["reports"],
        additional_context=req.additional_context,
        slack_summaries=artifacts["slack_summaries"],
        company_notes=artifacts["company_notes"],
    )

    elapsed_ms = int((time.perf_counter() - start) * 1000)
    logger.info("Generated deal snapshot for '%s' (health=%s) in %d ms",
                req.company_name, result.get("health"), elapsed_ms)
    snapshot_with_time = {**result, "processing_time_ms": elapsed_ms}
    save_snapshot(req.company_name, snapshot_with_time)
    return snapshot_with_time


@app.get("/api/deal-snapshot/cached/{company_name}")
async def get_cached_deal_snapshot(company_name: str):
    """Return the most recent cached deal snapshot for a company, if any."""
    cached = get_latest_snapshot(company_name)
    if not cached:
        return {"found": False}
    return {"found": True, "snapshot": cached}


# ---------------------------------------------------------------------------
# Company Chat
# ---------------------------------------------------------------------------


class _CompanyChatRequest(_BaseModel):
    company_name: str
    message: str
    conversation_id: str | None = None


@workflow(name="company_chat")
@app.post("/api/company-chat")
async def api_company_chat(req: _CompanyChatRequest):
    """Send a message in a company-scoped chat conversation."""
    if not req.message.strip():
        raise HTTPException(status_code=400, detail="Message cannot be empty")
    artifacts = _gather_company_artifacts(req.company_name)
    result = await company_chat_turn(
        company_name=req.company_name,
        user_message=req.message.strip(),
        artifacts=artifacts,
        conversation_id=req.conversation_id,
    )
    return result


@task(name="list_company_chat_conversations")
@app.get("/api/company-chat/conversations")
async def api_list_company_chat_conversations(company_name: str):
    """List chat conversations for a company."""
    conversations = list_company_conversations(company_name)
    return {"conversations": conversations}


@task(name="get_company_chat_conversation")
@app.get("/api/company-chat/conversations/{conversation_id}")
async def api_get_company_chat_conversation(conversation_id: str):
    """Get a full conversation with all messages."""
    conv = get_company_conversation(conversation_id)
    if conv is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conv


@task(name="delete_company_chat_conversation")
@app.delete("/api/company-chat/conversations/{conversation_id}")
async def api_delete_company_chat_conversation(conversation_id: str):
    """Delete a chat conversation."""
    deleted = delete_company_conversation(conversation_id)
    return {"deleted": deleted}


class _DebriefRequest(_BaseModel):
    call_note_id: str
    precall_brief_id: str


@workflow(name="generate_debrief")
@app.post("/api/debrief")
async def generate_debrief(req: _DebriefRequest):
    """Compare a pre-call brief against a call note and produce a structured debrief."""
    call_note = get_call_note(req.call_note_id)
    if call_note is None:
        raise HTTPException(status_code=404, detail="Call note not found")

    precall_brief = get_precall_brief(req.precall_brief_id)
    if precall_brief is None:
        raise HTTPException(status_code=404, detail="Pre-call brief not found")

    start = time.perf_counter()
    result = await synthesize_debrief(
        call_note=call_note,
        precall_brief=precall_brief,
    )
    elapsed_ms = int((time.perf_counter() - start) * 1000)

    logger.info(
        "Generated debrief for call_note=%s vs brief=%s in %d ms",
        req.call_note_id, req.precall_brief_id, elapsed_ms,
    )
    return {**result, "processing_time_ms": elapsed_ms}


# ---------------------------------------------------------------------------
# Release Notes Digest endpoints
# ---------------------------------------------------------------------------


@workflow(name="handle_release_digest")
@app.post("/api/release-digest")
async def handle_release_digest(req: ReleaseDigestRequest) -> ReleaseDigestResponse:
    """Generate a personalized Datadog release notes digest for a specific customer."""
    start = time.perf_counter()
    company_norm = _normalize_company_name(req.company_name).lower()

    # --- Resolve hypothesis ---
    hypothesis: dict | None = find_hypothesis_by_company(req.company_name)
    if req.hypothesis_id and not hypothesis:
        hypothesis = get_hypothesis(req.hypothesis_id)

    # --- Resolve call notes ---
    call_notes: list[dict] = []
    if req.call_note_ids:
        for nid in req.call_note_ids:
            note = get_call_note(nid)
            if note:
                call_notes.append(note)
    else:
        all_notes = list_call_notes()
        matching = [
            n for n in all_notes
            if (
                n.get("company_name", "").lower() == req.company_name.lower()
                or _normalize_company_name(n.get("company_name", "")).lower() == company_norm
            )
        ]
        for n in matching[:3]:
            note = get_call_note(n["id"])
            if note:
                call_notes.append(note)

    # --- Resolve demo plan ---
    demo_plan: dict | None = None
    if req.demo_plan_id:
        demo_plan = get_demo_plan(req.demo_plan_id)
    else:
        plan_summaries = [
            p for p in list_demo_plans()
            if _normalize_company_name(p.company_name).lower() == company_norm
            or p.company_name.lower() == req.company_name.lower()
        ]
        if plan_summaries:
            demo_plan = get_demo_plan(plan_summaries[0].id)

    slack_summaries_rd = list_slack_summaries_for_company(req.company_name)

    digest_data = await synthesize_release_digest(
        company_name=req.company_name,
        hypothesis=hypothesis,
        call_notes=call_notes,
        demo_plan=demo_plan,
        additional_context=req.additional_context,
        max_releases=req.max_releases,
        min_relevance_score=req.min_relevance_score,
        slack_summaries=slack_summaries_rd,
    )

    total_ms = int((time.perf_counter() - start) * 1000)

    from release_digest_models import RelevantRelease
    response = ReleaseDigestResponse(
        company_name=req.company_name,
        headline=digest_data.get("headline", ""),
        intro_paragraph=digest_data.get("intro_paragraph", ""),
        featured_releases=[
            RelevantRelease(**r) for r in digest_data.get("featured_releases", [])
        ],
        other_relevant_releases=[
            RelevantRelease(**r) for r in digest_data.get("other_relevant_releases", [])
        ],
        additional_releases=[
            RelevantRelease(**r) for r in digest_data.get("additional_releases", [])
        ],
        closing_paragraph=digest_data.get("closing_paragraph", ""),
        total_releases_reviewed=digest_data.get("total_releases_reviewed", 0),
        releases_above_threshold=digest_data.get("releases_above_threshold", 0),
        processing_time_ms=total_ms,
    )

    digest_id = save_digest(response)
    response.id = digest_id

    logger.info(
        "Generated release digest %s for '%s' (%d featured, %d total) in %d ms",
        digest_id, req.company_name,
        len(response.featured_releases),
        response.total_releases_reviewed,
        total_ms,
    )
    return response


@task(name="list_release_digests")
@app.get("/api/release-digests")
async def list_release_digests() -> list[ReleaseDigestSummary]:
    return list_digests()


@task(name="get_release_digests_by_company")
@app.get("/api/release-digests/by-company/{company_name}")
async def get_release_digests_by_company(company_name: str):
    digests = find_digests_by_company(company_name)
    return {"digests": digests}


@task(name="get_release_digest_by_id")
@app.get("/api/release-digests/{digest_id}")
async def get_release_digest_by_id(digest_id: str):
    digest = get_digest(digest_id)
    if digest is None:
        return {"error": "Release digest not found"}
    return digest


@task(name="get_release_digest_pdf")
@app.get("/api/release-digests/{digest_id}/pdf")
async def get_release_digest_pdf(digest_id: str):
    digest = get_digest(digest_id)
    if digest is None:
        raise HTTPException(status_code=404, detail="Release digest not found")
    try:
        pdf_path = await generate_digest_pdf_async(digest_id=digest_id, digest=digest)
    except Exception as exc:
        logger.exception("Release digest PDF generation failed for %s", digest_id)
        raise HTTPException(status_code=500, detail=str(exc))
    return FileResponse(
        str(pdf_path),
        media_type="application/pdf",
        filename=f"datadog_update_{digest.get('company_name','digest').lower().replace(' ','_')}_{digest_id}.pdf",
    )


@task(name="delete_release_digest_by_id")
@app.delete("/api/release-digests/{digest_id}")
async def delete_release_digest_by_id(digest_id: str):
    deleted = delete_digest(digest_id)
    return {"deleted": deleted}


# ---------------------------------------------------------------------------
# Slack Channel Summaries endpoints
# ---------------------------------------------------------------------------


class _SlackSummaryCreate(_BaseModel):
    company_name: str
    summary_text: str
    channel_name: str = ""


class _SlackSummaryUpdate(_BaseModel):
    summary_text: str
    channel_name: str | None = None


@task(name="save_slack_summary_endpoint")
@app.post("/api/slack-summaries")
async def save_slack_summary_endpoint(body: _SlackSummaryCreate):
    """Persist a Slack channel summary for a company."""
    if not body.company_name.strip():
        raise HTTPException(status_code=400, detail="company_name is required")
    if not body.summary_text.strip():
        raise HTTPException(status_code=400, detail="summary_text is required")
    record = save_slack_summary(
        company_name=body.company_name,
        summary_text=body.summary_text,
        channel_name=body.channel_name,
    )
    return record


@task(name="get_slack_summaries_by_company")
@app.get("/api/slack-summaries/by-company/{company_name}")
async def get_slack_summaries_by_company(company_name: str):
    """List all Slack summaries for a company, newest first."""
    summaries = list_slack_summaries_for_company(company_name)
    return {"summaries": summaries}


@task(name="update_slack_summary_endpoint")
@app.put("/api/slack-summaries/{record_id}")
async def update_slack_summary_endpoint(record_id: str, body: _SlackSummaryUpdate):
    record = update_slack_summary(
        record_id=record_id,
        summary_text=body.summary_text,
        channel_name=body.channel_name,
    )
    if record is None:
        raise HTTPException(status_code=404, detail="Slack summary not found")
    return record


@task(name="delete_slack_summary_endpoint")
@app.delete("/api/slack-summaries/{record_id}")
async def delete_slack_summary_endpoint(record_id: str):
    deleted = delete_slack_summary(record_id)
    return {"deleted": deleted}


# ---------------------------------------------------------------------------
# Unified dashboard — served from static/
# ---------------------------------------------------------------------------

_STATIC_DIR = Path(__file__).resolve().parent / "static"
app.mount("/static", StaticFiles(directory=str(_STATIC_DIR)), name="static")

@app.get("/", response_class=HTMLResponse)
async def index():
    return (_STATIC_DIR / "index.html").read_text()

@app.get("/demo", response_class=HTMLResponse)
async def demo_page():
    """Serve the unified dashboard with the demo planner tab pre-selected."""
    html = (_STATIC_DIR / "index.html").read_text()
    return html.replace(
        "</body>",
        '<script>location.hash="demo-planner";</script></body>',
    )


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=settings.port, reload=True)
