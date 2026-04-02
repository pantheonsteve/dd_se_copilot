"""Export call note JSON summaries to Markdown and PDF."""

import asyncio
import json
import logging
import re
from datetime import datetime, timezone
from pathlib import Path

import markdown as md_lib
from weasyprint import HTML

from config import settings

logger = logging.getLogger(__name__)


def _safe_load(summary_markdown: str) -> dict | None:
    """Parse the summary JSON, returning None on failure."""
    try:
        return json.loads(summary_markdown)
    except (json.JSONDecodeError, TypeError):
        return None


def _bullet_list(items: list[str], indent: int = 0) -> str:
    prefix = "  " * indent
    return "\n".join(f"{prefix}- {item}" for item in items if item) or f"{prefix}- _None identified_"


def _stakeholder_block(s: dict) -> str:
    tags = ", ".join(s.get("role_tags", []))
    name_line = f"**{s.get('name', 'Unknown')}**"
    if s.get("org"):
        name_line += f" ({s['org']})"
    sub_items = []
    if s.get("title"):
        sub_items.append(f"- Title: {s['title']}")
    if tags:
        sub_items.append(f"- Roles: {tags}")
    if s.get("notes"):
        sub_items.append(f"- {s['notes']}")
    if sub_items:
        return name_line + "\n\n" + "\n".join(sub_items)
    return name_line


def _pain_block(p: dict) -> str:
    urgency = p.get("urgency", "Unknown")
    text = f"**{p.get('pain', 'N/A')}** (Urgency: {urgency})"
    if p.get("impact"):
        text += f"\n\n- Impact: {p['impact']}"
    return text


def _objection_block(o: dict) -> str:
    status = o.get("status", "Raised")
    otype = o.get("type", "")
    label = f" [{otype}]" if otype else ""
    return f"**{o.get('objection', 'N/A')}**{label} — _{status}_"


def _next_step_block(ns: dict) -> str:
    owner = ns.get("owner", "TBD")
    side = ns.get("owner_side", "")
    due = ns.get("due", "")
    text = f"**{ns.get('action', 'N/A')}**"
    sub_items = [f"- Owner: {owner}" + (f" ({side})" if side else "")]
    if due:
        sub_items.append(f"- Due: {due}")
    return text + "\n\n" + "\n".join(sub_items)


def summary_to_markdown(data: dict, title: str = "", company_name: str = "") -> str:
    """Convert a structured call note JSON dict into formatted Markdown."""
    sections: list[str] = []

    # Title
    heading = title or "Call Summary"
    if company_name and not heading.startswith(company_name):
        heading = f"{company_name} — {heading}"
    sections.append(f"# {heading}")

    # Call Context
    ctx = data.get("call_context", {})
    if any(ctx.values()):
        meta_parts = []
        if ctx.get("date"):
            meta_parts.append(f"**Date:** {ctx['date']}")
        if ctx.get("duration_estimate"):
            meta_parts.append(f"**Duration:** {ctx['duration_estimate']}")
        if ctx.get("call_type"):
            meta_parts.append(f"**Type:** {ctx['call_type']}")
        if ctx.get("deal_stage"):
            meta_parts.append(f"**Deal Stage:** {ctx['deal_stage']}")
        if meta_parts:
            sections.append(" | ".join(meta_parts))

    # Stakeholders
    stakeholders = data.get("stakeholders", [])
    if stakeholders:
        sections.append("## Stakeholders")
        sections.append("\n\n".join(_stakeholder_block(s) for s in stakeholders))

    # Technical Requirements
    tech = data.get("technical_requirements", {})
    has_tech = any([
        tech.get("current_stack"),
        tech.get("integrations_needed"),
        tech.get("infrastructure_notes"),
        tech.get("security_compliance"),
        tech.get("technical_goals"),
    ])
    if has_tech:
        sections.append("## Technical Requirements")
        if tech.get("current_stack"):
            sections.append("### Current Stack\n\n" + _bullet_list(tech["current_stack"]))
        if tech.get("integrations_needed"):
            sections.append("### Integrations Needed\n\n" + _bullet_list(tech["integrations_needed"]))
        if tech.get("infrastructure_notes"):
            sections.append(f"### Infrastructure\n\n{tech['infrastructure_notes']}")
        if tech.get("security_compliance"):
            sections.append("### Security & Compliance\n\n" + _bullet_list(tech["security_compliance"]))
        if tech.get("technical_goals"):
            sections.append("### Technical Goals\n\n" + _bullet_list(tech["technical_goals"]))

    # Pain Points
    pains = data.get("pain_points", [])
    if pains:
        sections.append("## Pain Points")
        sections.append("\n\n".join(_pain_block(p) for p in pains))

    # Business Drivers
    biz = data.get("business_drivers", {})
    if biz.get("why_now") or biz.get("business_context"):
        sections.append("## Business Drivers")
        if biz.get("why_now"):
            sections.append(f"**Why Now:** {biz['why_now']}")
        if biz.get("business_context"):
            sections.append(f"**Business Context:** {biz['business_context']}")

    # Competitive Ecosystem
    comp = data.get("competitive_ecosystem", {})
    has_comp = any([
        comp.get("incumbents"),
        comp.get("also_evaluating"),
        comp.get("required_integrations"),
        comp.get("notes"),
    ])
    if has_comp:
        sections.append("## Competitive Ecosystem")
        if comp.get("incumbents"):
            sections.append("### Incumbents\n\n" + _bullet_list(comp["incumbents"]))
        if comp.get("also_evaluating"):
            sections.append("### Also Evaluating\n\n" + _bullet_list(comp["also_evaluating"]))
        if comp.get("required_integrations"):
            sections.append("### Required Integrations\n\n" + _bullet_list(comp["required_integrations"]))
        if comp.get("notes"):
            sections.append(comp["notes"])

    # Decision Criteria
    dc = data.get("decision_criteria", {})
    has_dc = any([
        dc.get("must_haves"),
        dc.get("nice_to_haves"),
        dc.get("success_definition"),
        dc.get("evaluation_timeline"),
    ])
    if has_dc:
        sections.append("## Decision Criteria")
        if dc.get("must_haves"):
            sections.append("### Must-Haves\n\n" + _bullet_list(dc["must_haves"]))
        if dc.get("nice_to_haves"):
            sections.append("### Nice-to-Haves\n\n" + _bullet_list(dc["nice_to_haves"]))
        if dc.get("success_definition"):
            sections.append(f"**Success Definition:** {dc['success_definition']}")
        if dc.get("evaluation_timeline"):
            sections.append(f"**Evaluation Timeline:** {dc['evaluation_timeline']}")

    # Objections
    objections = data.get("objections", [])
    if objections:
        sections.append("## Objections")
        sections.append("\n\n".join(_objection_block(o) for o in objections))

    # Next Steps
    next_steps = data.get("next_steps", [])
    if next_steps:
        sections.append("## Next Steps")
        sections.append("\n\n".join(_next_step_block(ns) for ns in next_steps))

    # Signal Log
    sig = data.get("signal_log", {})
    has_sig = any([
        sig.get("buying_signals"),
        sig.get("risk_flags"),
        sig.get("open_questions"),
    ])
    if has_sig:
        sections.append("## Signal Log")
        if sig.get("buying_signals"):
            sections.append("### Buying Signals\n\n" + _bullet_list(sig["buying_signals"]))
        if sig.get("risk_flags"):
            sections.append("### Risk Flags\n\n" + _bullet_list(sig["risk_flags"]))
        if sig.get("open_questions"):
            sections.append("### Open Questions\n\n" + _bullet_list(sig["open_questions"]))

    # SE Notes
    if data.get("se_notes"):
        sections.append("## SE Notes")
        sections.append(data["se_notes"])

    return "\n\n".join(sections)


_PDF_TEMPLATE = """\
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
@page {{
    size: letter;
    margin: 0.75in 0.85in 0.85in 0.85in;
    @bottom-center {{
        content: counter(page) " / " counter(pages);
        font-size: 9pt;
        color: #666;
        font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    }}
    @bottom-right {{
        content: "SE Copilot — Call Notes";
        font-size: 8pt;
        color: #999;
        font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    }}
}}

* {{ box-sizing: border-box; }}

body {{
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    font-size: 10.5pt;
    line-height: 1.55;
    color: #1a1a2e;
}}

.pdf-header {{
    border-bottom: 3px solid #632CA6;
    padding-bottom: 12pt;
    margin-bottom: 18pt;
}}
.pdf-header h1 {{
    font-size: 18pt;
    margin: 0 0 4pt 0;
    color: #632CA6;
}}
.pdf-header .meta {{
    font-size: 9pt;
    color: #555;
}}
.pdf-header .meta span {{
    margin-right: 18pt;
}}

h2 {{
    font-size: 14pt;
    color: #632CA6;
    margin-top: 20pt;
    border-bottom: 1px solid #ddd;
    padding-bottom: 4pt;
    page-break-after: avoid;
}}
h3 {{
    font-size: 12pt;
    color: #333;
    margin-top: 16pt;
    page-break-after: avoid;
}}

ul, ol {{
    padding-left: 20pt;
}}
li {{
    margin-bottom: 3pt;
}}

strong {{
    color: #1a1a2e;
}}

em {{
    color: #555;
}}

table {{
    width: 100%;
    border-collapse: collapse;
    margin: 10pt 0;
    font-size: 9.5pt;
}}
th {{
    background: #632CA6;
    color: white;
    padding: 6pt 8pt;
    text-align: left;
}}
td {{
    padding: 5pt 8pt;
    border-bottom: 1px solid #eee;
}}
tr:nth-child(even) td {{
    background: #fafafa;
}}

hr {{
    border: none;
    border-top: 1px solid #ddd;
    margin: 16pt 0;
}}

.page-break {{
    page-break-before: always;
}}
</style>
</head>
<body>

<div class="pdf-header">
    <h1>{title}</h1>
    <div class="meta">
        {meta_html}
    </div>
</div>

{body}

</body>
</html>
"""


def _add_page_breaks(html: str) -> str:
    """Insert page-break divs before major H2 sections (except the first)."""
    parts = html.split("<h2")
    if len(parts) <= 1:
        return html
    result = parts[0]
    for i, part in enumerate(parts[1:], 1):
        if i > 1:
            result += '<div class="page-break"></div>'
        result += "<h2" + part
    return result


def _escape_braces(s: str) -> str:
    """Escape { and } so str.format() treats them as literals."""
    return s.replace("{", "{{").replace("}", "}}")


def _build_call_note_html(
    summary_json: str,
    title: str = "",
    company_name: str = "",
) -> str:
    """Build the full HTML document for a call note PDF."""
    data = _safe_load(summary_json)
    if data is None:
        body_html = md_lib.markdown(summary_json or "_No summary available._")
    else:
        md_text = summary_to_markdown(data, title=title, company_name=company_name)
        md_text = re.sub(r"^# .+\n*", "", md_text, count=1)
        body_html = md_lib.markdown(
            md_text,
            extensions=["tables", "fenced_code"],
        )

    body_html = _add_page_breaks(body_html)

    meta_parts = []
    if company_name:
        meta_parts.append(f"<span><strong>Company:</strong> {company_name}</span>")
    if data:
        ctx = data.get("call_context", {})
        if ctx.get("call_type"):
            meta_parts.append(f"<span><strong>Type:</strong> {ctx['call_type']}</span>")
        if ctx.get("date"):
            meta_parts.append(f"<span><strong>Call Date:</strong> {ctx['date']}</span>")
    date_str = datetime.now(timezone.utc).strftime("%B %d, %Y")
    meta_parts.append(f"<span><strong>Exported:</strong> {date_str}</span>")

    heading = title or "Call Summary"
    if company_name and not title.startswith(company_name):
        heading = f"{company_name} — {heading}"

    return _PDF_TEMPLATE.format(
        title=_escape_braces(heading),
        meta_html=_escape_braces(" ".join(meta_parts)),
        body=_escape_braces(body_html),
    )


def _write_pdf_sync(html: str, out_path: Path) -> None:
    """Synchronous WeasyPrint call — must be run in an executor."""
    HTML(string=html).write_pdf(str(out_path))


def generate_call_note_pdf(
    note_id: str,
    summary_json: str,
    title: str = "",
    company_name: str = "",
) -> Path:
    """Convert a call note summary JSON to PDF. Returns path to generated file."""
    settings.call_notes_dir.mkdir(parents=True, exist_ok=True)
    out_path = settings.call_notes_dir / f"{note_id}.pdf"
    full_html = _build_call_note_html(summary_json, title, company_name)
    _write_pdf_sync(full_html, out_path)
    logger.info("Generated call note PDF: %s", out_path)
    return out_path


async def generate_call_note_pdf_async(
    note_id: str,
    summary_json: str,
    title: str = "",
    company_name: str = "",
) -> Path:
    """Convert a call note summary JSON to PDF without blocking the event loop."""
    settings.call_notes_dir.mkdir(parents=True, exist_ok=True)
    out_path = settings.call_notes_dir / f"{note_id}.pdf"
    full_html = _build_call_note_html(summary_json, title, company_name)
    loop = asyncio.get_running_loop()
    await asyncio.wait_for(
        loop.run_in_executor(None, _write_pdf_sync, full_html, out_path),
        timeout=60.0,
    )
    logger.info("Generated call note PDF: %s", out_path)
    return out_path


def export_call_note_markdown(
    summary_json: str,
    title: str = "",
    company_name: str = "",
) -> str:
    """Convert a call note summary JSON to formatted Markdown string."""
    data = _safe_load(summary_json)
    if data is None:
        return summary_json or "_No summary available._"
    return summary_to_markdown(data, title=title, company_name=company_name)
