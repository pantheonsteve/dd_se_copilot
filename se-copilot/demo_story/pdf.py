"""PDF generation for demo plans using WeasyPrint."""

import logging
from datetime import datetime, timezone
from pathlib import Path

import markdown as md_lib
from weasyprint import HTML

from config import settings

logger = logging.getLogger(__name__)

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
        content: "Datadog SE Copilot";
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

/* Header */
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
    display: flex;
    gap: 18pt;
}}
.pdf-header .meta span {{
    margin-right: 18pt;
}}

/* Sections */
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
h4 {{
    font-size: 11pt;
    color: #444;
    margin-top: 14pt;
    page-break-after: avoid;
}}

/* Talk tracks — amber highlight */
blockquote {{
    background: #FFF8E1;
    border-left: 4px solid #F59E0B;
    padding: 8pt 12pt;
    margin: 8pt 0;
    font-style: italic;
    page-break-inside: avoid;
}}

/* Lists */
ul, ol {{
    padding-left: 20pt;
}}
li {{
    margin-bottom: 3pt;
}}

/* Code blocks */
pre {{
    background: #f5f5f5;
    padding: 8pt;
    border-radius: 3pt;
    font-size: 9pt;
    overflow-wrap: break-word;
    white-space: pre-wrap;
}}
code {{
    font-size: 9pt;
    background: #f0f0f0;
    padding: 1pt 3pt;
    border-radius: 2pt;
}}

/* Bold phase markers */
strong {{
    color: #1a1a2e;
}}

/* Tables */
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

/* Loop sections — keep together */
h4 + p, h4 + ul {{
    page-break-before: avoid;
}}

/* Page break before major sections */
.page-break {{
    page-break-before: always;
}}

hr {{
    border: none;
    border-top: 1px solid #ddd;
    margin: 16pt 0;
}}
</style>
</head>
<body>

<div class="pdf-header">
    <h1>{title}</h1>
    <div class="meta">
        <span><strong>Company:</strong> {company}</span>
        <span><strong>Persona:</strong> {persona}</span>
        <span><strong>Mode:</strong> {mode}</span>
        <span><strong>Generated:</strong> {date}</span>
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


def generate_pdf(
    plan_id: str,
    markdown_text: str,
    company_name: str,
    persona_title: str,
    demo_mode: str,
) -> Path:
    """Convert a demo plan markdown to PDF. Returns path to generated file."""
    settings.demo_plans_dir.mkdir(parents=True, exist_ok=True)
    out_path = settings.demo_plans_dir / f"{plan_id}.pdf"

    body_html = md_lib.markdown(
        markdown_text,
        extensions=["tables", "fenced_code", "nl2br"],
    )
    body_html = _add_page_breaks(body_html)

    mode_label = demo_mode.replace("_", " ").title()
    date_str = datetime.now(timezone.utc).strftime("%B %d, %Y")

    full_html = _PDF_TEMPLATE.format(
        title=f"{company_name} — {persona_title} Demo Plan",
        company=company_name,
        persona=persona_title,
        mode=mode_label,
        date=date_str,
        body=body_html,
    )

    HTML(string=full_html).write_pdf(str(out_path))
    logger.info("Generated PDF: %s", out_path)
    return out_path
