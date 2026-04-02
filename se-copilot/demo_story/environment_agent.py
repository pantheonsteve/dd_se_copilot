"""Demo Environment Agent — queries the Datadog MCP Server for live demo org data.

For each demo scenario the agent runs:
1. A fixed set of **cross-cutting queries** (services, dashboards, monitors, hosts,
   events) that apply to every scenario.
2. A **scenario-specific** set of MCP tool calls (e.g. spans/traces for APM, logs for
   Log Management, RUM events for Digital Experience).

Results are normalised into ``AgentResponse`` objects so the synthesizer can consume
them alongside RAG agent outputs.
"""

from __future__ import annotations

import logging
from typing import Any

from ddtrace.llmobs.decorators import workflow

from config import settings
from models import AgentResponse

from .mcp_client import call_tools_parallel, mcp_session
from .models import DemoScenario, MCPToolCall

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Cross-cutting queries — run for every scenario
# ---------------------------------------------------------------------------

CROSS_CUTTING_CALLS: list[tuple[str, dict[str, Any]]] = [
    (
        "search_datadog_services",
        {"telemetry": {"intent": "List all services in the demo environment for demo talk track context"}},
    ),
    (
        "search_datadog_dashboards",
        {"telemetry": {"intent": "List all available dashboards so SE can navigate by name"}},
    ),
    (
        "search_datadog_monitors",
        {"telemetry": {"intent": "List monitors with current state to find any alerting monitors for live story"}},
    ),
    (
        "search_datadog_hosts",
        {
            "query": "SELECT hostname, cloud_provider, resource_type, os, instance_type FROM hosts LIMIT 100",
            "telemetry": {"intent": "Show all hosts by cloud provider to quantify environment scale"},
        },
    ),
    (
        "search_datadog_events",
        {
            "query": "*",
            "from": "now-48h",
            "telemetry": {"intent": "Find recent events (deploys, config changes) for correlation points in any demo"},
        },
    ),
]

# ---------------------------------------------------------------------------
# Scenario-specific queries
# ---------------------------------------------------------------------------


def _apm_calls() -> list[tuple[str, dict[str, Any]]]:
    return [
        (
            "search_datadog_spans",
            {
                "query": "status:error",
                "from": "now-1h",
                "telemetry": {"intent": "Find recent error spans the SE can click into during the demo"},
            },
        ),
        (
            "get_datadog_metric",
            {
                "queries": ["avg:trace.http.request.duration{*} by {service}"],
                "from": "now-1h",
                "telemetry": {"intent": "Get trace latency metrics to give SE concrete p99/avg numbers"},
            },
        ),
        (
            "search_datadog_dashboards",
            {
                "query": "title:APM OR title:tracing OR title:service",
                "telemetry": {"intent": "Find APM-related dashboards for direct navigation"},
            },
        ),
    ]


def _log_management_calls() -> list[tuple[str, dict[str, Any]]]:
    return [
        (
            "search_datadog_logs",
            {
                "query": "status:error",
                "from": "now-1h",
                "max_tokens": 5000,
                "telemetry": {"intent": "Show sample error logs with full context for the demo"},
            },
        ),
        (
            "analyze_datadog_logs",
            {
                "sql_query": "SELECT service, count(*) FROM logs WHERE status = 'error' GROUP BY service ORDER BY count(*) DESC",
                "from": "now-24h",
                "telemetry": {"intent": "Count error logs by service to demonstrate analytics capabilities"},
            },
        ),
        (
            "search_datadog_monitors",
            {
                "query": "title:log OR title:Log",
                "telemetry": {"intent": "Find log-based monitors to show proactive alerting on log patterns"},
            },
        ),
        (
            "search_datadog_dashboards",
            {
                "query": "title:log OR title:pipeline",
                "telemetry": {"intent": "Find log analytics dashboards for direct navigation"},
            },
        ),
    ]


def _infrastructure_calls() -> list[tuple[str, dict[str, Any]]]:
    return [
        (
            "get_datadog_metric",
            {
                "queries": ["avg:system.cpu.user{*} by {host}"],
                "from": "now-4h",
                "telemetry": {"intent": "Get CPU metrics by host to point to hosts with interesting patterns"},
            },
        ),
        (
            "get_datadog_metric",
            {
                "queries": ["avg:system.mem.used{*} by {host}"],
                "from": "now-4h",
                "telemetry": {"intent": "Get memory metrics by host to identify resource pressure"},
            },
        ),
        (
            "search_datadog_monitors",
            {
                "query": "status:alert OR status:warn",
                "telemetry": {"intent": "Find currently alerting monitors for a live troubleshooting narrative"},
            },
        ),
        (
            "search_datadog_events",
            {
                "query": "*",
                "from": "now-24h",
                "telemetry": {"intent": "Find infrastructure change events for metric overlay correlation"},
            },
        ),
        (
            "search_datadog_dashboards",
            {
                "query": "title:infrastructure OR title:host OR title:kubernetes OR title:AWS",
                "telemetry": {"intent": "Find infrastructure dashboards for direct navigation"},
            },
        ),
    ]


def _security_calls() -> list[tuple[str, dict[str, Any]]]:
    return [
        (
            "search_datadog_monitors",
            {
                "query": "title:security OR title:SIEM OR title:CSPM",
                "telemetry": {"intent": "Find security-related monitors and detection rules"},
            },
        ),
        (
            "search_datadog_dashboards",
            {
                "query": "title:security OR title:compliance OR title:CSPM",
                "telemetry": {"intent": "Find security dashboards for direct navigation during demo"},
            },
        ),
    ]


def _digital_experience_calls() -> list[tuple[str, dict[str, Any]]]:
    return [
        (
            "search_datadog_rum_events",
            {
                "query": "@type:view @view.loading_time:>3000",
                "from": "now-1h",
                "telemetry": {"intent": "Find slow page loads to show real user performance data"},
            },
        ),
        (
            "search_datadog_rum_events",
            {
                "query": "@type:error",
                "from": "now-1h",
                "telemetry": {"intent": "Find RUM errors to demonstrate error tracking from user perspective"},
            },
        ),
        (
            "search_datadog_monitors",
            {
                "query": "title:RUM OR title:Synthetics OR title:frontend",
                "telemetry": {"intent": "Find frontend monitoring monitors for proactive alerting demo"},
            },
        ),
    ]


def _incident_management_calls() -> list[tuple[str, dict[str, Any]]]:
    return [
        (
            "search_datadog_incidents",
            {
                "query": "state:(active OR stable)",
                "telemetry": {"intent": "Show active incidents for a live incident response narrative"},
            },
        ),
        (
            "search_datadog_incidents",
            {
                "query": "state:resolved",
                "from": "now-7d",
                "telemetry": {"intent": "Show recently resolved incidents for post-incident review walkthrough"},
            },
        ),
        (
            "search_datadog_logs",
            {
                "query": "status:error",
                "from": "now-4h",
                "max_tokens": 3000,
                "telemetry": {"intent": "Show error logs that would be used during incident triage"},
            },
        ),
        (
            "search_datadog_dashboards",
            {
                "query": "title:incident OR title:SRE OR title:on-call",
                "telemetry": {"intent": "Find incident response dashboards for direct navigation"},
            },
        ),
    ]


_SCENARIO_CALLS: dict[DemoScenario, list[tuple[str, dict[str, Any]]]] = {
    DemoScenario.APM: _apm_calls(),
    DemoScenario.LOG_MANAGEMENT: _log_management_calls(),
    DemoScenario.INFRASTRUCTURE: _infrastructure_calls(),
    DemoScenario.SECURITY: _security_calls(),
    DemoScenario.DIGITAL_EXPERIENCE: _digital_experience_calls(),
    DemoScenario.INCIDENT_MANAGEMENT: _incident_management_calls(),
}

# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def _format_results_as_text(results: dict[str, dict[str, Any]]) -> str:
    """Collapse all MCP tool results into a single text block for the synthesizer."""
    sections: list[str] = []
    for key, result in results.items():
        if result.get("error"):
            sections.append(f"[{key}] Unavailable — {result['error']}")
        elif result.get("content"):
            sections.append(f"[{key}]\n{result['content']}")
    return "\n\n".join(sections) if sections else "No environment data retrieved."


@workflow(name="query_demo_environment")
async def query_demo_environment(
    scenario: DemoScenario | None,
    mcp_queries: list[MCPToolCall] | None = None,
) -> AgentResponse:
    """Query the Datadog demo environment via MCP and return a unified AgentResponse.

    Falls back gracefully if the MCP server is unreachable or credentials are missing.
    """
    if not settings.datadog_api_key or not settings.datadog_app_key:
        return AgentResponse(
            error="Datadog MCP credentials not configured (DATADOG_API_KEY / DATADOG_APP_KEY)"
        )

    scenario = scenario or DemoScenario.APM

    calls: list[tuple[str, dict[str, Any]]] = list(CROSS_CUTTING_CALLS)
    calls.extend(_SCENARIO_CALLS.get(scenario, []))

    if mcp_queries:
        for q in mcp_queries:
            calls.append((q.tool_name, q.arguments))

    try:
        async with mcp_session() as session:
            results = await call_tools_parallel(session, calls)

        successes = [k for k, r in results.items() if not r.get("error")]
        failures = [k for k, r in results.items() if r.get("error")]
        logger.info(
            "MCP calls complete: %d succeeded (%s), %d failed (%s)",
            len(successes), ", ".join(successes),
            len(failures), ", ".join(failures),
        )
        for k in failures:
            logger.warning("MCP call '%s' error: %s", k, results[k].get("error", "")[:200])

        text = _format_results_as_text(results)
        tool_names_used = successes

        return AgentResponse(
            answer=text,
            sources=[f"mcp:{name}" for name in tool_names_used],
        )

    except Exception as exc:
        logger.error("Demo environment agent failed: %s", exc, exc_info=True)
        return AgentResponse(
            error=f"Demo environment agent unavailable: {exc}"
        )
