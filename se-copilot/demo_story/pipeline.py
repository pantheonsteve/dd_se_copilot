"""Top-level pipeline that wires orchestration, retrieval, and synthesis together."""

import logging
import re
import time

from ddtrace.llmobs.decorators import workflow

from hypothesis_store import find_hypothesis_by_company
from report_store import get_report

from .data import PERSONA_DEFAULTS
from .models import DemoFormInput, DemoFromReportInput, DemoPlanResponse, DemoSourcesUsed
from .orchestrator import generate_context_plan
from .pdf import generate_pdf
from .retriever import retrieve_demo_context
from .store import save_demo_plan, update_pdf_path
from .synthesizer import synthesize_demo_plan

logger = logging.getLogger(__name__)


def _extract_company_name(title: str | None, query: str) -> str:
    """Best-effort extraction of company name from report title or query."""
    if title:
        # Titles like "HomeServe - Strategic Overview" or "Acme Corp Strategic Overview"
        for sep in (" - ", " — ", " – ", " | "):
            if sep in title:
                return title.split(sep)[0].strip()
        cleaned = re.sub(
            r"\s*(Strategic Overview|Executive Report|Report).*$",
            "",
            title,
            flags=re.IGNORECASE,
        ).strip()
        if cleaned:
            return cleaned

    match = re.search(
        r"(?:overview\s+(?:for|of)\s+|overview[:\s]+)([A-Z][\w\s&.,'-]+?)(?:\s*\(|\s*,|\s*mapping)",
        query,
        re.IGNORECASE,
    )
    if match:
        return match.group(1).strip()

    return title or "Unknown Company"


@workflow(name="generate_demo_plan")
async def generate_demo_plan(form_input: DemoFormInput) -> DemoPlanResponse:
    """Run the full Demo Story Agent pipeline.

    1. Orchestrator — generate context plan (queries + product mapping)
    2. Retrieval  — call Librarian / Value / SEC EDGAR agents in parallel
    3. Synthesis  — generate the structured markdown demo plan
    """
    start = time.perf_counter()
    timings: dict[str, int] = {}

    # --- Step 1: Orchestrator ---
    t0 = time.perf_counter()
    context_plan = await generate_context_plan(form_input)
    timings["orchestrator"] = int((time.perf_counter() - t0) * 1000)
    logger.info(
        "Demo orchestrator completed",
        extra={
            "company": form_input.company_name,
            "mode": form_input.demo_mode.value,
            "librarian_queries": len(context_plan.librarian_queries),
            "value_queries": len(context_plan.value_queries),
            "edgar_queries": len(context_plan.edgar_queries),
            "elapsed_ms": timings["orchestrator"],
        },
    )

    # --- Step 2: Parallel agent retrieval ---
    t0 = time.perf_counter()

    sec_ticker = form_input.company_name if form_input.is_public_company else None

    agent_results = await retrieve_demo_context(
        context_plan,
        is_public_company=form_input.is_public_company,
        sec_ticker=sec_ticker,
    )
    timings["retrieval"] = int((time.perf_counter() - t0) * 1000)
    logger.info("Demo retrieval completed", extra={"elapsed_ms": timings["retrieval"]})

    # --- Step 3: Synthesis ---
    t0 = time.perf_counter()
    demo_plan_md = await synthesize_demo_plan(form_input, context_plan, agent_results)
    timings["synthesis"] = int((time.perf_counter() - t0) * 1000)
    logger.info("Demo synthesis completed", extra={"elapsed_ms": timings["synthesis"]})

    # Collect sources
    sources = DemoSourcesUsed(
        librarian=[
            src
            for resp in agent_results.get("librarian", [])
            for src in resp.sources
        ],
        value=[
            src
            for resp in agent_results.get("value", [])
            for src in resp.sources
        ],
        sec_filings=[
            src
            for resp in agent_results.get("sec_filings", [])
            for src in resp.sources
        ],
        demo_environment=[
            src
            for resp in agent_results.get("demo_environment", [])
            for src in resp.sources
        ],
    )

    total_ms = int((time.perf_counter() - start) * 1000)

    response = DemoPlanResponse(
        demo_plan=demo_plan_md,
        context_plan=context_plan,
        sources_used=sources,
        stage_timings_ms=timings,
        processing_time_ms=total_ms,
    )

    # --- Auto-save: persist plan + loops, then generate PDF ---
    try:
        plan_id = save_demo_plan(form_input, response)
        response.plan_id = plan_id

        persona_data = PERSONA_DEFAULTS.get(form_input.persona.value, {})
        persona_title = persona_data.get(
            "title", form_input.persona.value.replace("_", " ").title()
        )
        pdf_path = generate_pdf(
            plan_id=plan_id,
            markdown_text=demo_plan_md,
            company_name=form_input.company_name,
            persona_title=persona_title,
            demo_mode=form_input.demo_mode.value,
        )
        update_pdf_path(plan_id, str(pdf_path))
        response.pdf_path = str(pdf_path)
        logger.info("Demo plan auto-saved: %s", plan_id)
    except Exception:
        logger.exception("Failed to auto-save demo plan")

    return response


@workflow(name="generate_demo_plan_from_report")
async def generate_demo_plan_from_report(
    req: DemoFromReportInput,
) -> DemoPlanResponse:
    """Build a DemoFormInput from a saved strategy report and run the pipeline."""
    report = get_report(req.report_id)
    if report is None:
        raise ValueError(f"Report not found: {req.report_id}")

    resp = report.response
    company_name = _extract_company_name(report.title, resp.query)

    has_sec = bool(resp.sources.sec_filings)

    pain_parts: list[str] = []
    if resp.content_gaps:
        pain_parts.append("Content gaps: " + "; ".join(resp.content_gaps))
    if resp.discovery_questions:
        pain_parts.append(
            "Discovery questions: " + "; ".join(resp.discovery_questions)
        )

    discovery_parts: list[str] = []
    if resp.synthesized_answer:
        discovery_parts.append(resp.synthesized_answer)
    if resp.talk_track:
        discovery_parts.append(f"Talk track: {resp.talk_track}")
    if req.additional_context:
        discovery_parts.append(f"Additional SE context: {req.additional_context}")

    # Enrich with hypothesis intelligence if one exists for this company
    incumbent = req.incumbent_tooling
    hyp = find_hypothesis_by_company(company_name)
    if hyp:
        rs = hyp.get("research_summary", {})
        hyp_parts: list[str] = []

        targets = rs.get("competitive_displacement_targets", [])
        _enrichment_fields = [
            ("current_observability_tools", "Current observability tools"),
            ("current_cloud_platforms", "Cloud platforms"),
            ("current_infrastructure", "Infrastructure"),
            ("current_databases", "Databases"),
            ("current_message_queues", "Message queues / streaming"),
            ("current_languages", "Languages / frameworks"),
            ("current_data_platforms", "Data platforms"),
            ("current_cicd_tools", "CI/CD tools"),
            ("current_feature_flags", "Feature flags"),
            ("current_serverless", "Serverless"),
            ("current_networking", "Networking / CDN"),
            ("competitive_displacement_targets", "Competitive displacement targets"),
            ("key_hiring_themes", "Key hiring themes"),
        ]
        for key, label in _enrichment_fields:
            if rs.get(key):
                hyp_parts.append(f"{label}: {', '.join(rs[key])}")
        if rs.get("hiring_velocity"):
            hyp_parts.append(f"Hiring velocity: {rs['hiring_velocity']}")
        entry = rs.get("recommended_entry_persona", {})
        if entry.get("title"):
            hyp_parts.append(f"Recommended entry persona: {entry['title']}")

        if hyp_parts:
            discovery_parts.append(
                "COMPANY TECHNOLOGY INTELLIGENCE (from Sales Hypothesis):\n"
                + "\n".join(hyp_parts)
            )
        if targets and not incumbent:
            incumbent = ", ".join(targets)

        logger.info(
            "Enriched demo plan with hypothesis data for %s (hyp_id=%s)",
            company_name,
            hyp.get("id"),
        )

    form_input = DemoFormInput(
        demo_mode=req.demo_mode,
        persona=req.persona,
        company_name=company_name,
        is_public_company=has_sec,
        selected_products=req.selected_products,
        customer_pain_points="\n".join(pain_parts),
        discovery_notes="\n\n".join(discovery_parts),
        incumbent_tooling=incumbent,
        evaluation_reason=f"Generated from strategy report: {report.title or req.report_id}",
    )

    logger.info(
        "Building demo plan from report %s for %s",
        req.report_id,
        company_name,
    )
    return await generate_demo_plan(form_input)
