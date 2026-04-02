"""Thin async HTTP client wrapping the existing SEC EDGAR agent at :5053."""

from __future__ import annotations

import logging
import re

import httpx

from models import EdgarResearchData

logger = logging.getLogger(__name__)

_QUERY_STRATEGIC = (
    "What are the company's top strategic priorities, major initiatives, "
    "and key areas of investment? List each as a concise bullet point."
)

_QUERY_RISKS_AND_TECH = (
    "What are the key risk factors, technology investments, digital "
    "transformation initiatives, and IT/operational challenges? "
    "List each as a concise bullet point."
)

_RISK_KEYWORDS = re.compile(
    r"risk|challeng|threat|headwind|vulnerab|uncertain|disrupt|compliance|regulat|litigat|cybersec",
    re.IGNORECASE,
)
_TECH_KEYWORDS = re.compile(
    r"technolog|digital|automat|software|platform|cloud|data|AI|machine learn|system|IT |infra|cyber|ERP|SAP",
    re.IGNORECASE,
)


def _extract_bullets(text: str) -> list[str]:
    """Pull concise bullet points from an LLM answer, skipping headers and boilerplate."""
    bullets: list[str] = []
    for line in text.split("\n"):
        line = line.strip()
        if line.startswith("#") or not line:
            continue
        cleaned = re.sub(r"^[\-\*\u2022\d]+[\.\)\:]?\s*", "", line).strip()
        cleaned = re.sub(r"\*\*", "", cleaned)
        cleaned = re.sub(r"\[Source\s*\d+\]", "", cleaned).strip()
        cleaned = cleaned.rstrip(":").strip()
        skip_prefixes = ("sure", "here", "based on", "the company", "according", "the following", "below")
        if len(cleaned) > 25 and not cleaned.lower().startswith(skip_prefixes):
            bullets.append(cleaned)
    return bullets


class EdgarClient:
    def __init__(self, base_url: str, timeout: float = 60):
        self._base_url = base_url.rstrip("/").replace("/api/query", "")
        self._timeout = timeout

    async def search_company(self, name: str) -> list[dict]:
        """Lightweight CIK lookup — returns list of {name, ticker, cik}."""
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.get(
                    f"{self._base_url}/api/edgar/search",
                    params={"q": name},
                )
                resp.raise_for_status()
                data = resp.json()
                return data.get("results", [])
        except Exception as exc:
            logger.error("EDGAR search failed for '%s': %s", name, exc)
            return []

    async def ensure_ingested(
        self, company_name: str, ticker: str, cik: str = ""
    ) -> dict:
        """Trigger 10-K ingest if not already done. Returns ingest result."""
        try:
            async with httpx.AsyncClient(timeout=300) as client:
                resp = await client.post(
                    f"{self._base_url}/api/edgar/ingest",
                    json={
                        "ticker": ticker,
                        "cik": cik,
                        "company_name": company_name,
                    },
                )
                resp.raise_for_status()
                return resp.json()
        except Exception as exc:
            logger.error(
                "EDGAR ingest failed for %s (%s): %s", company_name, ticker, exc
            )
            return {"error": str(exc)}

    async def query_edgar(self, question: str, ticker: str) -> dict:
        """RAG query against the SEC EDGAR agent."""
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                resp = await client.post(
                    f"{self._base_url}/api/query",
                    json={
                        "question": question,
                        "llm": "claude",
                        "ticker": ticker,
                    },
                )
                resp.raise_for_status()
                return resp.json()
        except Exception as exc:
            logger.error("EDGAR query failed for %s: %s", ticker, exc)
            return {"error": str(exc)}

    async def fetch_intelligence(
        self, company_name: str, ticker: str, cik: str = ""
    ) -> EdgarResearchData:
        """Full pipeline: ensure ingested, then query for strategic intel."""
        ingest_result = await self.ensure_ingested(company_name, ticker, cik)
        if "error" in ingest_result:
            logger.warning(
                "EDGAR ingest issue for %s — proceeding with existing data: %s",
                ticker, ingest_result["error"],
            )

        combined_answer_parts: list[str] = []
        strategic_priorities: list[str] = []
        risk_factors: list[str] = []
        technology_investments: list[str] = []

        strat_result = await self.query_edgar(_QUERY_STRATEGIC, ticker)
        strat_answer = strat_result.get("answer", "")
        if strat_answer and "error" not in strat_result:
            combined_answer_parts.append(strat_answer)
            strategic_priorities = _extract_bullets(strat_answer)

        risks_result = await self.query_edgar(_QUERY_RISKS_AND_TECH, ticker)
        risks_answer = risks_result.get("answer", "")
        if risks_answer and "error" not in risks_result:
            combined_answer_parts.append(risks_answer)
            for bullet in _extract_bullets(risks_answer):
                if _TECH_KEYWORDS.search(bullet):
                    technology_investments.append(bullet)
                elif _RISK_KEYWORDS.search(bullet):
                    risk_factors.append(bullet)
                else:
                    risk_factors.append(bullet)

        raw_answer = "\n\n".join(combined_answer_parts)

        return EdgarResearchData(
            ticker=ticker,
            company_name=company_name,
            filing_date=ingest_result.get("filing_date", ""),
            strategic_priorities=strategic_priorities,
            risk_factors=risk_factors,
            technology_investments=technology_investments,
            financial_highlights=[],
            raw_answer=raw_answer,
        )
