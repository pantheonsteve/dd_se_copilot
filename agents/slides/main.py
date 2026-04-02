"""Slide Generation Agent — FastAPI service.

Usage:
    cd agents/slides
    python main.py              # http://localhost:5055
"""

import logging
import time

import uvicorn
from fastapi import FastAPI, HTTPException

from config import settings
from generator import generate_slides
from models import GenerateRequest, GenerateResponse

logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger(__name__)

app = FastAPI(title="Slide Generation Agent")


@app.post("/api/generate-slides")
async def handle_generate(req: GenerateRequest) -> GenerateResponse:
    if not req.demo_plan.strip():
        raise HTTPException(status_code=400, detail="demo_plan is empty")

    start = time.perf_counter()
    try:
        deck = await generate_slides(req.demo_plan)
    except Exception as exc:
        logger.exception("Slide generation failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    elapsed_ms = int((time.perf_counter() - start) * 1000)
    logger.info(
        "Generated %d slides in %d ms", len(deck.slides), elapsed_ms
    )
    return GenerateResponse(slide_deck=deck, processing_time_ms=elapsed_ms)


@app.get("/api/health")
async def health():
    return {
        "status": "ok" if settings.anthropic_api_key else "missing_api_key",
        "model": settings.claude_model,
    }


if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=settings.port,
        reload=True,
    )
