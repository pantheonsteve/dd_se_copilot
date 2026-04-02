"""Async Sumble API client with retry, rate limiting, and 24-hour caching."""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime

import httpx

from models import (
    SumbleEnrichResponse,
    SumbleJob,
    SumbleJobsResponse,
    SumbleOrganization,
    SumblePeopleResponse,
    SumblePerson,
    SumbleTechnology,
)

logger = logging.getLogger(__name__)

_BASE_URL = "https://api.sumble.com/v3"
_MAX_RETRIES = 3
_BACKOFF_BASE = 1.0
_CACHE_TTL_SECONDS = 86_400  # 24 hours

TECHNOLOGY_SLUGS = [
    # Observability / APM / Monitoring (competitors + Datadog)
    "datadog", "splunk", "new-relic", "dynatrace", "appdynamics",
    "cisco-app-dynamics", "grafana", "prometheus", "elk",
    "elasticsearch", "kibana", "logstash", "sumo-logic",
    "nagios", "zabbix", "solarwinds", "pagerduty", "opsgenie",
    "aws-cloudwatch", "gcp-cloud-monitoring", "azure-monitor",
    "sentry", "honeycomb", "lightstep", "ibm-instana", "catchpoint",
    "thousandeyes", "otel-open-telemetry", "site24x7",
    "signalfx-microservices-apm",
    # Cloud platforms
    "aws", "azure", "gcp",
    # Infrastructure / Container / CI-CD
    "kubernetes", "docker", "terraform", "ansible", "jenkins",
    "helm", "istio",
    # Databases
    "postgresql", "mysql", "mongodb", "redis", "microsoft-sql-server",
    "oracle-database", "ibm-db2", "cassandra", "couchdb", "mariadb",
    "dynamodb", "cosmosdb",
    # Message Queues / Streaming
    "kafka", "rabbitmq", "amazon-sqs", "amazon-kinesis",
    "google-cloud-pub-sub", "azure-service-bus",
    # Languages / Frameworks
    "java", "python", "node-js", "go-lang", "ruby", "dotnet",
    "react", "typescript", "swift", "kotlin",
    # Data Platforms / BI
    "databricks", "snowflake", "gcp-bigquery", "apache-spark",
    "apache-airflow", "dbt",
    # CI/CD / DevOps
    "gitlab", "github-actions", "circleci", "argocd", "artifactory",
    "spinnaker", "harness",
    # Feature Flags / Testing
    "launchdarkly", "split-io", "optimizely",
    # Serverless
    "aws-lambda", "azure-functions", "google-cloud-functions",
    # Networking / CDN
    "cloudflare", "nginx", "apache-httpd", "envoy", "haproxy",
]

JOB_FUNCTION_FILTERS = ["engineering", "devops", "security", "it"]
SENIORITY_FILTERS = ["vp", "director", "head", "manager"]
PEOPLE_FUNCTION_FILTERS = [
    "engineering", "devops", "security", "it", "infrastructure",
]


class _CacheEntry:
    __slots__ = ("data", "timestamp")

    def __init__(self, data: dict, timestamp: float):
        self.data = data
        self.timestamp = timestamp


class SumbleClient:
    """Async client for the Sumble API with rate limiting and caching."""

    def __init__(self, api_key: str, base_url: str = _BASE_URL):
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._semaphore = asyncio.Semaphore(10)
        self._cache: dict[str, _CacheEntry] = {}

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

    def _cache_key(self, endpoint: str, domain: str) -> str:
        return f"{endpoint}:{domain}"

    def _get_cached(self, key: str) -> dict | None:
        entry = self._cache.get(key)
        if entry is None:
            return None
        if time.monotonic() - entry.timestamp > _CACHE_TTL_SECONDS:
            del self._cache[key]
            return None
        return entry.data

    def _set_cached(self, key: str, data: dict) -> None:
        self._cache[key] = _CacheEntry(data=data, timestamp=time.monotonic())

    async def _post(self, endpoint: str, payload: dict) -> dict:
        """POST with retry, exponential backoff, and rate-limit semaphore."""
        url = f"{self._base_url}/{endpoint.lstrip('/')}"

        for attempt in range(_MAX_RETRIES):
            async with self._semaphore:
                try:
                    async with httpx.AsyncClient(timeout=30) as client:
                        resp = await client.post(
                            url,
                            json=payload,
                            headers=self._headers(),
                        )
                        if resp.status_code == 429:
                            wait = _BACKOFF_BASE * (2 ** attempt)
                            logger.warning(
                                "Sumble rate limited on %s, retrying in %.1fs",
                                endpoint, wait,
                            )
                            await asyncio.sleep(wait)
                            continue
                        resp.raise_for_status()
                        return resp.json()
                except httpx.TimeoutException:
                    if attempt == _MAX_RETRIES - 1:
                        logger.error("Sumble %s timed out after %d retries", endpoint, _MAX_RETRIES)
                        raise
                    wait = _BACKOFF_BASE * (2 ** attempt)
                    logger.warning("Sumble %s timed out, retrying in %.1fs", endpoint, wait)
                    await asyncio.sleep(wait)
                except httpx.HTTPStatusError:
                    if attempt == _MAX_RETRIES - 1:
                        raise
                    wait = _BACKOFF_BASE * (2 ** attempt)
                    logger.warning("Sumble %s HTTP error, retrying in %.1fs", endpoint, wait)
                    await asyncio.sleep(wait)

        return {}

    # ------------------------------------------------------------------
    # Public API methods
    # ------------------------------------------------------------------

    async def enrich_organization(self, domain: str) -> SumbleEnrichResponse:
        cache_key = self._cache_key("enrich", domain)
        cached = self._get_cached(cache_key)
        if cached is not None:
            logger.info("Cache hit for enrich:%s", domain)
            return self._parse_enrich(cached)

        payload = {
            "organization": {"domain": domain},
            "filters": {
                "technologies": TECHNOLOGY_SLUGS,
            },
        }

        try:
            data = await self._post("organizations/enrich", payload)
            self._set_cached(cache_key, data)
            return self._parse_enrich(data)
        except Exception as exc:
            logger.error("Sumble enrich failed for %s: %s", domain, exc)
            return SumbleEnrichResponse()

    async def find_jobs(self, domain: str) -> SumbleJobsResponse:
        cache_key = self._cache_key("jobs", domain)
        cached = self._get_cached(cache_key)
        if cached is not None:
            logger.info("Cache hit for jobs:%s", domain)
            return self._parse_jobs(cached)

        six_months_ago = datetime.now().strftime("%Y-01-01")
        payload = {
            "organization": {"domain": domain},
            "filters": {
                "job_functions": JOB_FUNCTION_FILTERS,
                "posted_after": six_months_ago,
            },
        }

        try:
            data = await self._post("jobs/find", payload)
            self._set_cached(cache_key, data)
            return self._parse_jobs(data)
        except Exception as exc:
            logger.error("Sumble jobs find failed for %s: %s", domain, exc)
            return SumbleJobsResponse()

    async def find_people(self, domain: str) -> SumblePeopleResponse:
        cache_key = self._cache_key("people", domain)
        cached = self._get_cached(cache_key)
        if cached is not None:
            logger.info("Cache hit for people:%s", domain)
            return self._parse_people(cached)

        payload = {
            "organization": {"domain": domain},
            "filters": {
                "seniority": SENIORITY_FILTERS,
                "job_functions": PEOPLE_FUNCTION_FILTERS,
            },
        }

        try:
            data = await self._post("people/find", payload)
            self._set_cached(cache_key, data)
            return self._parse_people(data)
        except Exception as exc:
            logger.error("Sumble people find failed for %s: %s", domain, exc)
            return SumblePeopleResponse()

    async def find_technologies(self, query: str) -> list[dict]:
        try:
            data = await self._post("technologies/find", {"query": query})
            return data.get("technologies", [])
        except Exception as exc:
            logger.error("Sumble technology find failed for '%s': %s", query, exc)
            return []

    # ------------------------------------------------------------------
    # Response parsers — normalize Sumble JSON into our Pydantic models
    # ------------------------------------------------------------------

    @staticmethod
    def _parse_enrich(data: dict) -> SumbleEnrichResponse:
        org_data = data.get("organization", {})
        if isinstance(org_data, list):
            org_data = org_data[0] if org_data else {}

        technologies_raw = data.get("technologies", [])
        technologies = [
            SumbleTechnology(
                name=t.get("name", ""),
                jobs_count=t.get("jobs_count", 0),
                people_count=t.get("people_count", 0),
                teams_count=t.get("teams_count", 0),
                last_job_post=t.get("last_job_post"),
            )
            for t in technologies_raw
            if isinstance(t, dict)
        ]

        org = SumbleOrganization(
            name=org_data.get("name", ""),
            domain=org_data.get("domain", ""),
            slug=org_data.get("slug", ""),
            technologies=technologies,
            technologies_found=data.get("technologies_found", ""),
        )

        return SumbleEnrichResponse(organization=org, raw=data)

    @staticmethod
    def _parse_jobs(data: dict) -> SumbleJobsResponse:
        jobs_raw = data.get("jobs", data.get("data", []))
        if not isinstance(jobs_raw, list):
            jobs_raw = []

        jobs = []
        for j in jobs_raw:
            if not isinstance(j, dict):
                continue

            tech_mentioned = j.get("matched_technologies") or j.get("technologies_mentioned") or []
            if not isinstance(tech_mentioned, list):
                tech_mentioned = [s.strip() for s in str(tech_mentioned).split(",") if s.strip()]

            jobs.append(SumbleJob(
                title=j.get("job_title") or j.get("title") or "",
                department=j.get("primary_job_function") or j.get("department") or j.get("job_function") or "",
                location=j.get("location") or "",
                posted_date=j.get("datetime_pulled") or j.get("posted_date") or j.get("posted_at") or "",
                description=(j.get("description") or "")[:500],
                technologies_mentioned=tech_mentioned,
                teams=j.get("teams") or "",
                url=j.get("url") or "",
            ))

        return SumbleJobsResponse(
            jobs=jobs,
            total_count=data.get("total_count", len(jobs)),
            raw=data,
        )

    @staticmethod
    def _parse_people(data: dict) -> SumblePeopleResponse:
        people_raw = data.get("people", data.get("data", []))
        if not isinstance(people_raw, list):
            people_raw = []

        people = []
        for p in people_raw:
            if not isinstance(p, dict):
                continue
            people.append(SumblePerson(
                name=p.get("name") or p.get("full_name") or "",
                title=p.get("title") or p.get("job_title") or "",
                seniority=p.get("seniority") or "",
                department=p.get("department") or p.get("primary_job_function") or p.get("job_function") or "",
                linkedin_url=p.get("linkedin_url") or "",
                url=p.get("url") or "",
            ))

        return SumblePeopleResponse(
            people=people,
            total_count=data.get("people_count", data.get("total_count", len(people))),
            raw=data,
        )
