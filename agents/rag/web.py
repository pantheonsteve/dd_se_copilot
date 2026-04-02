"""RAG agent web interface.

Browse the ChromaDB knowledge base and run RAG queries from your browser.

Usage:
    python web.py --agent librarian    # http://localhost:5050
    python web.py --agent value        # http://localhost:5051
    python web.py --agent sec_edgar    # http://localhost:5053
"""

import argparse
import logging
import time
from collections import Counter

logger = logging.getLogger(__name__)

import anthropic
import chromadb
import uvicorn
from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from openai import OpenAI
from pydantic import BaseModel

from config import (
    AGENT_NAME,
    ANTHROPIC_API_KEY,
    CHROMA_COLLECTION,
    CHROMA_PERSIST_DIR,
    OPENAI_API_KEY,
    agent,
)
from query import (
    ask_claude,
    ask_openai,
    build_context,
    embed_query,
    multi_retrieve,
    retrieve,
    rewrite_query,
)
from chat import chat_turn
from conversation_store import (
    delete_conversation as _delete_conversation,
    get_conversation as _get_conversation,
    list_conversations as _list_conversations,
    update_title as _update_title,
)
from report_store import (
    delete_report as _delete_report,
    get_report as _get_report,
    list_reports as _list_reports,
    save_report as _save_report,
)

_EDGAR_ENABLED = agent.get("enable_company_search", False)
if _EDGAR_ENABLED:
    from edgar_ingest import search_companies, ingest_company, list_ingested_companies

app = FastAPI(title=agent["name"])

openai_client = OpenAI(api_key=OPENAI_API_KEY)
chroma_client = chromadb.PersistentClient(path=CHROMA_PERSIST_DIR)


def _get_collection():
    return chroma_client.get_or_create_collection(
        name=CHROMA_COLLECTION,
        metadata={"hnsw:space": "cosine"},
    )


_BATCH = 500


def _get_all_metadatas(collection, total: int) -> list[dict]:
    """Fetch all metadatas in batches to avoid SQLite variable limits."""
    all_meta: list[dict] = []
    for offset in range(0, total, _BATCH):
        batch = collection.get(
            include=["metadatas"],
            limit=_BATCH,
            offset=offset,
        )["metadatas"]
        all_meta.extend(batch)
    return all_meta


# ---------------------------------------------------------------------------
# API routes
# ---------------------------------------------------------------------------

@app.get("/api/stats")
def stats():
    collection = _get_collection()
    total = collection.count()
    if total == 0:
        return {"total_chunks": 0, "unique_sources": 0, "categories": {}}

    all_meta = _get_all_metadatas(collection, total)
    sources = {m.get("source", "unknown") for m in all_meta}
    categories = Counter(m.get("category", "general") for m in all_meta)

    return {
        "total_chunks": total,
        "unique_sources": len(sources),
        "categories": dict(categories.most_common()),
    }


@app.get("/api/sources")
def sources():
    collection = _get_collection()
    total = collection.count()
    if total == 0:
        return {"sources": []}

    all_meta = _get_all_metadatas(collection, total)
    counts: Counter = Counter()
    category_map: dict[str, str] = {}
    for m in all_meta:
        src = m.get("source", "unknown")
        counts[src] += 1
        if src not in category_map:
            category_map[src] = m.get("category", "general")

    source_list = [
        {"source": src, "chunks": count, "category": category_map.get(src, "general")}
        for src, count in counts.most_common()
    ]
    return {"sources": source_list}


class QueryRequest(BaseModel):
    question: str
    category: str | None = None
    ticker: str | None = None
    llm: str = "openai"


@app.post("/api/query")
def query(req: QueryRequest):
    start = time.time()

    collection = _get_collection()
    if collection.count() == 0:
        if _EDGAR_ENABLED:
            return {"error": "No filings indexed yet. Use the Search & Add Company panel above to add a company's 10-K filing first."}
        return {"error": "Knowledge base is empty. Run ingest.py first."}

    ticker_filter = req.ticker.upper() if req.ticker else None

    try:
        all_queries = [req.question]
        rewrites = rewrite_query(openai_client, req.question)
        if rewrites:
            all_queries.extend(rewrites)
        all_embeddings = [embed_query(openai_client, q) for q in all_queries]
    except Exception as exc:
        logger.exception("Embedding failed")
        return {"error": f"Embedding request failed: {exc}"}

    results = multi_retrieve(collection, all_embeddings,
                             category=req.category or None,
                             ticker=ticker_filter)

    if not results["documents"][0]:
        return {"answer": "No relevant documents found.", "sources": [], "elapsed": 0}

    context = build_context(results)

    try:
        if req.llm == "openai":
            answer = ask_openai(openai_client, req.question, context)
        else:
            claude_client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
            answer = ask_claude(claude_client, req.question, context)
    except Exception as exc:
        logger.exception("LLM call failed")
        return {"error": f"LLM request failed ({req.llm}): {exc}"}

    elapsed = time.time() - start

    seen: set[str] = set()
    source_list = []
    for meta in results["metadatas"][0]:
        src = meta.get("source", "unknown")
        if src not in seen:
            seen.add(src)
            source_list.append(src)

    return {"answer": answer, "sources": source_list, "elapsed": round(elapsed, 1), "llm": req.llm}


# ---------------------------------------------------------------------------
# Report persistence endpoints
# ---------------------------------------------------------------------------

class SaveReportRequest(BaseModel):
    question: str
    answer: str
    sources: list[str] = []
    elapsed: float = 0.0
    llm: str = ""
    title: str | None = None


@app.post("/api/reports")
def create_report(req: SaveReportRequest):
    return _save_report(
        question=req.question,
        answer=req.answer,
        sources=req.sources,
        elapsed=req.elapsed,
        llm=req.llm,
        title=req.title,
    )


@app.get("/api/reports")
def get_reports():
    return _list_reports()


@app.get("/api/reports/{report_id}")
def get_report_by_id(report_id: str):
    report = _get_report(report_id)
    if report is None:
        return {"error": "Report not found"}
    return report


@app.delete("/api/reports/{report_id}")
def delete_report_by_id(report_id: str):
    return {"deleted": _delete_report(report_id)}


# ---------------------------------------------------------------------------
# SEC EDGAR endpoints (only active when enable_company_search is set)
# ---------------------------------------------------------------------------

if _EDGAR_ENABLED:

    @app.get("/api/edgar/search")
    def edgar_search(q: str = ""):
        if not q or len(q.strip()) < 2:
            return {"results": []}
        results = search_companies(q.strip())
        return {"results": results}

    class EdgarIngestRequest(BaseModel):
        ticker: str
        cik: str
        company_name: str | None = None

    @app.post("/api/edgar/ingest")
    def edgar_ingest(req: EdgarIngestRequest):
        result = ingest_company(
            company_name=req.company_name,
            ticker=req.ticker,
            cik=req.cik,
        )
        if "error" in result:
            return {"error": result["error"]}

        global chroma_client
        chroma_client = chromadb.PersistentClient(path=CHROMA_PERSIST_DIR)

        return {
            "success": True,
            "ticker": result["ticker"],
            "company": result["company"],
            "filing_date": result["filing_date"],
            "sections": result["sections"],
        }

    @app.get("/api/edgar/companies")
    def edgar_companies():
        return {"companies": list_ingested_companies()}


# ---------------------------------------------------------------------------
# Chat endpoints
# ---------------------------------------------------------------------------

_anthropic_client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)


class ChatRequest(BaseModel):
    message: str
    conversation_id: str | None = None
    llm: str = "claude"
    category: str | None = None
    ticker: str | None = None


@app.post("/api/chat")
def chat(req: ChatRequest):
    collection = _get_collection()
    if collection.count() == 0:
        if _EDGAR_ENABLED:
            return {"error": "No filings indexed yet. Use the Search & Add Company panel to add a company's 10-K filing first."}
        return {"error": "Knowledge base is empty. Run ingest.py first."}

    try:
        return chat_turn(
            user_message=req.message,
            collection=collection,
            openai_client=openai_client,
            anthropic_client=_anthropic_client,
            conversation_id=req.conversation_id,
            llm=req.llm,
            category=req.category,
            ticker=req.ticker,
        )
    except Exception as exc:
        logger.exception("Chat turn failed")
        return {"error": f"Chat failed: {exc}"}


@app.get("/api/conversations")
def get_conversations():
    return _list_conversations()


@app.get("/api/conversations/{conversation_id}")
def get_conversation_by_id(conversation_id: str):
    conv = _get_conversation(conversation_id)
    if conv is None:
        return {"error": "Conversation not found"}
    return conv


@app.delete("/api/conversations/{conversation_id}")
def delete_conversation_by_id(conversation_id: str):
    return {"deleted": _delete_conversation(conversation_id)}


class UpdateTitleRequest(BaseModel):
    title: str


@app.patch("/api/conversations/{conversation_id}")
def update_conversation(conversation_id: str, req: UpdateTitleRequest):
    ok = _update_title(conversation_id, req.title)
    if not ok:
        return {"error": "Conversation not found"}
    return {"ok": True}


# ---------------------------------------------------------------------------
# Frontend
# ---------------------------------------------------------------------------

def _build_html(cfg: dict) -> str:
    name = cfg["name"]
    color = cfg["accent_color"]
    color_light = cfg["accent_color_light"]
    color_hover = cfg["accent_color_hover"]
    color_disabled = cfg["accent_color_disabled"]
    placeholder = cfg.get("placeholder", "Ask a question...")
    enable_company_search = cfg.get("enable_company_search", False)

    edgar_css = ""
    edgar_sidebar_html = ""
    edgar_js = ""

    if enable_company_search:
        edgar_css = f"""
  .edgar-section {{ margin-bottom: 0.5rem; }}
  .edgar-section h3 {{ font-size: 0.85rem; color: {color}; margin-bottom: 0.4rem; }}
  .edgar-search-box {{ display: flex; gap: 0.4rem; margin-bottom: 0.4rem; }}
  .edgar-search-box input {{
    flex: 1; padding: 0.4rem 0.6rem; border: 1.5px solid #ddd;
    border-radius: 6px; font-size: 0.8rem; outline: none; transition: border-color 0.2s;
  }}
  .edgar-search-box input:focus {{ border-color: {color}; }}
  .edgar-search-box button {{
    padding: 0.4rem 0.8rem; background: {color}; color: #fff; border: none;
    border-radius: 6px; font-size: 0.78rem; cursor: pointer; transition: background 0.2s;
  }}
  .edgar-search-box button:hover {{ background: {color_hover}; }}
  .edgar-search-box button:disabled {{ background: {color_disabled}; cursor: wait; }}
  .edgar-results {{ max-height: 150px; overflow-y: auto; }}
  .edgar-result {{
    display: flex; align-items: center; justify-content: space-between;
    padding: 0.35rem 0.5rem; border-bottom: 1px solid #f0f0f0; font-size: 0.78rem; gap: 0.4rem;
  }}
  .edgar-result:hover {{ background: {color_light}; }}
  .edgar-result .er-info {{ flex: 1; }}
  .edgar-result .er-ticker {{ font-weight: 600; color: {color}; margin-right: 0.3rem; }}
  .edgar-result .er-name {{ color: #333; }}
  .edgar-result .er-cik {{ color: #999; font-size: 0.7rem; }}
  .edgar-result button {{
    padding: 0.2rem 0.6rem; background: {color}; color: #fff; border: none;
    border-radius: 5px; font-size: 0.72rem; cursor: pointer; white-space: nowrap;
  }}
  .edgar-result button:hover {{ background: {color_hover}; }}
  .edgar-result button:disabled {{ background: {color_disabled}; cursor: wait; }}
  .edgar-status {{ padding: 0.3rem 0; font-size: 0.78rem; color: #555; }}
  .ec-list {{ list-style: none; }}
  .ec-item {{ display: flex; align-items: center; gap: 0.4rem; padding: 0.3rem 0;
              border-bottom: 1px solid #f0f0f0; font-size: 0.78rem; }}
  .ec-item:last-child {{ border-bottom: none; }}
  .ec-ticker {{ font-weight: 600; color: {color}; min-width: 45px; }}
  .ec-name {{ flex: 1; color: #333; }}
  .ec-meta {{ color: #999; font-size: 0.7rem; white-space: nowrap; }}
"""

        edgar_sidebar_html = """
    <div class="sidebar-section edgar-section">
      <h3>Search &amp; Add Company 10-K</h3>
      <div class="edgar-search-box">
        <input type="text" id="edgarSearchInput" placeholder="Name or ticker" autocomplete="off">
        <button type="button" id="edgarSearchBtn" onclick="edgarSearch()">Search</button>
      </div>
      <div id="edgarResults" class="edgar-results"></div>
      <div id="edgarStatus" class="edgar-status"></div>
    </div>
    <div class="sidebar-section">
      <h3>Indexed Companies</h3>
      <ul class="ec-list" id="companiesList"><li class="ec-item"><span class="empty">Loading...</span></li></ul>
    </div>
"""

        edgar_js = """
async function edgarSearch() {
  const q = document.getElementById("edgarSearchInput").value.trim();
  if (!q) return;
  const btn = document.getElementById("edgarSearchBtn");
  const results = document.getElementById("edgarResults");
  const status = document.getElementById("edgarStatus");
  btn.disabled = true; btn.textContent = "...";
  results.innerHTML = ""; status.textContent = "";
  try {
    const res = await fetch(`/api/edgar/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    if (!data.results || data.results.length === 0) {
      results.innerHTML = '<div class="edgar-status">No companies found.</div>';
      return;
    }
    results.innerHTML = data.results.map(r => `
      <div class="edgar-result">
        <div class="er-info">
          <span class="er-ticker">${r.ticker}</span>
          <span class="er-name">${r.name}</span>
        </div>
        <button onclick="edgarIngest('${r.ticker}', '${r.cik}', this)">Add 10-K</button>
      </div>
    `).join("");
  } catch (err) {
    status.textContent = "Search failed: " + err.message;
  } finally { btn.disabled = false; btn.textContent = "Search"; }
}
document.getElementById("edgarSearchInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); edgarSearch(); }
});
async function edgarIngest(ticker, cik, btn) {
  const status = document.getElementById("edgarStatus");
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = "...";
  status.innerHTML = '<span class="spinner"></span> Downloading 10-K...';
  try {
    const res = await fetch("/api/edgar/ingest", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ticker, cik}),
    });
    const data = await res.json();
    if (data.error) { status.textContent = "Error: " + data.error; return; }
    status.textContent = `Added ${data.company} (${data.ticker})`;
    loadStats(); loadSources(); loadCompanies();
  } catch (err) { status.textContent = "Failed: " + err.message; }
  finally { btn.disabled = false; btn.textContent = orig; }
}
async function loadCompanies() {
  const el = document.getElementById("companiesList");
  try {
    const res = await fetch("/api/edgar/companies");
    const data = await res.json();
    if (!data.companies || data.companies.length === 0) {
      el.innerHTML = '<li class="ec-item"><span class="empty">No companies indexed yet.</span></li>';
      return;
    }
    el.innerHTML = data.companies.map(c =>
      '<li class="ec-item"><span class="ec-ticker">' + c.ticker +
      '</span><span class="ec-name">' + c.company +
      '</span><span class="ec-meta">' + (c.filing_date || '') + '</span></li>'
    ).join("");
  } catch { el.innerHTML = '<li class="ec-item"><span class="empty">Failed to load.</span></li>'; }
}
loadCompanies();
"""

    welcome_msg = ("Search for a company above and add its 10-K filing, then ask questions here."
                   if enable_company_search else f"Hello! I'm the {name} assistant. Ask me anything about the knowledge base.")

    return f"""\
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{name}</title>
<style>
  *, *::before, *::after {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #f5f6f8; color: #1a1a2e; height: 100vh; display: flex; flex-direction: column;
    overflow: hidden;
  }}

  /* --- Header --- */
  header {{
    background: {color}; color: #fff; padding: 0.8rem 1.5rem;
    display: flex; align-items: center; gap: 1rem; flex-shrink: 0;
  }}
  header h1 {{ font-size: 1.25rem; font-weight: 600; }}
  header .stats {{ font-size: 0.82rem; opacity: 0.85; margin-left: auto; }}
  header .new-chat-btn {{
    padding: 0.4rem 1rem; background: rgba(255,255,255,0.2); color: #fff;
    border: 1px solid rgba(255,255,255,0.4); border-radius: 6px; font-size: 0.82rem;
    cursor: pointer; transition: background 0.2s;
  }}
  header .new-chat-btn:hover {{ background: rgba(255,255,255,0.35); }}

  /* --- Layout --- */
  .app {{ display: flex; flex: 1; overflow: hidden; }}

  /* --- Sidebar --- */
  .sidebar {{
    width: 280px; background: #fff; border-right: 1px solid #e5e7eb;
    display: flex; flex-direction: column; flex-shrink: 0; overflow: hidden;
  }}
  .sidebar-section {{ padding: 0.8rem 1rem; border-bottom: 1px solid #eee; }}
  .sidebar-section h3 {{
    font-size: 0.8rem; font-weight: 600; color: #888; text-transform: uppercase;
    letter-spacing: 0.03em; margin-bottom: 0.5rem;
  }}
  .conv-list {{ list-style: none; max-height: 280px; overflow-y: auto; }}
  .conv-item {{
    display: flex; align-items: center; gap: 0.4rem; padding: 0.5rem 0.6rem;
    border-radius: 6px; font-size: 0.82rem; cursor: pointer; transition: background 0.15s;
  }}
  .conv-item:hover {{ background: {color_light}; }}
  .conv-item.active {{ background: {color_light}; font-weight: 600; }}
  .conv-item .conv-title {{ flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }}
  .conv-item .conv-delete {{
    background: none; border: none; color: #ccc; cursor: pointer;
    font-size: 0.75rem; padding: 0.1rem 0.3rem; border-radius: 3px; visibility: hidden;
  }}
  .conv-item:hover .conv-delete {{ visibility: visible; color: #dc2626; }}
  .conv-item .conv-delete:hover {{ background: #fee2e2; }}

  .cat-list {{ margin-bottom: 0.3rem; }}
  .cat-badge {{
    display: inline-block; background: {color_light}; color: {color}; padding: 0.15rem 0.5rem;
    border-radius: 10px; font-size: 0.7rem; margin: 0.1rem;
  }}
  .source-list {{ max-height: 200px; overflow-y: auto; }}
  .source-item {{
    padding: 0.3rem 0; border-bottom: 1px solid #f0f0f0; font-size: 0.75rem;
    display: flex; justify-content: space-between; gap: 0.3rem;
  }}
  .source-item .name {{ word-break: break-all; flex: 1; }}
  .source-item .count {{ color: #888; white-space: nowrap; }}

  /* --- Chat area --- */
  .chat-container {{
    flex: 1; display: flex; flex-direction: column; min-width: 0;
  }}
  .chat-messages {{
    flex: 1; overflow-y: auto; padding: 1.5rem; display: flex; flex-direction: column; gap: 1rem;
  }}

  .msg {{ display: flex; gap: 0.8rem; max-width: 85%; animation: fadeIn 0.2s ease; }}
  @keyframes fadeIn {{ from {{ opacity: 0; transform: translateY(6px); }} to {{ opacity: 1; transform: none; }} }}
  .msg.user {{ align-self: flex-end; flex-direction: row-reverse; }}
  .msg-avatar {{
    width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center;
    justify-content: center; font-size: 0.75rem; font-weight: 600; flex-shrink: 0;
  }}
  .msg.assistant .msg-avatar {{ background: {color_light}; color: {color}; }}
  .msg.user .msg-avatar {{ background: #e5e7eb; color: #555; }}
  .msg-body {{ min-width: 0; }}
  .msg-content {{
    padding: 0.8rem 1rem; border-radius: 12px; font-size: 0.9rem; line-height: 1.55;
  }}
  .msg.assistant .msg-content {{
    background: #fff; border: 1px solid #e5e7eb; border-radius: 2px 12px 12px 12px;
  }}
  .msg.user .msg-content {{
    background: {color}; color: #fff; border-radius: 12px 2px 12px 12px;
  }}

  /* Markdown inside assistant messages */
  .msg.assistant .msg-content h1, .msg.assistant .msg-content h2,
  .msg.assistant .msg-content h3 {{ margin: 0.6rem 0 0.3rem; }}
  .msg.assistant .msg-content h1 {{ font-size: 1.1rem; }}
  .msg.assistant .msg-content h2 {{ font-size: 1rem; }}
  .msg.assistant .msg-content h3 {{ font-size: 0.92rem; }}
  .msg.assistant .msg-content p {{ margin: 0.3rem 0; }}
  .msg.assistant .msg-content ul, .msg.assistant .msg-content ol {{
    margin: 0.3rem 0 0.3rem 1.3rem;
  }}
  .msg.assistant .msg-content li {{ margin: 0.15rem 0; }}
  .msg.assistant .msg-content code {{
    background: #f0f0f0; padding: 0.12rem 0.35rem; border-radius: 4px; font-size: 0.83em;
  }}
  .msg.assistant .msg-content pre {{
    background: #1a1a2e; color: #e0e0e0; padding: 0.7rem 0.9rem;
    border-radius: 6px; overflow-x: auto; margin: 0.4rem 0; font-size: 0.8rem;
  }}
  .msg.assistant .msg-content pre code {{ background: none; padding: 0; color: inherit; }}
  .msg.assistant .msg-content strong {{ font-weight: 600; }}
  .msg.assistant .msg-content blockquote {{
    border-left: 3px solid #ddd; padding-left: 0.7rem; color: #555; margin: 0.4rem 0;
  }}
  .msg.assistant .msg-content table {{ border-collapse: collapse; margin: 0.4rem 0; font-size: 0.82rem; }}
  .msg.assistant .msg-content th, .msg.assistant .msg-content td {{
    border: 1px solid #ddd; padding: 0.3rem 0.5rem;
  }}
  .msg.assistant .msg-content th {{ background: {color_light}; }}

  .msg-sources {{
    margin-top: 0.4rem; font-size: 0.75rem; color: #888;
  }}
  .msg-sources summary {{ cursor: pointer; color: {color}; font-weight: 500; }}
  .msg-sources ul {{ list-style: none; margin-top: 0.2rem; }}
  .msg-sources li {{ padding: 0.1rem 0; }}
  .msg-meta {{ font-size: 0.7rem; color: #aaa; margin-top: 0.2rem; }}

  .msg-thinking {{
    display: flex; align-items: center; gap: 0.5rem;
    padding: 0.8rem 1rem; color: #888; font-size: 0.85rem;
  }}

  /* --- Input area --- */
  .chat-input-area {{
    padding: 0.8rem 1.5rem 1rem; border-top: 1px solid #e5e7eb; background: #fff;
    flex-shrink: 0;
  }}
  .chat-input-row {{ display: flex; gap: 0.5rem; align-items: flex-end; }}
  .chat-input-row textarea {{
    flex: 1; padding: 0.7rem 1rem; border: 1.5px solid #ddd; border-radius: 10px;
    font-size: 0.92rem; font-family: inherit; outline: none; resize: none;
    min-height: 42px; max-height: 120px; transition: border-color 0.2s; line-height: 1.4;
  }}
  .chat-input-row textarea:focus {{ border-color: {color}; }}
  .chat-input-row button {{
    padding: 0.7rem 1.3rem; background: {color}; color: #fff; border: none;
    border-radius: 10px; font-size: 0.92rem; cursor: pointer; transition: background 0.2s;
    white-space: nowrap; align-self: flex-end;
  }}
  .chat-input-row button:hover {{ background: {color_hover}; }}
  .chat-input-row button:disabled {{ background: {color_disabled}; cursor: wait; }}
  .chat-controls {{
    display: flex; gap: 0.5rem; margin-top: 0.4rem; align-items: center;
  }}
  .chat-controls select {{
    padding: 0.3rem 0.5rem; border: 1px solid #ddd; border-radius: 5px;
    font-size: 0.78rem; background: #fff; cursor: pointer;
  }}
  .chat-controls .hint {{ font-size: 0.72rem; color: #aaa; margin-left: auto; }}

  .spinner {{
    display: inline-block; width: 16px; height: 16px; border: 2px solid #ddd;
    border-top-color: {color}; border-radius: 50%; animation: spin 0.6s linear infinite;
    vertical-align: middle;
  }}
  @keyframes spin {{ to {{ transform: rotate(360deg); }} }}
  .empty {{ color: #999; font-style: italic; font-size: 0.85rem; }}
{edgar_css}
</style>
</head>
<body>

<header>
  <h1>{name}</h1>
  <button class="new-chat-btn" onclick="newConversation()">+ New Chat</button>
  <div class="stats" id="headerStats">Loading...</div>
</header>

<div class="app">
  <div class="sidebar">
    <div class="sidebar-section">
      <h3>Conversations</h3>
      <ul class="conv-list" id="convList">
        <li><span class="empty">No conversations yet.</span></li>
      </ul>
    </div>
{edgar_sidebar_html}
    <div class="sidebar-section">
      <h3>Categories</h3>
      <div class="cat-list" id="catList"></div>
    </div>
    <div class="sidebar-section" style="flex:1;overflow:hidden;display:flex;flex-direction:column;">
      <h3>Indexed Sources</h3>
      <div class="source-list" id="sourceList"><span class="empty">Loading...</span></div>
    </div>
  </div>

  <div class="chat-container">
    <div class="chat-messages" id="chatMessages">
      <div class="msg assistant">
        <div class="msg-avatar">AI</div>
        <div class="msg-body">
          <div class="msg-content">{welcome_msg}</div>
        </div>
      </div>
    </div>

    <div class="chat-input-area">
      <form class="chat-input-row" id="chatForm">
        <textarea id="chatInput" placeholder="{placeholder}" rows="1" autocomplete="off" required></textarea>
        <button type="submit" id="sendBtn">Send</button>
      </form>
      <div class="chat-controls">
        <select id="llmSelect">
          <option value="claude">Claude</option>
          <option value="openai">OpenAI</option>
        </select>
        <select id="catFilter">
          <option value="">All categories</option>
        </select>
        <span class="hint">Shift+Enter for new line</span>
      </div>
    </div>
  </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<script>
let _convId = null;
let _sending = false;

/* --- Auto-resize textarea --- */
const chatInput = document.getElementById("chatInput");
chatInput.addEventListener("input", () => {{
  chatInput.style.height = "auto";
  chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + "px";
}});
chatInput.addEventListener("keydown", (e) => {{
  if (e.key === "Enter" && !e.shiftKey) {{
    e.preventDefault();
    document.getElementById("chatForm").requestSubmit();
  }}
}});

/* --- Stats & Sources --- */
async function loadStats() {{
  try {{
    const res = await fetch("/api/stats");
    const data = await res.json();
    document.getElementById("headerStats").textContent =
      `${{data.total_chunks}} chunks · ${{data.unique_sources}} sources`;
    const catList = document.getElementById("catList");
    const catFilter = document.getElementById("catFilter");
    catList.innerHTML = "";
    if (data.categories) {{
      for (const [cat, count] of Object.entries(data.categories)) {{
        catList.innerHTML += `<span class="cat-badge">${{cat}} (${{count}})</span>`;
        const opt = document.createElement("option");
        opt.value = cat; opt.textContent = cat;
        catFilter.appendChild(opt);
      }}
    }}
  }} catch {{}}
}}
async function loadSources() {{
  try {{
    const res = await fetch("/api/sources");
    const data = await res.json();
    const el = document.getElementById("sourceList");
    if (!data.sources || !data.sources.length) {{
      el.innerHTML = '<span class="empty">No sources indexed yet.</span>'; return;
    }}
    el.innerHTML = data.sources.map(s => {{
      const n = s.source.split("/").slice(-2).join("/");
      return `<div class="source-item"><span class="name" title="${{s.source}}">${{n}}</span><span class="count">${{s.chunks}}</span></div>`;
    }}).join("");
  }} catch {{}}
}}

/* --- Conversations --- */
async function loadConversations() {{
  const el = document.getElementById("convList");
  try {{
    const res = await fetch("/api/conversations");
    const data = await res.json();
    if (!data.length) {{
      el.innerHTML = '<li><span class="empty">No conversations yet.</span></li>'; return;
    }}
    el.innerHTML = data.map(c => {{
      const label = c.title || (c.preview ? c.preview.slice(0, 45) : "Untitled");
      const cls = c.id === _convId ? "conv-item active" : "conv-item";
      return '<li class="' + cls + '" onclick="loadConversation(\\'' + c.id + '\\')">' +
        '<span class="conv-title" title="' + label.replace(/"/g, '&quot;') + '">' + label + '</span>' +
        '<span class="conv-count" style="font-size:0.7rem;color:#aaa;">' + c.message_count + '</span>' +
        '<button class="conv-delete" onclick="event.stopPropagation();deleteConversation(\\'' + c.id + '\\')">&times;</button>' +
        '</li>';
    }}).join("");
  }} catch {{
    el.innerHTML = '<li><span class="empty">Failed to load.</span></li>';
  }}
}}

async function loadConversation(id) {{
  try {{
    const res = await fetch("/api/conversations/" + id);
    const data = await res.json();
    if (data.error) return;
    _convId = id;
    const el = document.getElementById("chatMessages");
    el.innerHTML = "";
    for (const m of data.messages) {{
      appendMessage(m.role, m.content, m.sources || [], m.elapsed);
    }}
    scrollToBottom();
    loadConversations();
  }} catch {{}}
}}

async function deleteConversation(id) {{
  try {{
    await fetch("/api/conversations/" + id, {{ method: "DELETE" }});
    if (_convId === id) newConversation();
    loadConversations();
  }} catch {{}}
}}

function newConversation() {{
  _convId = null;
  const el = document.getElementById("chatMessages");
  el.innerHTML = `
    <div class="msg assistant">
      <div class="msg-avatar">AI</div>
      <div class="msg-body">
        <div class="msg-content">{welcome_msg}</div>
      </div>
    </div>`;
  loadConversations();
  chatInput.focus();
}}

/* --- Render messages --- */
function appendMessage(role, content, sources, elapsed) {{
  const el = document.getElementById("chatMessages");
  const div = document.createElement("div");
  div.className = "msg " + role;

  const avatarLabel = role === "user" ? "You" : "AI";
  let bodyHtml = "";

  if (role === "assistant") {{
    bodyHtml = `<div class="msg-content">${{marked.parse(content)}}</div>`;
    if (sources && sources.length) {{
      bodyHtml += '<div class="msg-sources"><details><summary>' + sources.length +
        ' source' + (sources.length > 1 ? 's' : '') + '</summary><ul>' +
        sources.map(s => '<li>' + s.split("/").slice(-2).join("/") + '</li>').join("") +
        '</ul></details></div>';
    }}
    if (elapsed) bodyHtml += `<div class="msg-meta">${{elapsed}}s</div>`;
  }} else {{
    const escaped = content.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    bodyHtml = `<div class="msg-content">${{escaped}}</div>`;
  }}

  div.innerHTML = `<div class="msg-avatar">${{avatarLabel}}</div><div class="msg-body">${{bodyHtml}}</div>`;
  el.appendChild(div);
}}

function appendThinking() {{
  const el = document.getElementById("chatMessages");
  const div = document.createElement("div");
  div.className = "msg assistant";
  div.id = "thinkingMsg";
  div.innerHTML = `<div class="msg-avatar">AI</div>
    <div class="msg-body"><div class="msg-thinking"><span class="spinner"></span> Thinking...</div></div>`;
  el.appendChild(div);
  scrollToBottom();
}}

function removeThinking() {{
  const el = document.getElementById("thinkingMsg");
  if (el) el.remove();
}}

function scrollToBottom() {{
  const el = document.getElementById("chatMessages");
  el.scrollTop = el.scrollHeight;
}}

/* --- Send message --- */
document.getElementById("chatForm").addEventListener("submit", async (e) => {{
  e.preventDefault();
  const message = chatInput.value.trim();
  if (!message || _sending) return;
  _sending = true;

  const btn = document.getElementById("sendBtn");
  btn.disabled = true;

  appendMessage("user", message, [], null);
  chatInput.value = ""; chatInput.style.height = "auto";
  scrollToBottom();
  appendThinking();

  try {{
    const body = {{
      message,
      conversation_id: _convId,
      llm: document.getElementById("llmSelect").value,
      category: document.getElementById("catFilter").value || null,
    }};
    const res = await fetch("/api/chat", {{
      method: "POST",
      headers: {{"Content-Type": "application/json"}},
      body: JSON.stringify(body),
    }});
    const data = await res.json();
    removeThinking();

    if (data.error) {{
      appendMessage("assistant", "Error: " + data.error, [], null);
    }} else {{
      _convId = data.conversation_id;
      appendMessage("assistant", data.response, data.sources || [], data.elapsed);
      loadConversations();
    }}
  }} catch (err) {{
    removeThinking();
    appendMessage("assistant", "Error: " + err.message, [], null);
  }} finally {{
    _sending = false;
    btn.disabled = false;
    scrollToBottom();
    chatInput.focus();
  }}
}});

{edgar_js}
loadStats();
loadSources();
loadConversations();
</script>
</body>
</html>
"""


HTML_PAGE = _build_html(agent)


@app.get("/", response_class=HTMLResponse)
def index():
    return HTML_PAGE


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run the RAG agent web UI.")
    parser.add_argument("--agent", type=str, default=None, help="Agent name (default: from RAG_AGENT env or 'librarian')")
    parser.parse_args()

    port = agent.get("port", 5050)
    uvicorn.run("web:app", host="0.0.0.0", port=port, reload=True)
