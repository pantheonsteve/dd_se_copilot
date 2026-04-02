"""BuiltWith Domain API client with file-based caching.

Retrieves live web-facing technology data for a domain and normalizes it
into structured Pydantic models for consumption by the confidence engine.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from pathlib import Path

import httpx
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

_BUILTWITH_BASE = "https://api.builtwith.com/v21/api.json"
_CACHE_TTL_DAYS = 7
_MAX_RETRIES = 3
_RETRY_BACKOFF_BASE = 2  # seconds


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class BuiltWithTechnology(BaseModel):
    name: str = ""
    categories: list[str] = Field(default_factory=list)
    tag: str = ""
    first_detected: datetime | None = None
    last_detected: datetime | None = None
    subdomain: str = ""


class BuiltWithResult(BaseModel):
    domain: str
    technologies: list[BuiltWithTechnology] = Field(default_factory=list)
    raw_tech_names: set[str] = Field(default_factory=set)
    scan_timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    class Config:
        json_encoders = {
            set: list,
            datetime: lambda v: v.isoformat(),
        }


# ---------------------------------------------------------------------------
# File-based cache
# ---------------------------------------------------------------------------

class BuiltWithCache:
    """Simple JSON file cache — one file per domain, 7-day TTL."""

    def __init__(self, cache_dir: str | Path = ".builtwith_cache"):
        self._dir = Path(cache_dir)
        self._dir.mkdir(parents=True, exist_ok=True)

    def _path(self, domain: str) -> Path:
        safe = domain.lower().replace("/", "_").replace(":", "_")
        return self._dir / f"{safe}.json"

    async def get(self, domain: str) -> BuiltWithResult | None:
        path = self._path(domain)
        if not path.exists():
            return None
        try:
            raw = json.loads(path.read_text())
            result = BuiltWithResult(**raw)
            age = datetime.now(timezone.utc) - result.scan_timestamp
            if age.days >= _CACHE_TTL_DAYS:
                logger.debug("BuiltWith cache expired for %s (age=%sd)", domain, age.days)
                return None
            logger.info("BuiltWith cache HIT for %s (age=%sd)", domain, age.days)
            return result
        except Exception as exc:
            logger.warning("BuiltWith cache read error for %s: %s", domain, exc)
            return None

    async def set(self, domain: str, result: BuiltWithResult) -> None:
        path = self._path(domain)
        try:
            data = result.model_dump(mode="json")
            # Convert set to list for JSON serialization
            if isinstance(data.get("raw_tech_names"), set):
                data["raw_tech_names"] = list(data["raw_tech_names"])
            path.write_text(json.dumps(data, indent=2, default=str))
        except Exception as exc:
            logger.warning("BuiltWith cache write error for %s: %s", domain, exc)


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------

def _epoch_ms_to_dt(epoch_ms: int | None) -> datetime | None:
    if not epoch_ms:
        return None
    try:
        return datetime.fromtimestamp(epoch_ms / 1000, tz=timezone.utc)
    except (OSError, ValueError):
        return None


class BuiltWithClient:
    """Async client for the BuiltWith Domain API v21."""

    def __init__(self, api_key: str, cache_dir: str | Path = ".builtwith_cache"):
        self._api_key = api_key
        self._cache = BuiltWithCache(cache_dir)

    async def lookup(self, domain: str) -> BuiltWithResult | None:
        """Look up live technologies for *domain*, with caching and retry."""
        if not self._api_key:
            logger.warning("BuiltWith API key not configured — skipping lookup")
            return None

        cached = await self._cache.get(domain)
        if cached is not None:
            return cached

        params = {
            "KEY": self._api_key,
            "LOOKUP": domain,
            "LIVEONLY": "yes",
            "NOMETA": "yes",
            "NOATTR": "yes",
            "HIDEDL": "yes",
        }

        for attempt in range(1, _MAX_RETRIES + 1):
            try:
                async with httpx.AsyncClient(timeout=30) as client:
                    resp = await client.get(_BUILTWITH_BASE, params=params)

                if resp.status_code == 429:
                    wait = _RETRY_BACKOFF_BASE ** attempt
                    logger.warning(
                        "BuiltWith 429 rate-limited (attempt %d/%d), retrying in %ds",
                        attempt, _MAX_RETRIES, wait,
                    )
                    await asyncio.sleep(wait)
                    continue

                resp.raise_for_status()
                data = resp.json()
                result = self._parse(domain, data)
                await self._cache.set(domain, result)
                logger.info(
                    "BuiltWith lookup for %s: %d technologies detected",
                    domain, len(result.technologies),
                )
                return result

            except httpx.HTTPStatusError as exc:
                logger.error("BuiltWith HTTP %s for %s: %s", exc.response.status_code, domain, exc)
                return None
            except Exception as exc:
                if attempt < _MAX_RETRIES:
                    wait = _RETRY_BACKOFF_BASE ** attempt
                    logger.warning(
                        "BuiltWith error (attempt %d/%d): %s — retrying in %ds",
                        attempt, _MAX_RETRIES, exc, wait,
                    )
                    await asyncio.sleep(wait)
                else:
                    logger.error("BuiltWith lookup failed for %s after %d attempts: %s", domain, _MAX_RETRIES, exc)
                    return None

        return None

    @staticmethod
    def _parse(domain: str, data: dict) -> BuiltWithResult:
        techs: list[BuiltWithTechnology] = []
        names: set[str] = set()

        results = data.get("Results", [])
        if not results:
            return BuiltWithResult(domain=domain)

        first_result = results[0].get("Result", {})
        paths = first_result.get("Paths", [])

        for path_obj in paths:
            subdomain = path_obj.get("SubDomain", "")
            for tech_obj in path_obj.get("Technologies", []):
                name = tech_obj.get("Name", "")
                if not name:
                    continue
                names.add(name)
                techs.append(BuiltWithTechnology(
                    name=name,
                    categories=tech_obj.get("Categories", []),
                    tag=tech_obj.get("Tag", ""),
                    first_detected=_epoch_ms_to_dt(tech_obj.get("FirstDetected")),
                    last_detected=_epoch_ms_to_dt(tech_obj.get("LastDetected")),
                    subdomain=subdomain,
                ))

        return BuiltWithResult(
            domain=domain,
            technologies=techs,
            raw_tech_names=names,
            scan_timestamp=datetime.now(timezone.utc),
        )
