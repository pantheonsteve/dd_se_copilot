"""PDF export for Release Notes Digests.

Same WeasyPrint pipeline as precall_export.py and call_note_export.py.
Renders the digest as a clean, customer-facing newsletter PDF.
Talk tracks and relevance scores are intentionally excluded.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from pathlib import Path

from weasyprint import HTML

logger = logging.getLogger(__name__)

# Output directory — sibling to the DB file
_DIGEST_DIR = Path(__file__).resolve().parent / "release_digests"
_DIGEST_DIR.mkdir(exist_ok=True)


def get_digest_dir() -> Path:
    _DIGEST_DIR.mkdir(exist_ok=True)
    return _DIGEST_DIR


# ---------------------------------------------------------------------------
# Category accent colors (matches the UI)
# ---------------------------------------------------------------------------

_CATEGORY_COLORS: dict[str, str] = {
    "APM":                    "#7c3aed",
    "Infrastructure":         "#2563eb",
    "Logs":                   "#0891b2",
    "RUM":                    "#059669",
    "Security":               "#dc2626",
    "Synthetics":             "#d97706",
    "Databases":              "#7c2d12",
    "Network Monitoring":     "#4338ca",
    "CI Visibility":          "#0d9488",
    "Cloud Cost":             "#16a34a",
    "Platform/Admin":         "#64748b",
    "AI/ML Observability":    "#9333ea",
    "Integrations":           "#ea580c",
    "Other":                  "#94a3b8",
}

_DEFAULT_COLOR = "#64748b"

# ---------------------------------------------------------------------------
# HTML template
# ---------------------------------------------------------------------------

_PDF_TEMPLATE = """\
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
@page {{
    size: letter;
    margin: 0.7in 0.85in 0.85in 0.85in;
    @bottom-center {{
        content: counter(page) " / " counter(pages);
        font-size: 8pt;
        color: #9ca3af;
        font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    }}
    @bottom-right {{
        content: "Datadog Weekly \00B7 {company}";
        font-size: 8pt;
        color: #9ca3af;
        font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    }}
}}

* {{ box-sizing: border-box; margin: 0; padding: 0; }}

body {{
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    font-size: 10pt;
    line-height: 1.6;
    color: #111827;
    background: #ffffff;
}}

/* ---- Header ---- */
.header {{
    border-bottom: 3pt solid #632CA6;
    padding-bottom: 14pt;
    margin-bottom: 20pt;
}}
.header-eyebrow {{
    font-size: 7.5pt;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: #9ca3af;
    margin-bottom: 3pt;
}}
.header-dateline {{
    font-size: 7.5pt;
    color: #9ca3af;
    margin-bottom: 10pt;
}}
.header h1 {{
    font-size: 18pt;
    font-weight: 800;
    line-height: 1.2;
    color: #111827;
    margin-bottom: 10pt;
}}
.header .intro {{
    font-size: 10.5pt;
    line-height: 1.7;
    color: #374151;
}}

/* ---- Section labels ---- */
.section-label {{
    font-size: 7.5pt;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: #9ca3af;
    margin-bottom: 10pt;
    margin-top: 18pt;
    border-bottom: 1pt solid #f3f4f6;
    padding-bottom: 4pt;
}}

/* ---- Release cards ---- */
.release {{
    border: 1pt solid #e5e7eb;
    border-radius: 6pt;
    padding: 10pt 12pt;
    margin-bottom: 8pt;
    page-break-inside: avoid;
}}
.release.featured {{
    border-left-width: 3pt;
}}
.release-meta {{
    display: flex;
    align-items: center;
    gap: 8pt;
    margin-bottom: 5pt;
    flex-wrap: wrap;
}}
.release-category {{
    font-size: 7pt;
    font-weight: 700;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    padding: 1.5pt 5pt;
    border-radius: 3pt;
    display: inline-block;
}}
.release-date {{
    font-size: 8pt;
    color: #9ca3af;
}}
.release-title {{
    font-size: 11pt;
    font-weight: 700;
    line-height: 1.3;
    color: #111827;
    margin-bottom: 5pt;
}}
.release-title a {{
    color: #111827;
    text-decoration: none;
}}
.release-why {{
    font-size: 9.5pt;
    line-height: 1.65;
    color: #374151;
    margin-bottom: 5pt;
}}
.release-docs-link {{
    font-size: 8.5pt;
    font-weight: 600;
    margin-bottom: 7pt;
}}
.release-docs-link a {{
    text-decoration: none;
}}
.release-cta {{
    font-size: 8.5pt;
    color: #6b7280;
    font-style: italic;
}}

/* ---- Additional releases compact list ---- */
.additional-releases {{
    margin-top: 4pt;
}}
.additional-row {{
    padding: 5pt 0 6pt 0;
    border-bottom: 0.5pt solid #f3f4f6;
    page-break-inside: avoid;
}}
.additional-top {{
    margin-bottom: 2pt;
}}
.additional-title {{
    font-size: 9.5pt;
    font-weight: 700;
    color: #111827;
    text-decoration: none;
}}
.additional-meta {{
    font-size: 7.5pt;
    color: #9ca3af;
    margin-top: 1pt;
    margin-bottom: 2.5pt;
}}
.additional-desc {{
    font-size: 8.5pt;
    line-height: 1.55;
    color: #6b7280;
    margin: 0 0 2.5pt 0;
}}
.additional-links {{
    font-size: 7.5pt;
}}
.additional-link {{
    color: #6b7280;
    text-decoration: none;
    font-weight: 600;
}}

/* ---- Footer ---- */
.footer {{
    margin-top: 22pt;
    padding-top: 12pt;
    border-top: 1.5pt solid #632CA6;
}}
.footer .closing {{
    font-size: 10.5pt;
    line-height: 1.7;
    color: #374151;
    margin-bottom: 10pt;
}}
.footer .generated {{
    font-size: 7.5pt;
    color: #9ca3af;
}}
</style>
</head>
<body>

<!-- Header -->
<div class="header">
  <div class="header-eyebrow">Datadog Weekly &middot; {company}</div>
  <div class="header-dateline">Week of {week_of}</div>
  <h1>{headline}</h1>
  <p class="intro">{intro_paragraph}</p>
</div>

{releases_html}

<!-- Footer -->
<div class="footer">
  <p class="closing">{closing_paragraph}</p>
  <p class="generated">Generated by SE Copilot &middot; {date_str}</p>
</div>

</body>
</html>
"""


# ---------------------------------------------------------------------------
# HTML builder
# ---------------------------------------------------------------------------

def _esc(s: object) -> str:
    return (
        str(s or "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def _fmt_date(iso: str) -> str:
    """Parse both ISO 8601 and RFC 2822 date strings (RSS pubDate format)."""
    if not iso:
        return ""
    # Try ISO 8601 first (e.g. "2026-03-06T00:00:00Z")
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).strftime("%b %d, %Y")
    except (ValueError, TypeError):
        pass
    # Fall back to RFC 2822 (e.g. "Fri, 06 Mar 2026 00:00:00 GMT")
    from email.utils import parsedate_to_datetime
    try:
        return parsedate_to_datetime(iso).strftime("%b %d, %Y")
    except Exception:
        pass
    # Last resort: return whatever we have trimmed
    return iso.strip()[:16]


def _release_card(r: dict, featured: bool, cta_line: str) -> str:
    color = _CATEGORY_COLORS.get(r.get("category", "Other"), _DEFAULT_COLOR)
    border_style = f'border-left-color: {color};' if featured else ""
    category_style = (
        f'background: {color}18; color: {color}; border: 1pt solid {color}33;'
    )
    title_html = (
        f'<a href="{_esc(r.get("link",""))}">{_esc(r.get("title",""))}</a>'
        if r.get("link")
        else _esc(r.get("title", ""))
    )
    date_html = (
        f'<span class="release-date">{_fmt_date(r.get("published",""))}</span>'
        if r.get("published")
        else ""
    )
    # Curated cards: only show docs and blog links — no SDK changelogs or misc links
    link_items: list[tuple[str, str]] = []  # (label, url)
    docs_link = r.get("docs_link", "").strip()
    if docs_link:
        link_items.append(("View documentation", docs_link))
    for lnk in r.get("feed_links", []):
        url = lnk.get("url", "").strip()
        if not url or url == docs_link or url == r.get("link", ""):
            continue
        if "datadoghq.com/blog" in url:
            link_items.append(("Read blog post", url))
        # Skip GitHub/SDK links, misc named links, and anything else

    if link_items:
        link_parts = " &nbsp;&middot;&nbsp; ".join(
            f'<a href="{_esc(url)}" style="color: {color};">{_esc(label)} &rarr;</a>'
            for label, url in link_items
        )
        docs_html = f'<p class="release-docs-link">{link_parts}</p>'
    else:
        docs_html = ""

    return f"""
<div class="release {'featured' if featured else ''}" style="{border_style}">
  <div class="release-meta">
    <span class="release-category" style="{category_style}">{_esc(r.get("category","Other"))}</span>
    {date_html}
  </div>
  <div class="release-title">{title_html}</div>
  <p class="release-why">{_esc(r.get("why_it_matters",""))}</p>
  {docs_html}
  <p class="release-cta">{_esc(cta_line)}</p>
</div>"""


def digest_to_html(digest: dict) -> str:
    """Convert a digest dict to a complete HTML document string."""
    company = digest.get("company_name", "Customer")
    headline = digest.get("headline", "Your Datadog Update")
    intro = digest.get("intro_paragraph", "")
    closing = digest.get("closing_paragraph", "")
    cta_line = digest.get("cta_line", "Interested in a closer look? Happy to set up a quick demo.")
    featured = digest.get("featured_releases") or []
    others = digest.get("other_relevant_releases") or []

    now = datetime.now(timezone.utc)
    date_str = now.strftime("%B %d, %Y")
    week_of = now.strftime("%B %d, %Y")

    releases_parts: list[str] = []

    if featured:
        releases_parts.append('<div class="section-label">&#9733; Featured &mdash; Must Reads</div>')
        for r in featured:
            releases_parts.append(_release_card(r, featured=True, cta_line=cta_line))

    if others:
        releases_parts.append('<div class="section-label">Also Relevant This Week</div>')
        for r in others:
            releases_parts.append(_release_card(r, featured=False, cta_line=cta_line))

    if not featured and not others:
        releases_parts.append(
            '<p style="color:#9ca3af;font-size:10pt;margin-top:16pt;">'
            "No releases met the relevance threshold for this account."
            "</p>"
        )

    # Additional releases — compact list below the curated content
    additional = digest.get("additional_releases") or []
    if additional:
        releases_parts.append('<div class="section-label">Also Released This Period</div>')
        releases_parts.append('<div class="additional-releases">')
        for r in additional:
            color = _CATEGORY_COLORS.get(r.get("category", "Other"), _DEFAULT_COLOR)
            category_style = f"background: {color}18; color: {color}; border: 1pt solid {color}33;"
            date_str = _fmt_date(r.get("published", ""))

            # Collect links — release notes, docs, and blog only (no SDK/misc)
            link_parts: list[str] = []
            if r.get("link"):
                link_parts.append(
                    f'<a href="{_esc(r["link"])}" class="additional-link">Release notes</a>'
                )
            if r.get("docs_link"):
                link_parts.append(
                    f'<a href="{_esc(r["docs_link"])}" class="additional-link" style="color:{color};">Docs</a>'
                )
            for lnk in r.get("feed_links", []):
                url = lnk.get("url", "").strip()
                if not url or url == r.get("link") or url == r.get("docs_link"):
                    continue
                if "datadoghq.com/blog" in url:
                    link_parts.append(
                        f'<a href="{_esc(url)}" class="additional-link">Blog</a>'
                    )
                # Skip GitHub/SDK and misc named links

            links_html_inner = " &middot; ".join(link_parts)

            title_html = (
                f'<a href="{_esc(r["link"])}" class="additional-title">{_esc(r.get("title", ""))}</a>'
                if r.get("link") else
                f'<span class="additional-title">{_esc(r.get("title", ""))}</span>'
            )

            desc = r.get("why_it_matters", "").strip()
            desc_html = (
                f'<p class="additional-desc">{_esc(desc)}</p>'
                if desc else ""
            )

            # Build meta line: category chip + date
            meta_parts = []
            meta_parts.append(
                f'<span class="release-category" style="{category_style}">'
                f'{_esc(r.get("category", "Other"))}</span>'
            )
            if date_str:
                meta_parts.append(f'&nbsp;&nbsp;{_esc(date_str)}')
            meta_html = f'<p class="additional-meta">{" ".join(meta_parts)}</p>'

            releases_parts.append(
                f'<div class="additional-row">'
                f'<div class="additional-top">{title_html}</div>'
                f'{meta_html}'
                f'{desc_html}'
                f'{("<p class=\"additional-links\">" + links_html_inner + "</p>") if link_parts else ""}'
                f'</div>'
            )
        releases_parts.append('</div>')

    return _PDF_TEMPLATE.format(
        company=_esc(company),
        week_of=_esc(week_of),
        headline=_esc(headline),
        intro_paragraph=_esc(intro),
        releases_html="\n".join(releases_parts),
        closing_paragraph=_esc(closing),
        date_str=_esc(date_str),
    )


# ---------------------------------------------------------------------------
# PDF writer
# ---------------------------------------------------------------------------

def _write_pdf_sync(html: str, out_path: Path) -> None:
    logger.info("WeasyPrint: writing digest PDF, html_len=%d, out=%s", len(html), out_path)
    try:
        HTML(string=html).write_pdf(str(out_path))
        logger.info("WeasyPrint: completed %s", out_path)
    except Exception as exc:
        logger.exception("WeasyPrint failed: %s", exc)
        raise


def generate_digest_pdf(digest_id: str, digest: dict) -> Path:
    out_path = get_digest_dir() / f"{digest_id}.pdf"
    html = digest_to_html(digest)
    _write_pdf_sync(html, out_path)
    return out_path


async def generate_digest_pdf_async(digest_id: str, digest: dict) -> Path:
    out_path = get_digest_dir() / f"{digest_id}.pdf"
    html = digest_to_html(digest)
    loop = asyncio.get_running_loop()
    await asyncio.wait_for(
        loop.run_in_executor(None, _write_pdf_sync, html, out_path),
        timeout=60.0,
    )
    return out_path
