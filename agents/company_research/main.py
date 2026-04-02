"""Company Research Agent — FastAPI service on port 5056.

Accepts a company name (and optionally a domain), determines whether the
company is public or private, and returns structured company intelligence.
"""

import logging
import time

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from config import settings
from edgar_client import EdgarClient
from models import CompanyResearch, ResearchRequest
from router import research_company
from sumble_client import SumbleClient

logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger(__name__)

app = FastAPI(title="Company Research Agent")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_sumble = SumbleClient(api_key=settings.sumble_api_key)
_edgar = EdgarClient(base_url=settings.sec_edgar_agent_url)


@app.post("/api/research")
async def handle_research(req: ResearchRequest) -> dict:
    start = time.perf_counter()

    result: CompanyResearch = await research_company(
        company_name=req.company_name,
        domain=req.domain,
        sumble=_sumble,
        edgar=_edgar,
    )

    elapsed_ms = int((time.perf_counter() - start) * 1000)
    logger.info(
        "Research complete for '%s' (%s) in %d ms — confidence: %s, sources: %s",
        req.company_name,
        "public" if result.is_public else "private",
        elapsed_ms,
        result.confidence_level,
        result.data_sources,
    )

    return {
        "research": result.model_dump(),
        "processing_time_ms": elapsed_ms,
    }


@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "service": "company-research-agent",
        "sumble_configured": bool(settings.sumble_api_key),
        "edgar_url": settings.sec_edgar_agent_url,
    }


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=settings.port, reload=True)
