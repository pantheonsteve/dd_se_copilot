"""Specialized queries to the Librarian agent for product validation and mapping."""

import logging

from config import settings
from models import AgentResponse
from retriever import query_agent

logger = logging.getLogger(__name__)


async def query_librarian_product_validation(
    competitive_tools: list[str],
    strategic_priorities: list[str],
    existing_products: list[str] | None = None,
) -> AgentResponse:
    """Ask the Librarian which Datadog products map to competitive tools and priorities.

    Returns structured product names, SKUs, and capability descriptions.
    """
    existing_clause = ""
    if existing_products:
        existing_clause = (
            f"\n\nIMPORTANT: The customer already uses these Datadog products: "
            f"{', '.join(existing_products)}. Do NOT recommend these unless you are "
            f"describing how to expand them to a new team or business unit. Focus on "
            f"products they do NOT currently have."
        )

    question = (
        "I need precise Datadog product recommendations for an account expansion. "
        "For each recommendation, return the EXACT Datadog product name (not category "
        "names or colloquial shorthand), the SKU or tier if applicable, and 2-3 specific "
        "capabilities relevant to this context.\n\n"
        f"Competitive tools detected in the account: {', '.join(competitive_tools) if competitive_tools else 'None identified'}\n\n"
        f"Company strategic priorities: {', '.join(strategic_priorities) if strategic_priorities else 'None identified'}\n\n"
        "For each competitive tool, specify which Datadog product replaces it and "
        "which specific capabilities map to that tool's functionality. Be precise — "
        "for example, say 'Cloud SIEM' not 'Datadog SIEM', say 'Cloud Security "
        "Management Enterprise' if the Enterprise tier is needed, say 'Observability "
        "Pipelines Worker' not just 'Observability Pipelines'.\n\n"
        "If a product has tiers (e.g., Pro vs Enterprise), specify which tier and why."
        f"{existing_clause}"
    )

    return await query_agent(
        settings.technical_agent_url, question, timeout=60
    )


async def query_librarian_product_list() -> AgentResponse:
    """Fetch the canonical list of Datadog products for UI population."""
    question = (
        "List every current Datadog product by its official product name. "
        "Group them by category (Observability, Security, Digital Experience, "
        "Software Delivery, Service Management, AI, Platform). "
        "For each product, give the exact official name only — no descriptions. "
        "If a product has tiers or editions, list the base product name only."
    )
    return await query_agent(
        settings.technical_agent_url, question, timeout=45
    )


async def query_librarian_displacement_mapping(
    competitive_tool: str,
    existing_products: list[str] | None = None,
) -> AgentResponse:
    """Ask which Datadog product specifically replaces a given competitive tool."""
    existing_clause = ""
    if existing_products:
        existing_clause = (
            f" The customer already uses: {', '.join(existing_products)}."
        )

    question = (
        f"What specific Datadog product(s) replace or compete with {competitive_tool}? "
        f"Return the exact Datadog product name, not a category. Describe which "
        f"specific capabilities of {competitive_tool} each Datadog product covers. "
        f"If multiple Datadog products are needed to fully replace {competitive_tool}, "
        f"list all of them with their specific roles.{existing_clause}"
    )
    return await query_agent(
        settings.technical_agent_url, question, timeout=45
    )
