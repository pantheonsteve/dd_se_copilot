"""Orchestrator: generates a context plan from form inputs via Claude."""

import json
import logging
import re

import anthropic

from ddtrace.llmobs import LLMObs
from ddtrace.llmobs.decorators import llm

from anthropic_helpers import extract_text
from config import settings

from .data import PAIN_TO_PRODUCT_MAP, PERSONA_DEFAULTS
from .models import (
    AgentQuery,
    DemoContextPlan,
    DemoFormInput,
    DemoScenario,
    MCPToolCall,
    PersonaContext,
    ProductMapping,
)
from .prompts import ORCHESTRATOR_SYSTEM_PROMPT

logger = logging.getLogger(__name__)

_FENCE_RE = re.compile(r"^```(?:json)?\s*\n(.*?)\n```\s*$", re.DOTALL)


def _strip_fences(text: str) -> str:
    m = _FENCE_RE.match(text.strip())
    return m.group(1).strip() if m else text.strip()


def _format_form_input(form: DemoFormInput) -> str:
    """Build the user message sent to the orchestrator LLM."""
    persona_data = PERSONA_DEFAULTS.get(form.persona.value, {})

    lines = [
        f"DEMO MODE: {form.demo_mode.value}",
        f"PERSONA: {form.persona.value}",
        f"COMPANY NAME: {form.company_name}",
        f"IS PUBLIC COMPANY: {form.is_public_company}",
    ]

    if form.selected_products:
        lines.append(f"SELECTED PRODUCTS: {', '.join(form.selected_products)}")
    if form.customer_pain_points:
        lines.append(f"CUSTOMER PAIN POINTS: {form.customer_pain_points}")
    if form.discovery_notes:
        lines.append(f"DISCOVERY NOTES: {form.discovery_notes}")
    if form.incumbent_tooling:
        lines.append(f"INCUMBENT TOOLING: {form.incumbent_tooling}")
    if form.evaluation_reason:
        lines.append(f"EVALUATION REASON: {form.evaluation_reason}")

    lines.append("")
    lines.append("--- PERSONA DEFAULTS ---")
    lines.append(json.dumps(persona_data, indent=2))

    lines.append("")
    lines.append("--- PRODUCT-TO-PAIN MAPPING ---")
    lines.append(json.dumps(PAIN_TO_PRODUCT_MAP, indent=2))

    return "\n".join(lines)


def _parse_context_plan(data: dict) -> DemoContextPlan:
    """Parse the LLM JSON response into a DemoContextPlan, tolerating nested wrapper keys."""
    plan_data = data.get("context_plan", data)

    persona_raw = plan_data.get("persona_context", {})
    persona_ctx = PersonaContext(
        persona_key=persona_raw.get("persona_key", ""),
        default_pain_points=persona_raw.get("default_pain_points", []),
        customer_specific_pains=persona_raw.get("customer_specific_pains", []),
        combined_pain_priority=persona_raw.get("combined_pain_priority", []),
    )

    librarian_queries = [
        AgentQuery(**q) for q in plan_data.get("librarian_queries", [])
    ]
    value_queries = [
        AgentQuery(**q) for q in plan_data.get("value_queries", [])
    ]
    edgar_queries = [
        AgentQuery(**q) for q in plan_data.get("edgar_queries", [])
    ]

    pm_raw = plan_data.get("product_mapping", {})
    product_mapping = ProductMapping(
        primary_products=pm_raw.get("primary_products", []),
        supporting_products=pm_raw.get("supporting_products", []),
        mapping_rationale=pm_raw.get("mapping_rationale", ""),
    )

    scenario_raw = plan_data.get("demo_scenario", "")
    demo_scenario: DemoScenario | None = None
    if scenario_raw:
        try:
            demo_scenario = DemoScenario(scenario_raw)
        except ValueError:
            logger.debug("Unknown demo_scenario from LLM: %s", scenario_raw)

    mcp_queries = [
        MCPToolCall(**q) for q in plan_data.get("mcp_queries", [])
    ]

    return DemoContextPlan(
        persona_context=persona_ctx,
        librarian_queries=librarian_queries,
        value_queries=value_queries,
        edgar_queries=edgar_queries,
        product_mapping=product_mapping,
        narrative_angle=plan_data.get("narrative_angle", ""),
        demo_scenario=demo_scenario,
        mcp_queries=mcp_queries,
    )


_PRODUCT_TO_SCENARIO: dict[str, DemoScenario] = {
    "apm": DemoScenario.APM,
    "tracing": DemoScenario.APM,
    "distributed tracing": DemoScenario.APM,
    "log management": DemoScenario.LOG_MANAGEMENT,
    "logs": DemoScenario.LOG_MANAGEMENT,
    "infrastructure": DemoScenario.INFRASTRUCTURE,
    "infrastructure monitoring": DemoScenario.INFRASTRUCTURE,
    "security": DemoScenario.SECURITY,
    "cloud security": DemoScenario.SECURITY,
    "cspm": DemoScenario.SECURITY,
    "rum": DemoScenario.DIGITAL_EXPERIENCE,
    "real user monitoring": DemoScenario.DIGITAL_EXPERIENCE,
    "synthetics": DemoScenario.DIGITAL_EXPERIENCE,
    "digital experience": DemoScenario.DIGITAL_EXPERIENCE,
    "incident management": DemoScenario.INCIDENT_MANAGEMENT,
    "incidents": DemoScenario.INCIDENT_MANAGEMENT,
    "on-call": DemoScenario.INCIDENT_MANAGEMENT,
}


def _infer_scenario(form: DemoFormInput) -> DemoScenario | None:
    """Best-effort scenario inference from selected products when the LLM doesn't classify."""
    if form.demo_scenario:
        return form.demo_scenario
    for product in form.selected_products:
        key = product.strip().lower()
        if key in _PRODUCT_TO_SCENARIO:
            return _PRODUCT_TO_SCENARIO[key]
    return None


def _build_fallback_plan(form: DemoFormInput) -> DemoContextPlan:
    """Produce a minimal context plan when the LLM call fails."""
    persona_data = PERSONA_DEFAULTS.get(form.persona.value, {})
    pains = persona_data.get("default_pains", [])

    return DemoContextPlan(
        persona_context=PersonaContext(
            persona_key=form.persona.value,
            default_pain_points=pains,
            combined_pain_priority=pains[:5],
        ),
        librarian_queries=[
            AgentQuery(
                query=f"Datadog capabilities for {form.persona.value} use cases",
                purpose="General product context",
            )
        ],
        value_queries=[
            AgentQuery(
                query=f"Datadog customer stories for {persona_data.get('title', form.persona.value)}",
                purpose="General value context",
            )
        ],
        edgar_queries=(
            [AgentQuery(
                query=f"Strategic technology initiatives and risk factors for {form.company_name}",
                purpose="Company strategic context",
            )]
            if form.is_public_company
            else []
        ),
        narrative_angle=f"Address core {persona_data.get('title', 'persona')} pain points for {form.company_name}",
        demo_scenario=_infer_scenario(form),
    )


@llm(model_name=settings.claude_model, name="generate_context_plan", model_provider="anthropic")
async def generate_context_plan(form_input: DemoFormInput) -> DemoContextPlan:
    """Call Claude to generate a structured context plan from form inputs."""
    client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)
    user_message = _format_form_input(form_input)

    try:
        response = await client.messages.create(
            model=settings.claude_model,
            max_tokens=4096,
            temperature=0.3,
            system=ORCHESTRATOR_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_message}],
        )

        LLMObs.annotate(
            input_data=[
                {"role": "system", "content": ORCHESTRATOR_SYSTEM_PROMPT},
                {"role": "user", "content": user_message},
            ],
            output_data=[{"role": "assistant", "content": extract_text(response)}],
            metadata={"temperature": 0.3, "max_tokens": 4096},
            metrics={
                "input_tokens": response.usage.input_tokens,
                "output_tokens": response.usage.output_tokens,
                "total_tokens": response.usage.input_tokens + response.usage.output_tokens,
            },
        )

        raw = _strip_fences(extract_text(response))
        data = json.loads(raw)
        return _parse_context_plan(data)

    except (json.JSONDecodeError, KeyError, ValueError) as exc:
        logger.warning("Orchestrator JSON parsing failed, using fallback: %s", exc)
        return _build_fallback_plan(form_input)
    except Exception as exc:
        logger.error("Orchestrator LLM call failed: %s", exc)
        return _build_fallback_plan(form_input)
