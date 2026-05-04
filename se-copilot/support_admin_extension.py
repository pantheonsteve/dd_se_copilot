"""
Support Admin Copilot — FastAPI router for the Support Admin Chrome extension.

Mount on SE Copilot (see main.py). Endpoints live under /api/sac/.

Environment (optional; defaults match local agent stacks):
  LIBRARIAN_URL        — default http://localhost:5050
  COMPANY_RESEARCH_URL — default http://localhost:5055
  SAC_AUDIT_LOG_PATH   — default ./sac_audit.jsonl under se-copilot
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

import anthropic
import httpx
import markdown as md_lib
from fastapi import APIRouter, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from starlette.responses import Response
from weasyprint import HTML

from config import settings
from page_prompts import system_prompt_for

log = logging.getLogger("sac.extension")
router = APIRouter(prefix="/api/sac", tags=["support-admin-copilot"])

LIBRARIAN_URL = os.getenv("LIBRARIAN_URL", "http://localhost:5050")
COMPANY_RESEARCH_URL = os.getenv("COMPANY_RESEARCH_URL", "http://localhost:5055")
AUDIT_LOG_PATH = Path(os.getenv("SAC_AUDIT_LOG_PATH", str(Path(__file__).resolve().parent / "sac_audit.jsonl")))


# ---------- Schemas ----------


class PageContext(BaseModel):
    url: Optional[str] = None
    pathname: Optional[str] = None
    title: Optional[str] = None
    pageType: Optional[str] = None
    headings: list[dict] = Field(default_factory=list)
    filters: list[str] = Field(default_factory=list)
    entityRows: list[str] = Field(default_factory=list)
    capturedAt: Optional[str] = None
    scrollHeight: Optional[int] = None
    viewportHeight: Optional[int] = None


class HistoryTurn(BaseModel):
    role: str
    content: str
    hasImage: bool = False


class AnalyzeRequest(BaseModel):
    prompt: str
    image: Optional[str] = None  # data URL
    pageContext: Optional[PageContext] = None
    history: list[HistoryTurn] = Field(default_factory=list)


class AnalyzeResponse(BaseModel):
    text: str
    observations: list[str] = Field(default_factory=list)
    next_steps: list[str] = Field(default_factory=list)
    annotations: list[dict] = Field(default_factory=list)


class ReportRequest(BaseModel):
    observations: list[str] = Field(default_factory=list)
    history: list[HistoryTurn] = Field(default_factory=list)
    pageContext: Optional[PageContext] = None
    accountName: Optional[str] = None


class ReportResponse(BaseModel):
    report: str


class ReportPdfRequest(BaseModel):
    """Render an existing markdown report to PDF (no LLM call)."""

    report: str


class ContextRequest(BaseModel):
    accountName: Optional[str] = None
    pageType: Optional[str] = None


class ContextResponse(BaseModel):
    accountContext: Optional[str] = None
    productContext: Optional[str] = None


# ---------- Audit logging ----------


def _audit(event: str, session_id: str, data: dict):
    try:
        AUDIT_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with AUDIT_LOG_PATH.open("a") as f:
            f.write(
                json.dumps(
                    {
                        "ts": datetime.utcnow().isoformat() + "Z",
                        "event": event,
                        "session_id": session_id,
                        **data,
                    }
                )
                + "\n"
            )
    except Exception as e:
        log.warning("audit write failed: %s", e)


# ---------- Vision / analysis ----------


SYSTEM_REPORT = """You generate customer-facing reports for a Datadog Sales Engineer \
summarizing observability findings from a Support Admin session.

Output a well-structured report with these sections where applicable:
  1. Executive Summary (3-5 sentences)
  2. Current State Observations
  3. Observability Gaps Identified
  4. Recommended Monitors (specific, with suggested thresholds where inferable)
  5. Suggested Next Steps

Tone: professional, specific, grounded. Use named services and actual numbers \
from the observations. Never invent metrics. If you don't know something, omit it.
"""


def _data_url_to_image_block(data_url: str) -> dict:
    """Convert a data: URL to an Anthropic image content block."""
    m = re.match(r"^data:(image/[a-zA-Z+]+);base64,(.+)$", data_url)
    if not m:
        raise HTTPException(400, "Invalid image data URL")
    media_type, b64 = m.group(1), m.group(2)
    return {
        "type": "image",
        "source": {"type": "base64", "media_type": media_type, "data": b64},
    }


def _format_page_context(ctx: Optional[PageContext]) -> str:
    if not ctx:
        return "(no page context)"
    parts = [
        f"URL: {ctx.url}",
        f"Page type: {ctx.pageType}",
        f"Title: {ctx.title}",
    ]
    if ctx.filters:
        parts.append("Active filters: " + "; ".join(ctx.filters[:20]))
    if ctx.headings:
        parts.append("Headings: " + "; ".join(h.get("text", "") for h in ctx.headings[:10]))
    if ctx.entityRows:
        parts.append(f"Visible entity rows ({len(ctx.entityRows)} total, first 30):")
        parts.extend(f"  - {row}" for row in ctx.entityRows[:30])
    return "\n".join(parts)


def _extract_json_block(text: str) -> dict:
    m = re.search(r"```json\s*(\{.*?\})\s*```", text, re.DOTALL)
    if not m:
        return {}
    try:
        return json.loads(m.group(1))
    except json.JSONDecodeError:
        return {}


def _anthropic_client() -> anthropic.AsyncAnthropic:
    if not settings.anthropic_api_key:
        raise HTTPException(500, "ANTHROPIC_API_KEY not configured")
    return anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)


@router.post("/analyze", response_model=AnalyzeResponse)
async def analyze(req: AnalyzeRequest) -> AnalyzeResponse:
    session_id = str(uuid.uuid4())[:8]
    _audit(
        "analyze",
        session_id,
        {
            "page_type": req.pageContext.pageType if req.pageContext else None,
            "has_image": bool(req.image),
            "prompt_len": len(req.prompt),
        },
    )

    client = _anthropic_client()

    content: list[dict[str, Any]] = []
    if req.image:
        content.append(_data_url_to_image_block(req.image))
    content.append(
        {
            "type": "text",
            "text": f"Page context:\n{_format_page_context(req.pageContext)}\n\nSE question: {req.prompt}",
        }
    )

    messages = []
    for turn in req.history[-8:]:
        messages.append({"role": turn.role, "content": turn.content})
    messages.append({"role": "user", "content": content})

    try:
        page_type = req.pageContext.pageType if req.pageContext else None
        system = system_prompt_for(page_type)
        resp = await client.messages.create(
            model=settings.claude_model,
            max_tokens=1500,
            system=system,
            messages=messages,
        )
    except Exception as e:
        log.exception("analyze call failed")
        raise HTTPException(502, f"Claude call failed: {e}") from e

    text = "".join(b.text for b in resp.content if getattr(b, "type", "") == "text")
    extras = _extract_json_block(text)
    display_text = re.sub(r"```json\s*\{.*?\}\s*```", "", text, flags=re.DOTALL).strip()

    obs_raw = extras.get("observations") or []
    if not isinstance(obs_raw, list):
        obs_raw = []
    next_raw = extras.get("next_steps") or []
    if not isinstance(next_raw, list):
        next_raw = []

    return AnalyzeResponse(
        text=display_text,
        observations=[str(x) for x in obs_raw],
        next_steps=[str(x) for x in next_raw],
        annotations=[],
    )


async def _fetch_account_context(account_name: str) -> Optional[str]:
    if not account_name:
        return None
    async with httpx.AsyncClient(timeout=15.0) as hc:
        try:
            r = await hc.post(f"{COMPANY_RESEARCH_URL}/brief", json={"account": account_name})
            if r.status_code == 200:
                return r.json().get("brief")
        except Exception as e:
            log.info("company research unavailable: %s", e)
    return None


async def _fetch_product_context(page_type: str) -> Optional[str]:
    if not page_type:
        return None
    async with httpx.AsyncClient(timeout=15.0) as hc:
        try:
            r = await hc.post(
                f"{LIBRARIAN_URL}/search",
                json={"query": f"{page_type} monitor best practices"},
            )
            if r.status_code == 200:
                data = r.json()
                chunks = data.get("results", [])[:5]
                return "\n\n".join(c.get("text", "") for c in chunks)
        except Exception as e:
            log.info("librarian unavailable: %s", e)
    return None


@router.post("/context", response_model=ContextResponse)
async def context(req: ContextRequest) -> ContextResponse:
    acc = await _fetch_account_context(req.accountName) if req.accountName else None
    prod = await _fetch_product_context(req.pageType) if req.pageType else None
    return ContextResponse(accountContext=acc, productContext=prod)


@router.post("/report", response_model=ReportResponse)
async def report(req: ReportRequest) -> ReportResponse:
    session_id = str(uuid.uuid4())[:8]
    _audit(
        "report",
        session_id,
        {
            "obs_count": len(req.observations),
            "history_len": len(req.history),
            "account": req.accountName,
        },
    )

    client = _anthropic_client()

    grounding = ""
    if req.accountName:
        acc = await _fetch_account_context(req.accountName)
        if acc:
            grounding += f"\n\nAccount context:\n{acc}"
    if req.pageContext and req.pageContext.pageType:
        prod = await _fetch_product_context(req.pageContext.pageType)
        if prod:
            grounding += f"\n\nProduct reference:\n{prod}"

    obs_block = "\n".join(f"- {o}" for o in req.observations) or "(no observations)"
    hist_block = "\n".join(f"[{t.role}] {t.content[:400]}" for t in req.history[-20:])

    user_msg = (
        f"Observations collected during session:\n{obs_block}\n\n"
        f"Recent session transcript:\n{hist_block}\n"
        f"{grounding}"
    )

    try:
        resp = await client.messages.create(
            model=settings.claude_model,
            max_tokens=3000,
            system=SYSTEM_REPORT,
            messages=[{"role": "user", "content": user_msg}],
        )
    except Exception as e:
        log.exception("report call failed")
        raise HTTPException(502, f"Claude call failed: {e}") from e

    text = "".join(b.text for b in resp.content if getattr(b, "type", "") == "text")
    return ReportResponse(report=text)


_SAC_REPORT_PDF_CSS = """
@page { size: letter; margin: 0.75in 0.85in; }
body { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; font-size: 10.5pt;
  line-height: 1.55; color: #1a1a2e; }
h1 { font-size: 18pt; color: #632CA6; border-bottom: 2px solid #632CA6; padding-bottom: 6pt; margin-top: 0; }
h2 { font-size: 13pt; color: #333; margin-top: 16pt; }
h3 { font-size: 11pt; color: #444; }
p { margin: 0 0 8pt 0; }
ul, ol { margin: 0 0 10pt 16pt; padding: 0; }
li { margin-bottom: 4pt; }
code { font-size: 9.5pt; background: #f4f4f8; padding: 1pt 4pt; border-radius: 2pt; }
pre { background: #f4f4f8; padding: 10pt; border-radius: 4pt; font-size: 9pt; overflow-wrap: break-word; }
pre code { background: none; padding: 0; }
blockquote { border-left: 3pt solid #632CA6; margin: 10pt 0; padding-left: 12pt; color: #444; }
table { border-collapse: collapse; width: 100%; margin: 10pt 0; font-size: 9.5pt; }
th, td { border: 1px solid #ccc; padding: 6pt 8pt; text-align: left; }
th { background: #f0ebf8; }
"""


def _sac_report_html_for_pdf(markdown_body: str) -> str:
    body_html = md_lib.markdown(
        markdown_body,
        extensions=["extra", "nl2br", "sane_lists"],
    )
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Support Admin Report</title>
<style>{_SAC_REPORT_PDF_CSS}</style>
</head>
<body>
<article class="sac-report">{body_html}</article>
</body>
</html>"""


def _sac_report_to_pdf_bytes_sync(markdown_body: str) -> bytes:
    html = _sac_report_html_for_pdf(markdown_body)
    return HTML(string=html).write_pdf()


@router.post("/report/pdf")
async def report_pdf(req: ReportPdfRequest) -> Response:
    """Convert markdown report text to a PDF download."""
    if not req.report or not req.report.strip():
        raise HTTPException(status_code=400, detail="report text is empty")

    loop = asyncio.get_event_loop()
    try:
        pdf_bytes = await loop.run_in_executor(
            None, _sac_report_to_pdf_bytes_sync, req.report
        )
    except Exception as e:
        log.exception("SAC PDF generation failed")
        raise HTTPException(status_code=500, detail=f"PDF generation failed: {e}") from e

    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": 'attachment; filename="support-admin-report.pdf"',
        },
    )


def create_app():
    """Standalone FastAPI app for local dev without the full SE Copilot stack."""
    from fastapi import FastAPI

    dev = FastAPI(title="Support Admin Copilot backend")
    dev.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"(chrome-extension://.*|http://localhost(:\d+)?)",
        allow_methods=["*"],
        allow_headers=["*"],
    )
    dev.include_router(router)

    @dev.get("/health")
    def health():
        return {"ok": True, "model": settings.claude_model}

    return dev


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(create_app(), host="127.0.0.1", port=5060)
