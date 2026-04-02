"""Extract hiring signals, tech themes, and competitive intelligence from raw Sumble data."""

from __future__ import annotations

import re
from collections import Counter
from datetime import datetime, timezone

from models import (
    SumbleEnrichResponse,
    SumbleJob,
    SumbleJobsResponse,
    SumblePeopleResponse,
    SumblePerson,
    SumbleTechnology,
)
from confidence_engine import TechnologySignal
from tech_normalizer import normalize_tech_name

# ---------------------------------------------------------------------------
# Competitive mapping — tools Datadog can displace
# ---------------------------------------------------------------------------

COMPETITOR_MAP: dict[str, str] = {
    # Splunk
    "splunk": "Splunk",
    # New Relic
    "new relic": "New Relic",
    "new-relic": "New Relic",
    "newrelic": "New Relic",
    # Dynatrace
    "dynatrace": "Dynatrace",
    # AppDynamics / Cisco
    "appdynamics": "AppDynamics",
    "app dynamics": "AppDynamics",
    "cisco app dynamics": "AppDynamics",
    "cisco-app-dynamics": "AppDynamics",
    # ELK / Elastic
    "elk": "ELK",
    "elastic": "ELK",
    "elasticsearch": "ELK",
    "kibana": "ELK",
    "logstash": "ELK",
    # Sumo Logic
    "sumo logic": "Sumo Logic",
    "sumo-logic": "Sumo Logic",
    "sumologic": "Sumo Logic",
    # Grafana / Prometheus
    "grafana": "Grafana",
    "prometheus": "Prometheus",
    # SolarWinds
    "solarwinds": "SolarWinds",
    "solarwinds orion": "SolarWinds",
    "solarwinds npm": "SolarWinds",
    # Legacy / Network monitoring
    "nagios": "Nagios",
    "zabbix": "Zabbix",
    # Incident management
    "pagerduty": "PagerDuty",
    "opsgenie": "OpsGenie",
    # Cloud-native monitoring
    "aws cloudwatch": "CloudWatch",
    "aws-cloudwatch": "CloudWatch",
    "cloudwatch": "CloudWatch",
    "gcp cloud monitoring": "GCP Cloud Monitoring",
    "gcp-cloud-monitoring": "GCP Cloud Monitoring",
    "google cloud monitoring": "GCP Cloud Monitoring",
    "stackdriver": "GCP Cloud Monitoring",
    "azure monitor": "Azure Monitor",
    "azure-monitor": "Azure Monitor",
    # Modern observability
    "sentry": "Sentry",
    "honeycomb": "Honeycomb",
    "lightstep": "Lightstep",
    "ibm instana": "Instana",
    "ibm-instana": "Instana",
    "instana": "Instana",
    "catchpoint": "Catchpoint",
    "thousandeyes": "ThousandEyes",
    "otel open-telemetry": "OpenTelemetry",
    "otel-open-telemetry": "OpenTelemetry",
    "opentelemetry": "OpenTelemetry",
    "signalfx": "SignalFx",
    "signalfx-microservices-apm": "SignalFx",
    "site24x7": "Site24x7",
    "pingdom": "Pingdom",
    "manageengine": "ManageEngine",
    "icinga": "Icinga",
    "victorops": "VictorOps",
}

CLOUD_PLATFORMS = {"aws", "azure", "gcp", "google cloud", "amazon web services"}

INFRASTRUCTURE_TOOLS = {
    "kubernetes", "docker", "terraform", "ansible", "jenkins",
    "helm", "istio", "consul", "vault", "nomad",
    "puppet", "chef", "salt", "flux",
}

SECURITY_TOOLS = {
    "crowdstrike", "palo alto", "snyk", "aqua", "twistlock",
    "prisma cloud", "qualys", "tenable", "rapid7", "wiz",
    "orca", "lacework", "veracode", "checkmarx",
}

DATABASE_TOOLS = {
    "postgresql", "postgres", "mysql", "mongodb", "mongo",
    "redis", "microsoft sql server", "sql server", "mssql",
    "oracle database", "oracle db", "ibm db2", "db2",
    "cassandra", "couchdb", "couchbase", "mariadb",
    "dynamodb", "cosmosdb", "cosmos db",
}

MESSAGE_QUEUE_TOOLS = {
    "kafka", "rabbitmq", "rabbit mq", "amazon sqs", "sqs",
    "amazon kinesis", "kinesis", "google cloud pub/sub",
    "azure service bus",
}

LANGUAGES_FRAMEWORKS = {
    "java", "python", "node.js", "nodejs", "node-js", "go", "golang", "go-lang",
    "ruby", ".net", "dotnet", "react", "typescript", "swift", "kotlin",
    "c#", "scala", "rust", "php",
}

DATA_PLATFORMS = {
    "databricks", "snowflake", "bigquery", "gcp bigquery", "gcp-bigquery",
    "apache spark", "spark", "apache airflow", "airflow", "dbt",
    "tableau", "power bi", "microsoft power bi", "looker",
}

CICD_TOOLS = {
    "gitlab", "github actions", "circleci", "argocd", "argo cd",
    "artifactory", "spinnaker", "harness",
}

FEATURE_FLAG_TOOLS = {
    "launchdarkly", "launch darkly", "split", "split.io", "split-io",
    "optimizely",
}

SERVERLESS_TOOLS = {
    "aws lambda", "lambda", "azure functions", "google cloud functions",
}

NETWORKING_TOOLS = {
    "cloudflare", "nginx", "apache httpd", "apache-httpd",
    "envoy", "haproxy", "kong", "traefik",
}

OBSERVABILITY_TOOLS = set(COMPETITOR_MAP.keys())

# ---------------------------------------------------------------------------
# Theme keywords for hiring signal classification
# ---------------------------------------------------------------------------

THEME_KEYWORDS: dict[str, list[str]] = {
    "observability consolidation": [
        "observability", "monitoring", "consolidat", "single pane",
        "unified", "telemetry", "opentelemetry",
    ],
    "platform engineering": [
        "platform engineer", "internal developer", "developer experience",
        "self-service", "golden path", "backstage",
    ],
    "cloud migration": [
        "cloud migration", "cloud native", "moderniz", "containeriz",
        "microservice", "kubernetes", "lift and shift",
    ],
    "security & compliance": [
        "security engineer", "devsecops", "cloud security", "soc ",
        "siem", "compliance", "cspm", "vulnerability",
    ],
    "SRE & reliability": [
        "site reliability", "sre", "reliability engineer", "incident",
        "on-call", "slo", "sli", "error budget",
    ],
    "data engineering": [
        "data engineer", "data platform", "data pipeline", "etl",
        "streaming", "kafka", "real-time data",
    ],
    "AI/ML infrastructure": [
        "mlops", "ml engineer", "ai infrastructure", "gpu",
        "machine learning platform", "llm", "model serving",
    ],
}

# ---------------------------------------------------------------------------
# Persona priority ranking for entry-point recommendation
# ---------------------------------------------------------------------------

PERSONA_PRIORITY = [
    "vp of engineering",
    "vp engineering",
    "director of engineering",
    "director of platform",
    "head of platform",
    "head of infrastructure",
    "director of sre",
    "head of sre",
    "director of devops",
    "cto",
    "ciso",
    "vp of infrastructure",
    "director of security",
    "engineering manager",
    "platform engineering manager",
    "sre manager",
]


def _match_set(name_lower: str, tool_set: set[str]) -> bool:
    """Check if a technology name matches any entry in a tool set."""
    variants = {
        name_lower,
        name_lower.replace(" ", "-"),
        name_lower.replace(" ", "").replace("-", ""),
        name_lower.replace("-", " "),
    }
    return bool(variants & tool_set)


def _competitor_display(name_lower: str) -> str | None:
    """Look up a display name in the competitor map, trying multiple normalizations."""
    for variant in (
        name_lower,
        name_lower.replace(" ", "-"),
        name_lower.replace(" ", "").replace("-", ""),
        name_lower.replace("-", " "),
    ):
        if variant in COMPETITOR_MAP:
            return COMPETITOR_MAP[variant]
    return None


def classify_tech_stack(
    technologies: list[SumbleTechnology],
) -> dict[str, list[str]]:
    """Categorize technologies into labeled buckets.

    Returns a dict with keys: observability, cloud, infra, security,
    databases, message_queues, languages, data_platforms, cicd,
    feature_flags, serverless, networking.
    """
    result: dict[str, list[str]] = {
        "observability": [],
        "cloud": [],
        "infra": [],
        "security": [],
        "databases": [],
        "message_queues": [],
        "languages": [],
        "data_platforms": [],
        "cicd": [],
        "feature_flags": [],
        "serverless": [],
        "networking": [],
    }

    def _append_unique(bucket: str, value: str) -> None:
        if value not in result[bucket]:
            result[bucket].append(value)

    for tech in technologies:
        name_lower = tech.name.lower()

        display = _competitor_display(name_lower)
        if display:
            _append_unique("observability", display)
        elif _match_set(name_lower, CLOUD_PLATFORMS):
            _append_unique("cloud", tech.name)
        elif _match_set(name_lower, DATABASE_TOOLS):
            _append_unique("databases", tech.name)
        elif _match_set(name_lower, MESSAGE_QUEUE_TOOLS):
            _append_unique("message_queues", tech.name)
        elif _match_set(name_lower, INFRASTRUCTURE_TOOLS):
            _append_unique("infra", tech.name)
        elif _match_set(name_lower, CICD_TOOLS):
            _append_unique("cicd", tech.name)
        elif _match_set(name_lower, SERVERLESS_TOOLS):
            _append_unique("serverless", tech.name)
        elif _match_set(name_lower, NETWORKING_TOOLS):
            _append_unique("networking", tech.name)
        elif _match_set(name_lower, FEATURE_FLAG_TOOLS):
            _append_unique("feature_flags", tech.name)
        elif _match_set(name_lower, DATA_PLATFORMS):
            _append_unique("data_platforms", tech.name)
        elif _match_set(name_lower, LANGUAGES_FRAMEWORKS):
            _append_unique("languages", tech.name)
        elif _match_set(name_lower, SECURITY_TOOLS):
            _append_unique("security", tech.name)

    return result


def extract_competitive_targets(
    observability_tools: list[str],
) -> list[str]:
    """Identify tools Datadog would displace."""
    targets: list[str] = []
    for tool in observability_tools:
        normalized = tool.lower().replace(" ", "").replace("-", "")
        if "datadog" not in normalized:
            targets.append(tool)
    return targets


def extract_hiring_velocity(jobs: SumbleJobsResponse) -> str:
    """Classify hiring velocity based on tech-relevant role count."""
    tech_count = sum(
        1 for job in jobs.jobs
        if _ROLE_RELEVANCE_PATTERNS.search(f"{job.title} {job.department}")
    )

    if tech_count >= 15:
        return "aggressive"
    if tech_count >= 5:
        return "moderate"
    if tech_count >= 1:
        return "stable"
    return "unknown"


def extract_hiring_themes(jobs: SumbleJobsResponse) -> list[str]:
    """Cluster job postings into strategic hiring themes."""
    theme_scores: Counter[str] = Counter()

    for job in jobs.jobs:
        text = f"{job.title} {job.description} {job.department}".lower()
        for theme, keywords in THEME_KEYWORDS.items():
            for kw in keywords:
                if kw in text:
                    theme_scores[theme] += 1
                    break

    return [theme for theme, _ in theme_scores.most_common(5) if _ > 0]


_ROLE_RELEVANCE_PATTERNS = re.compile(
    r"\b(?:observability|monitoring|sre|site reliability|platform|devops|"
    r"infrastructure|cloud|security|reliability|engineer|architect|"
    r"developer|software|data engineer|data platform|"
    r"director.{0,5}(?:it|engineering|technology)|"
    r"vp.{0,5}(?:it|engineering|technology)|"
    r"cto|ciso|information technology)\b",
    re.IGNORECASE,
)


def extract_relevant_roles(jobs: SumbleJobsResponse, limit: int = 10) -> list[dict]:
    """Extract the most relevant open roles for Datadog sales context."""
    scored_jobs: list[tuple[int, SumbleJob]] = []
    for job in jobs.jobs:
        title_text = f"{job.title} {job.department} {job.teams}"
        title_hits = len(_ROLE_RELEVANCE_PATTERNS.findall(title_text))
        desc_hits = len(_ROLE_RELEVANCE_PATTERNS.findall(job.description[:300]))
        score = title_hits * 3 + desc_hits
        if score > 0:
            scored_jobs.append((score, job))

    scored_jobs.sort(key=lambda x: x[0], reverse=True)

    relevant: list[dict] = []
    for _, job in scored_jobs[:limit]:
        relevant.append({
            "title": job.title,
            "department": job.department,
            "technologies": job.technologies_mentioned[:5],
        })

    return relevant


def recommend_entry_persona(
    people: SumblePeopleResponse,
    is_public: bool,
) -> dict:
    """Rank people and recommend the best entry persona with rationale."""
    if not people.people:
        fallback_title = "VP of Engineering" if is_public else "Director of Platform Engineering"
        return {
            "name": "",
            "title": fallback_title,
            "seniority": "vp" if is_public else "director",
            "rationale": (
                f"No specific contacts found. Recommend targeting a {fallback_title} "
                "as the typical decision-maker for observability platform investments."
            ),
        }

    best: SumblePerson | None = None
    best_rank = len(PERSONA_PRIORITY) + 1

    for person in people.people:
        title_lower = person.title.lower()
        for rank, pattern in enumerate(PERSONA_PRIORITY):
            if pattern in title_lower:
                if rank < best_rank:
                    best = person
                    best_rank = rank
                break

    if best is None:
        best = people.people[0]

    title_lower = best.title.lower()
    if "vp" in title_lower or "vice president" in title_lower:
        rationale = (
            f"{best.title} is a senior engineering leader who typically owns "
            "platform and tooling decisions, including observability strategy."
        )
    elif "director" in title_lower:
        rationale = (
            f"{best.title} likely has direct budget authority over engineering "
            "tools and can champion an observability platform consolidation."
        )
    elif "head" in title_lower:
        rationale = (
            f"{best.title} is the functional owner of their domain and will be "
            "a key influencer in any observability platform decision."
        )
    elif "cto" in title_lower or "ciso" in title_lower:
        rationale = (
            f"{best.title} is the top technical decision-maker. A strong "
            "executive sponsor for platform-wide observability adoption."
        )
    else:
        rationale = (
            f"{best.title} appears to be the most relevant engineering leader "
            "for an observability conversation based on available org data."
        )

    return {
        "name": best.name,
        "title": best.title,
        "seniority": best.seniority,
        "department": best.department,
        "rationale": rationale,
    }


# ---------------------------------------------------------------------------
# Technology signal extraction (for ConfidenceEngine)
# ---------------------------------------------------------------------------

def _parse_date(date_str: str | None) -> datetime | None:
    """Best-effort parse of a date string into a tz-aware datetime."""
    if not date_str:
        return None
    for fmt in ("%Y-%m-%d", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M:%SZ", "%m/%d/%Y"):
        try:
            dt = datetime.strptime(date_str.strip(), fmt)
            return dt.replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def extract_tech_signals(
    enrich: SumbleEnrichResponse | None,
    jobs: SumbleJobsResponse | None,
    people: SumblePeopleResponse | None,
) -> list[TechnologySignal]:
    """Convert raw Sumble data into normalized TechnologySignal objects.

    Produces signals from three Sumble sub-sources so the ConfidenceEngine
    can count each independently when determining confidence tiers.
    """
    signals: list[TechnologySignal] = []

    # --- Sumble enrichment (organization tech stack) ---
    if enrich and enrich.organization and enrich.organization.technologies:
        for tech in enrich.organization.technologies:
            if not tech.name:
                continue
            canonical = normalize_tech_name(tech.name)
            mention_count = max(tech.jobs_count + tech.people_count, 1)
            signals.append(TechnologySignal(
                source="sumble_enrich",
                raw_name=tech.name,
                canonical_name=canonical,
                detection_context=f"org enrichment ({tech.jobs_count} jobs, {tech.people_count} people)",
                detection_date=_parse_date(tech.last_job_post),
                source_count=mention_count,
            ))

    # --- Sumble jobs (technologies_mentioned across all postings) ---
    if jobs and jobs.jobs:
        tech_counts: Counter[str] = Counter()
        tech_latest_date: dict[str, str | None] = {}
        for job in jobs.jobs:
            for raw in job.technologies_mentioned:
                if not raw:
                    continue
                canonical = normalize_tech_name(raw)
                tech_counts[canonical] += 1
                existing = tech_latest_date.get(canonical)
                if job.posted_date and (not existing or job.posted_date > existing):
                    tech_latest_date[canonical] = job.posted_date

        for canonical, count in tech_counts.items():
            signals.append(TechnologySignal(
                source="sumble_jobs",
                raw_name=canonical,
                canonical_name=canonical,
                detection_context=f"{count} job post{'s' if count != 1 else ''}",
                detection_date=_parse_date(tech_latest_date.get(canonical)),
                source_count=count,
            ))

    # --- Sumble people (placeholder — SumblePerson doesn't carry tech fields yet) ---
    # When the Sumble People API adds technology data to profiles, signals
    # should be extracted here with source="sumble_people".

    return signals
