"""Synthesis: assembles agent context and generates the final demo plan via Claude."""

import logging

import anthropic

from ddtrace.llmobs import LLMObs
from ddtrace.llmobs.decorators import llm

from anthropic_helpers import extract_text
from config import settings
from models import AgentResponse

from .data import PERSONA_DEFAULTS
from .models import DemoContextPlan, DemoFormInput
from .prompts import MODE_PROMPTS, SYNTHESIS_SYSTEM_PROMPT

logger = logging.getLogger(__name__)


def _format_agent_results(
    agent_type: str,
    responses: list[AgentResponse],
) -> str:
    """Combine multiple agent responses for one agent type into a single text block."""
    if not responses:
        return f"{agent_type}: Not queried for this request."

    sections: list[str] = []
    for i, resp in enumerate(responses, 1):
        if resp.error:
            sections.append(f"  Query {i}: Unavailable — {resp.error}")
        elif not resp.answer:
            sections.append(f"  Query {i}: No relevant documents found.")
        else:
            src_lines = ", ".join(resp.sources) if resp.sources else "none"
            sections.append(f"  Query {i}:\n{resp.answer}\n  Sources: {src_lines}")

    return f"{agent_type}:\n" + "\n\n".join(sections)


def _build_user_message(
    form_input: DemoFormInput,
    context_plan: DemoContextPlan,
    agent_results: dict[str, list[AgentResponse]],
) -> str:
    """Assemble the full user message for the synthesis LLM call."""
    persona_data = PERSONA_DEFAULTS.get(form_input.persona.value, {})

    parts: list[str] = []

    # Persona context
    pc = context_plan.persona_context
    parts.append("## PERSONA CONTEXT")
    parts.append(f"Role: {persona_data.get('title', form_input.persona.value)}")
    parts.append(f"KPIs: {', '.join(persona_data.get('kpis', []))}")
    parts.append(f"Pain Points (priority order): {', '.join(pc.combined_pain_priority)}")
    parts.append(f"Demo Emphasis: {persona_data.get('demo_emphasis', 'general')}")

    # Company intelligence
    parts.append("\n## COMPANY INTELLIGENCE")
    parts.append(f"Company: {form_input.company_name}")
    parts.append(f"Public Company: {form_input.is_public_company}")
    sec_results = _format_agent_results(
        "SEC 10-K FILINGS", agent_results.get("sec_filings", [])
    )
    parts.append(sec_results)

    # Product context from Librarian
    parts.append("\n## PRODUCT CONTEXT (from Datadog documentation)")
    lib_results = _format_agent_results(
        "LIBRARIAN", agent_results.get("librarian", [])
    )
    parts.append(lib_results)

    # Value context
    parts.append("\n## VALUE CONTEXT (case studies, ROI, customer stories)")
    val_results = _format_agent_results(
        "VALUE", agent_results.get("value", [])
    )
    parts.append(val_results)

    # Demo mode
    parts.append(f"\n## DEMO MODE: {form_input.demo_mode.value}")

    # Product mapping
    pm = context_plan.product_mapping
    parts.append(f"\n## PRODUCT MAPPING")
    parts.append(f"Primary Products: {', '.join(pm.primary_products)}")
    parts.append(f"Supporting Products: {', '.join(pm.supporting_products)}")
    parts.append(f"Rationale: {pm.mapping_rationale}")
    parts.append(f"Narrative Angle: {context_plan.narrative_angle}")

    # Demo environment context (live data from demo org via MCP)
    env_responses = agent_results.get("demo_environment", [])
    if env_responses and any(r.answer for r in env_responses):
        parts.append("\n## DEMO ENVIRONMENT CONTEXT (live data from the demo Datadog org)")
        parts.append(
            "The following data comes from the actual demo environment. Use real service "
            "names, dashboard titles, metric values, monitor states, trace IDs, and host "
            "details to make the talk track concrete. Reference these specifics in the SHOW "
            "sections so the SE knows exactly what they will see on screen."
        )
        env_results = _format_agent_results(
            "DEMO ENVIRONMENT", env_responses
        )
        parts.append(env_results)
    else:
        parts.append("\n## DEMO ENVIRONMENT CONTEXT")
        env_note = "Not available for this request."
        if env_responses and env_responses[0].error:
            env_note += f" ({env_responses[0].error})"
        parts.append(env_note)
        parts.append(
            "Use realistic but generic references. Do NOT fabricate specific service "
            "names, metric values, or trace IDs."
        )

    # Raw inputs
    parts.append("\n## RAW INPUTS")
    if form_input.customer_pain_points:
        parts.append(f"Customer Pain Points: {form_input.customer_pain_points}")
    if form_input.discovery_notes:
        parts.append(f"Discovery Notes: {form_input.discovery_notes}")
    if form_input.incumbent_tooling:
        parts.append(f"Incumbent Tooling: {form_input.incumbent_tooling}")
    if form_input.evaluation_reason:
        parts.append(f"Evaluation Reason: {form_input.evaluation_reason}")
    if form_input.selected_products:
        parts.append(f"SE-Selected Products: {', '.join(form_input.selected_products)}")

    return "\n".join(parts)


@llm(model_name=settings.claude_model, name="synthesize_demo_plan", model_provider="anthropic")
async def synthesize_demo_plan(
    form_input: DemoFormInput,
    context_plan: DemoContextPlan,
    agent_results: dict[str, list[AgentResponse]],
) -> str:
    """Call Claude with assembled context to generate the final structured demo plan."""
    mode_instructions = MODE_PROMPTS.get(form_input.demo_mode.value, "")
    system_prompt = SYNTHESIS_SYSTEM_PROMPT + "\n\n" + mode_instructions

    user_message = _build_user_message(form_input, context_plan, agent_results)

    client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)

    try:
        response = await client.messages.create(
            model=settings.claude_model,
            max_tokens=8192,
            temperature=0.4,
            system=system_prompt,
            messages=[{"role": "user", "content": user_message}],
        )

        LLMObs.annotate(
            input_data=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_message},
            ],
            output_data=[{"role": "assistant", "content": extract_text(response)}],
            metadata={"temperature": 0.4, "max_tokens": 8192, "demo_mode": form_input.demo_mode.value},
            metrics={
                "input_tokens": response.usage.input_tokens,
                "output_tokens": response.usage.output_tokens,
                "total_tokens": response.usage.input_tokens + response.usage.output_tokens,
            },
        )

        return extract_text(response)

    except Exception as exc:
        logger.error("Demo plan synthesis failed: %s", exc)
        return (
            f"# Demo Plan Generation Failed\n\n"
            f"An error occurred during synthesis: {exc}\n\n"
            f"## Context Plan Summary\n\n"
            f"**Company:** {form_input.company_name}\n"
            f"**Persona:** {form_input.persona.value}\n"
            f"**Mode:** {form_input.demo_mode.value}\n"
            f"**Narrative Angle:** {context_plan.narrative_angle}\n"
        )
