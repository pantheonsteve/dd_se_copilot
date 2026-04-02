"""SEC EDGAR 10-K filing ingestion pipeline.

Searches the SEC EDGAR API for publicly traded companies, downloads their
latest 10-K annual report, parses it into structured markdown by section,
and ingests it into ChromaDB for RAG queries.

Usage:
    python edgar_ingest.py --agent sec_edgar --company "Raytheon"
    python edgar_ingest.py --agent sec_edgar --ticker RTX
    python edgar_ingest.py --agent sec_edgar --company "Apple" --ticker AAPL
"""

import argparse
import json
import re
import sys
import time
from pathlib import Path

import httpx
from bs4 import BeautifulSoup
from markdownify import markdownify as md

from config import KNOWLEDGE_BASE_DIR, agent
from ingest import ingest_documents

SEC_USER_AGENT = agent.get("user_agent", "SECEdgarBot/1.0")
SEC_CONTACT_EMAIL = "se-copilot@example.com"
SEC_HEADERS = {
    "User-Agent": f"{SEC_USER_AGENT} ({SEC_CONTACT_EMAIL})",
    "Accept-Encoding": "gzip, deflate",
}

TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK{cik}.json"
ARCHIVES_BASE = "https://www.sec.gov/Archives/edgar/data"
EFTS_SEARCH_URL = "https://efts.sec.gov/LATEST/search-index"

_RATE_LIMIT_DELAY = 0.12

_SECTION_PATTERNS = [
    (r"item\s+1[\.\s]*(?:—|-|–)?\s*business", "business"),
    (r"item\s+1a[\.\s]*(?:—|-|–)?\s*risk\s+factors", "risk_factors"),
    (r"item\s+1b[\.\s]*(?:—|-|–)?\s*unresolved\s+staff\s+comments", "other"),
    (r"item\s+1c[\.\s]*(?:—|-|–)?\s*cybersecurity", "other"),
    (r"item\s+2[\.\s]*(?:—|-|–)?\s*properties", "other"),
    (r"item\s+3[\.\s]*(?:—|-|–)?\s*legal\s+proceedings", "other"),
    (r"item\s+4[\.\s]*(?:—|-|–)?\s*mine\s+safety", "other"),
    (r"item\s+5[\.\s]*(?:—|-|–)?\s*market\s+for", "other"),
    (r"item\s+6[\.\s]*(?:—|-|–)?\s*(?:reserved|\[reserved\]|selected)", "other"),
    (r"item\s+7[\.\s]*(?:—|-|–)?\s*management.s\s+discussion", "mda"),
    (r"item\s+7a[\.\s]*(?:—|-|–)?\s*quantitative\s+and\s+qualitative", "mda"),
    (r"item\s+8[\.\s]*(?:—|-|–)?\s*financial\s+statements", "financial_statements"),
    (r"item\s+9[\.\s]*(?:—|-|–)?\s*changes\s+in\s+and\s+disagreements", "other"),
    (r"item\s+9a[\.\s]*(?:—|-|–)?\s*controls\s+and\s+procedures", "other"),
    (r"item\s+9b[\.\s]*(?:—|-|–)?\s*other\s+information", "other"),
    (r"item\s+10[\.\s]*(?:—|-|–)?\s*directors", "other"),
    (r"item\s+11[\.\s]*(?:—|-|–)?\s*executive\s+compensation", "other"),
    (r"item\s+12[\.\s]*(?:—|-|–)?\s*security\s+ownership", "other"),
    (r"item\s+13[\.\s]*(?:—|-|–)?\s*certain\s+relationships", "other"),
    (r"item\s+14[\.\s]*(?:—|-|–)?\s*principal\s+account", "other"),
    (r"item\s+15[\.\s]*(?:—|-|–)?\s*exhibits", "other"),
]


def _sec_get(url: str, params: dict | None = None) -> httpx.Response:
    """Make a rate-limited GET request to SEC EDGAR."""
    time.sleep(_RATE_LIMIT_DELAY)
    resp = httpx.get(url, headers=SEC_HEADERS, params=params, follow_redirects=True, timeout=30)
    resp.raise_for_status()
    return resp


_tickers_cache: dict | None = None


def _load_tickers() -> dict:
    """Load the SEC company_tickers.json file (cached)."""
    global _tickers_cache
    if _tickers_cache is not None:
        return _tickers_cache

    print("Loading SEC ticker mapping ...")
    resp = _sec_get(TICKERS_URL)
    _tickers_cache = resp.json()
    return _tickers_cache


_COMPANY_SUFFIXES = re.compile(
    r"\s*\b(corporation|corp\.?|incorporated|inc\.?|company|co\.?|ltd\.?|"
    r"limited|llc|l\.l\.c\.?|plc|group|holdings?|enterprises?|"
    r"international|intl\.?|technologies|tech)\s*$",
    re.IGNORECASE,
)


def _normalize_company(name: str) -> str:
    """Strip common corporate suffixes for fuzzy matching."""
    return _COMPANY_SUFFIXES.sub("", name).strip().lower()


def search_companies(query: str) -> list[dict]:
    """Search for companies by name or ticker.

    Returns a list of dicts with keys: name, ticker, cik.
    Uses bidirectional substring matching and suffix-stripped
    normalization to handle variations like "Waters Corporation"
    vs "Waters Corp".
    """
    query_lower = query.strip().lower()
    query_norm = _normalize_company(query)
    tickers = _load_tickers()

    results = []
    seen_ciks = set()

    for entry in tickers.values():
        name = entry.get("title", "")
        ticker = entry.get("ticker", "")
        cik = str(entry.get("cik_str", ""))

        if cik in seen_ciks:
            continue

        name_lower = name.lower()
        name_norm = _normalize_company(name)
        ticker_lower = ticker.lower()

        match = (
            query_lower == ticker_lower
            or query_lower in name_lower
            or name_lower in query_lower
            or query_norm == name_norm
            or (len(query_norm) >= 3 and query_norm in name_norm)
            or (len(name_norm) >= 3 and name_norm in query_norm)
            or ticker_lower.startswith(query_lower)
        )

        if match:
            seen_ciks.add(cik)
            results.append({
                "name": name,
                "ticker": ticker,
                "cik": cik,
            })

    results.sort(key=lambda r: (
        0 if r["ticker"].lower() == query_lower else
        1 if _normalize_company(r["name"]) == query_norm else
        2 if query_lower in r["name"].lower() else
        3 if r["name"].lower() in query_lower else 4,
        r["name"],
    ))

    return results[:25]


def fetch_latest_10k(cik: str) -> dict | None:
    """Find the most recent 10-K filing for a company.

    Returns a dict with keys: accession, date, primary_document, or None.
    """
    padded_cik = cik.zfill(10)
    url = SUBMISSIONS_URL.format(cik=padded_cik)

    print(f"Fetching submissions for CIK {cik} ...")
    resp = _sec_get(url)
    data = resp.json()

    recent = data.get("filings", {}).get("recent", {})
    forms = recent.get("form", [])
    dates = recent.get("filingDate", [])
    accessions = recent.get("accessionNumber", [])
    primary_docs = recent.get("primaryDocument", [])

    for i, form in enumerate(forms):
        if form in ("10-K", "10-K/A"):
            return {
                "accession": accessions[i],
                "date": dates[i],
                "primary_document": primary_docs[i],
                "form": form,
            }

    return None


def download_10k(cik: str, accession: str, primary_document: str) -> str:
    """Download the 10-K filing HTML from SEC Archives."""
    accession_clean = accession.replace("-", "")
    url = f"{ARCHIVES_BASE}/{cik}/{accession_clean}/{primary_document}"

    print(f"Downloading 10-K from {url} ...")
    resp = _sec_get(url)
    return resp.text


def _classify_section(heading_text: str) -> str:
    """Classify a heading into a 10-K section category."""
    text = heading_text.strip().lower()
    text = re.sub(r"\s+", " ", text)

    for pattern, category in _SECTION_PATTERNS:
        if re.search(pattern, text, re.IGNORECASE):
            return category

    return "other"


def parse_10k(html: str, company_name: str, ticker: str, filing_date: str) -> list[dict]:
    """Parse 10-K HTML into structured markdown sections.

    Returns a list of dicts with keys: section, category, text.
    """
    soup = BeautifulSoup(html, "html.parser")

    for tag in soup.find_all(["script", "style", "noscript", "iframe", "svg"]):
        tag.decompose()

    body = soup.find("body") or soup
    markdown_text = md(str(body), heading_style="ATX", strip=["img"])
    markdown_text = re.sub(r"\n{3,}", "\n\n", markdown_text)
    markdown_text = markdown_text.strip()

    if not markdown_text:
        return []

    header = f"# {company_name} ({ticker}) — 10-K Annual Report\n\nFiling date: {filing_date}\n\n"

    sections = _split_into_sections(markdown_text)

    if not sections or (len(sections) == 1 and sections[0]["category"] == "other"):
        return [{
            "section": "full_filing",
            "category": "general",
            "text": header + markdown_text,
        }]

    docs = []
    for section in sections:
        section_text = header + f"## Section: {section['section']}\n\n{section['text']}"
        docs.append({
            "section": section["section"],
            "category": section["category"],
            "text": section_text,
        })

    return docs


def _split_into_sections(text: str) -> list[dict]:
    """Split markdown text into 10-K sections based on Item headings."""
    item_pattern = re.compile(
        r"^(#{1,4}\s*)?(?:PART\s+[IVX]+[.\s]*)?ITEM\s+\d+[A-C]?\s*[.—\-–]?\s*.+",
        re.IGNORECASE | re.MULTILINE,
    )

    matches = list(item_pattern.finditer(text))

    if not matches:
        return [{"section": "full_filing", "category": "other", "text": text}]

    sections = []
    for i, match in enumerate(matches):
        start = match.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        heading = match.group(0).strip().lstrip("#").strip()
        section_text = text[start:end].strip()
        category = _classify_section(heading)

        sections.append({
            "section": heading,
            "category": category,
            "text": section_text,
        })

    preamble = text[:matches[0].start()].strip()
    if preamble and len(preamble) > 200:
        sections.insert(0, {
            "section": "Cover & Preamble",
            "category": "business",
            "text": preamble,
        })

    return sections


def ingest_company(
    company_name: str | None = None,
    ticker: str | None = None,
    cik: str | None = None,
) -> dict:
    """Full pipeline: search company, download 10-K, parse, and ingest.

    Returns a summary dict with keys: ticker, company, filing_date, chunks, error.
    """
    if cik and ticker:
        company_info = {"name": company_name or ticker, "ticker": ticker, "cik": cik}
    elif ticker:
        matches = search_companies(ticker)
        exact = [m for m in matches if m["ticker"].upper() == ticker.upper()]
        if exact:
            company_info = exact[0]
        elif matches:
            company_info = matches[0]
        else:
            return {"error": f"No company found for ticker '{ticker}'"}
    elif company_name:
        matches = search_companies(company_name)
        if not matches:
            return {"error": f"No company found for '{company_name}'"}
        company_info = matches[0]
    else:
        return {"error": "Provide either company_name, ticker, or cik+ticker"}

    name = company_info["name"]
    tkr = company_info["ticker"]
    company_cik = company_info["cik"]

    print(f"\nCompany: {name} ({tkr}), CIK: {company_cik}")

    filing = fetch_latest_10k(company_cik)
    if not filing:
        return {"error": f"No 10-K filing found for {name} ({tkr})"}

    print(f"Found {filing['form']} filed {filing['date']}")

    html = download_10k(company_cik, filing["accession"], filing["primary_document"])
    sections = parse_10k(html, name, tkr, filing["date"])

    if not sections:
        return {"error": f"Could not parse 10-K for {name} ({tkr})"}

    save_dir = KNOWLEDGE_BASE_DIR / tkr.upper()
    save_dir.mkdir(parents=True, exist_ok=True)

    filing_year = filing["date"][:4]
    docs = []

    for section in sections:
        category = section["category"]
        safe_section = re.sub(r"[^\w\s-]", "", section["section"])[:60].strip()
        safe_section = re.sub(r"\s+", "_", safe_section)
        filename = f"10-K_{filing_year}_{safe_section}.md"
        filepath = save_dir / filename
        filepath.write_text(section["text"], encoding="utf-8")

        docs.append({
            "path": str(filepath),
            "text": section["text"],
            "category": category,
            "ticker": tkr.upper(),
        })

    print(f"\nSaved {len(docs)} section(s) to {save_dir}")
    print("Ingesting into ChromaDB ...")

    ingest_documents(docs)

    return {
        "ticker": tkr,
        "company": name,
        "cik": company_cik,
        "filing_date": filing["date"],
        "form": filing["form"],
        "sections": len(docs),
    }


def list_ingested_companies() -> list[dict]:
    """Scan the knowledge_base directory for ingested company tickers.

    Returns a list of dicts: {ticker, company, filing_date, sections}.
    """
    companies: list[dict] = []

    if not KNOWLEDGE_BASE_DIR.exists():
        return companies

    for ticker_dir in sorted(KNOWLEDGE_BASE_DIR.iterdir()):
        if not ticker_dir.is_dir() or ticker_dir.name.startswith("."):
            continue

        md_files = list(ticker_dir.glob("10-K_*.md"))
        if not md_files:
            continue

        company_name = ticker_dir.name
        filing_date = ""

        first_file = md_files[0]
        try:
            head = first_file.read_text(encoding="utf-8")[:500]
            for line in head.splitlines():
                if line.startswith("# ") and "(" in line:
                    company_name = line.split("(")[0].lstrip("# ").strip()
                if line.startswith("Filing date:"):
                    filing_date = line.replace("Filing date:", "").strip()
                    break
        except OSError:
            pass

        companies.append({
            "ticker": ticker_dir.name,
            "company": company_name,
            "filing_date": filing_date,
            "sections": len(md_files),
        })

    return companies


def main():
    parser = argparse.ArgumentParser(description="Ingest SEC 10-K filings into the RAG knowledge base.")
    parser.add_argument("--agent", type=str, default=None, help="Agent name (default: sec_edgar)")
    parser.add_argument("--company", type=str, default=None, help="Company name to search for")
    parser.add_argument("--ticker", type=str, default=None, help="Stock ticker symbol")
    parser.add_argument("--search", type=str, default=None, help="Search for companies (display only, no ingest)")
    args = parser.parse_args()

    if args.search:
        results = search_companies(args.search)
        if not results:
            print(f"No companies found for '{args.search}'")
            sys.exit(1)
        print(f"\nFound {len(results)} result(s):\n")
        for r in results:
            print(f"  {r['ticker']:>8}  {r['name']:<50}  CIK: {r['cik']}")
        sys.exit(0)

    if not args.company and not args.ticker:
        print("Error: provide --company or --ticker (or --search to browse).")
        sys.exit(1)

    result = ingest_company(company_name=args.company, ticker=args.ticker)
    if "error" in result:
        print(f"\nError: {result['error']}")
        sys.exit(1)

    print(f"\nSuccess: {result['company']} ({result['ticker']})")
    print(f"  Filing: {result['form']} dated {result['filing_date']}")
    print(f"  Sections ingested: {result['sections']}")


if __name__ == "__main__":
    main()
