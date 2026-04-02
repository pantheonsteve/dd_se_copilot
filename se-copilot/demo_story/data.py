"""Static persona defaults and product-to-pain mappings for demo story generation."""

PERSONA_DEFAULTS: dict[str, dict] = {
    "vp_engineering": {
        "title": "VP of Engineering / Head of Engineering",
        "default_pains": [
            "High MTTR impacting customer experience and SLAs",
            "Lack of visibility into system reliability across the full stack",
            "Too many tools creating fragmented observability and high operational overhead",
            "Difficulty quantifying engineering productivity and operational efficiency",
            "Scaling observability as the platform grows without proportional headcount growth",
        ],
        "kpis": [
            "MTTR",
            "System uptime / SLA compliance",
            "Engineering velocity",
            "Operational cost per service",
            "Incident frequency",
        ],
        "demo_emphasis": "executive_outcomes",
    },
    "platform_engineer": {
        "title": "Platform Engineer / Infrastructure Engineer",
        "default_pains": [
            "Manual toil in provisioning and maintaining monitoring for new services",
            "Inconsistent observability coverage across teams and services",
            "Alert fatigue from poorly tuned or redundant alerting rules",
            "Lack of self-service observability for development teams",
            "Difficulty maintaining monitoring-as-code across environments",
        ],
        "kpis": [
            "Onboarding time for new services",
            "Coverage percentage",
            "Alert noise ratio",
            "Developer self-service adoption",
            "Toil hours reduced",
        ],
        "demo_emphasis": "operational_workflow",
    },
    "sre_devops": {
        "title": "SRE / DevOps Engineer",
        "default_pains": [
            "Slow root cause identification during incidents (high MTTR)",
            "Alert fatigue — too many alerts, not enough signal",
            "Context switching between multiple tools during incident response",
            "Lack of correlation between metrics, traces, and logs",
            "On-call burnout due to manual investigation and runbook execution",
        ],
        "kpis": [
            "MTTR",
            "MTTD",
            "Alert-to-resolution time",
            "On-call incident volume",
            "SLO compliance",
        ],
        "demo_emphasis": "incident_workflow",
    },
    "security_engineer": {
        "title": "Security Engineer / SecOps",
        "default_pains": [
            "Lack of runtime visibility into application and infrastructure threats",
            "Siloed security data disconnected from observability data",
            "Slow investigation workflows requiring manual log correlation",
            "Compliance and audit requirements with insufficient tooling",
            "Alert overload from too many low-fidelity security signals",
        ],
        "kpis": [
            "Mean time to detect threats",
            "Investigation time",
            "Compliance audit pass rate",
            "False positive rate",
            "Coverage across environments",
        ],
        "demo_emphasis": "security_workflow",
    },
    "developer": {
        "title": "Software Developer / Application Developer",
        "default_pains": [
            "Difficulty debugging production issues without deep infrastructure knowledge",
            "Slow feedback loops — can't see impact of code changes on performance",
            "Lack of visibility into dependencies and downstream service behavior",
            "CI/CD pipeline failures that are hard to diagnose",
            "No easy way to understand real user experience of their code",
        ],
        "kpis": [
            "Deployment frequency",
            "Code change lead time",
            "Error rates per release",
            "P99 latency of owned services",
            "Time spent debugging",
        ],
        "demo_emphasis": "developer_experience",
    },
    "engineering_manager": {
        "title": "Engineering Manager / Director of Engineering",
        "default_pains": [
            "No centralized view of team service health and performance",
            "Difficulty prioritizing reliability work vs. feature development",
            "Unclear ownership of services during incidents",
            "Team burnout from on-call and incident response burden",
            "Inability to demonstrate reliability improvements to leadership",
        ],
        "kpis": [
            "Team incident load",
            "SLO compliance per team",
            "On-call burden distribution",
            "Reliability investment ROI",
            "Cross-team dependency health",
        ],
        "demo_emphasis": "team_management",
    },
    "cto_cio": {
        "title": "CTO / CIO / VP of Technology",
        "default_pains": [
            "Cloud costs growing faster than revenue",
            "Vendor sprawl creating operational complexity and budget waste",
            "Inability to connect technology investments to business outcomes",
            "Risk exposure from insufficient observability during growth or migration",
            "Board/executive pressure on reliability, security, and cost efficiency",
        ],
        "kpis": [
            "Total cost of observability",
            "Business uptime / revenue protection",
            "Cloud cost optimization",
            "Vendor consolidation savings",
            "Time to market for new capabilities",
        ],
        "demo_emphasis": "strategic_business",
    },
}

PAIN_TO_PRODUCT_MAP: dict[str, list[str]] = {
    "high_mttr": ["APM", "Infrastructure Monitoring", "Log Management", "Incident Management"],
    "alert_fatigue": ["Monitors / Alerting", "Watchdog (AI)", "Incident Management"],
    "tool_sprawl": ["Platform Story (all products)", "Unified Agent"],
    "lack_of_correlation": [
        "APM", "Infrastructure Monitoring", "Log Management", "RUM",
        "Unified Service Tagging",
    ],
    "slow_root_cause": ["APM (Distributed Tracing)", "Log Management (Log Explorer)", "Watchdog"],
    "poor_user_experience_visibility": ["RUM (Real User Monitoring)", "Synthetics", "Session Replay"],
    "ci_cd_visibility": ["CI Visibility", "Software Delivery"],
    "security_threats": [
        "Cloud Security Management", "Application Security Management", "Cloud SIEM",
    ],
    "compliance_requirements": ["Cloud Security Management", "Audit Trail", "Sensitive Data Scanner"],
    "cloud_cost_pressure": ["Cloud Cost Management"],
    "database_performance": ["Database Monitoring"],
    "network_issues": ["Network Performance Monitoring", "Network Device Monitoring"],
    "serverless_monitoring": ["Serverless Monitoring"],
    "container_orchestration": ["Container Monitoring", "Orchestrator Explorer"],
    "on_call_burnout": ["Incident Management", "On-Call", "Monitors / Alerting"],
    "scaling_observability": ["Platform Story", "Watchdog", "Monitors as Code"],
}
