"""Value agent web interface.

Browse the ChromaDB knowledge base and run RAG queries from your browser.

Usage:
    python web.py
    # or: uvicorn web:app --reload --port 5051
"""

import time
from collections import Counter

import anthropic
import chromadb
import uvicorn
from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from openai import OpenAI
from pydantic import BaseModel

from config import (
    ANTHROPIC_API_KEY,
    CHROMA_COLLECTION,
    CHROMA_PERSIST_DIR,
    OPENAI_API_KEY,
)
from query import (
    ask_claude,
    ask_openai,
    build_context,
    embed_query,
    retrieve,
)

app = FastAPI(title="Value")

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
    llm: str = "openai"


@app.post("/api/query")
def query(req: QueryRequest):
    start = time.time()

    collection = _get_collection()
    if collection.count() == 0:
        return {"error": "Knowledge base is empty. Run ingest.py first."}

    query_embedding = embed_query(openai_client, req.question)
    results = retrieve(collection, query_embedding, category=req.category or None)

    if not results["documents"][0]:
        return {"answer": "No relevant documents found.", "sources": [], "elapsed": 0}

    context = build_context(results)

    if req.llm == "openai":
        answer = ask_openai(openai_client, req.question, context)
    else:
        claude_client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
        answer = ask_claude(claude_client, req.question, context)

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
# Frontend
# ---------------------------------------------------------------------------

HTML_PAGE = """\
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Value</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #f5f6f8; color: #1a1a2e; line-height: 1.6;
  }
  header {
    background: #2e7d32; color: #fff; padding: 1.2rem 2rem;
    display: flex; align-items: center; gap: 1rem;
  }
  header h1 { font-size: 1.4rem; font-weight: 600; }
  header .stats { font-size: 0.85rem; opacity: 0.85; margin-left: auto; }
  .container { max-width: 1100px; margin: 2rem auto; padding: 0 1.5rem; display: flex; gap: 1.5rem; }
  .panel {
    background: #fff; border-radius: 10px; padding: 1.5rem;
    box-shadow: 0 1px 4px rgba(0,0,0,0.08);
  }
  .sidebar { flex: 0 0 320px; max-height: calc(100vh - 160px); display: flex; flex-direction: column; }
  .sidebar h2 { font-size: 1rem; margin-bottom: 0.8rem; color: #2e7d32; }
  .sidebar .cat-list { margin-bottom: 1rem; }
  .cat-badge {
    display: inline-block; background: #e8f5e9; color: #2e7d32; padding: 0.2rem 0.6rem;
    border-radius: 12px; font-size: 0.75rem; margin: 0.15rem;
  }
  .source-list { flex: 1; overflow-y: auto; border-top: 1px solid #eee; padding-top: 0.8rem; }
  .source-item {
    padding: 0.4rem 0; border-bottom: 1px solid #f0f0f0; font-size: 0.82rem;
    display: flex; justify-content: space-between; gap: 0.5rem;
  }
  .source-item .name { word-break: break-all; flex: 1; }
  .source-item .count { color: #888; white-space: nowrap; }
  .main { flex: 1; display: flex; flex-direction: column; gap: 1.5rem; }
  .query-box { display: flex; gap: 0.5rem; flex-wrap: wrap; }
  .query-box input[type="text"] {
    flex: 1; min-width: 200px; padding: 0.7rem 1rem; border: 1.5px solid #ddd;
    border-radius: 8px; font-size: 0.95rem; outline: none; transition: border-color 0.2s;
  }
  .query-box input[type="text"]:focus { border-color: #2e7d32; }
  .query-box select {
    padding: 0.7rem 0.8rem; border: 1.5px solid #ddd; border-radius: 8px;
    font-size: 0.85rem; background: #fff; cursor: pointer;
  }
  .query-box button {
    padding: 0.7rem 1.5rem; background: #2e7d32; color: #fff; border: none;
    border-radius: 8px; font-size: 0.95rem; cursor: pointer; transition: background 0.2s;
  }
  .query-box button:hover { background: #388e3c; }
  .query-box button:disabled { background: #a5d6a7; cursor: wait; }
  .answer-area { min-height: 120px; }
  .answer-area .answer-text {
    background: #fafafa; border-left: 3px solid #2e7d32; padding: 1rem 1.2rem;
    border-radius: 0 8px 8px 0; font-size: 0.92rem;
  }
  .answer-text h1, .answer-text h2, .answer-text h3 { margin: 0.8rem 0 0.4rem; }
  .answer-text h1 { font-size: 1.2rem; } .answer-text h2 { font-size: 1.05rem; } .answer-text h3 { font-size: 0.95rem; }
  .answer-text p { margin: 0.4rem 0; }
  .answer-text ul, .answer-text ol { margin: 0.4rem 0 0.4rem 1.4rem; }
  .answer-text li { margin: 0.2rem 0; }
  .answer-text code {
    background: #eee; padding: 0.15rem 0.4rem; border-radius: 4px; font-size: 0.85em;
  }
  .answer-text pre { background: #1a1a2e; color: #e0e0e0; padding: 0.8rem 1rem;
    border-radius: 6px; overflow-x: auto; margin: 0.5rem 0; font-size: 0.83rem;
  }
  .answer-text pre code { background: none; padding: 0; color: inherit; }
  .answer-text strong { font-weight: 600; }
  .answer-text blockquote {
    border-left: 3px solid #ddd; padding-left: 0.8rem; color: #555; margin: 0.5rem 0;
  }
  .answer-text table { border-collapse: collapse; margin: 0.5rem 0; font-size: 0.85rem; }
  .answer-text th, .answer-text td { border: 1px solid #ddd; padding: 0.35rem 0.6rem; }
  .answer-text th { background: #e8f5e9; }
  .answer-area .meta { margin-top: 0.8rem; font-size: 0.8rem; color: #666; }
  .answer-area .sources-list { margin-top: 0.4rem; font-size: 0.8rem; color: #444; }
  .answer-area .sources-list li { margin-left: 1.2rem; margin-top: 0.15rem; }
  .spinner { display: inline-block; width: 18px; height: 18px; border: 2px solid #ddd;
    border-top-color: #2e7d32; border-radius: 50%; animation: spin 0.6s linear infinite;
    vertical-align: middle; margin-right: 0.4rem;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .empty { color: #999; font-style: italic; font-size: 0.9rem; }
</style>
</head>
<body>

<header>
  <h1>Value</h1>
  <div class="stats" id="headerStats">Loading...</div>
</header>

<div class="container">
  <div class="panel sidebar">
    <h2>Categories</h2>
    <div class="cat-list" id="catList"></div>
    <h2>Indexed Sources</h2>
    <div class="source-list" id="sourceList"><span class="empty">Loading...</span></div>
  </div>

  <div class="main">
    <div class="panel">
      <form class="query-box" id="queryForm">
        <input type="text" id="questionInput" placeholder="Ask a value question..." autocomplete="off" required>
        <select id="llmSelect">
          <option value="openai">OpenAI</option>
          <option value="claude">Claude</option>
        </select>
        <select id="catFilter">
          <option value="">All categories</option>
        </select>
        <button type="submit" id="askBtn">Ask</button>
      </form>
    </div>

    <div class="panel answer-area" id="answerArea">
      <p class="empty">Ask a question to get started.</p>
    </div>
  </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<script>
async function loadStats() {
  const res = await fetch("/api/stats");
  const data = await res.json();
  document.getElementById("headerStats").textContent =
    `${data.total_chunks} chunks · ${data.unique_sources} sources`;

  const catList = document.getElementById("catList");
  const catFilter = document.getElementById("catFilter");
  catList.innerHTML = "";
  if (data.categories) {
    for (const [cat, count] of Object.entries(data.categories)) {
      catList.innerHTML += `<span class="cat-badge">${cat} (${count})</span>`;
      const opt = document.createElement("option");
      opt.value = cat;
      opt.textContent = cat;
      catFilter.appendChild(opt);
    }
  }
}

async function loadSources() {
  const res = await fetch("/api/sources");
  const data = await res.json();
  const el = document.getElementById("sourceList");
  if (!data.sources || data.sources.length === 0) {
    el.innerHTML = '<span class="empty">No sources indexed yet.</span>';
    return;
  }
  el.innerHTML = data.sources.map(s => {
    const name = s.source.split("/").slice(-2).join("/");
    return `<div class="source-item"><span class="name" title="${s.source}">${name}</span><span class="count">${s.chunks} chunks</span></div>`;
  }).join("");
}

document.getElementById("queryForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const question = document.getElementById("questionInput").value.trim();
  if (!question) return;

  const btn = document.getElementById("askBtn");
  const area = document.getElementById("answerArea");
  btn.disabled = true;
  btn.textContent = "Thinking...";
  area.innerHTML = '<p><span class="spinner"></span> Searching knowledge base...</p>';

  try {
    const body = {
      question,
      llm: document.getElementById("llmSelect").value,
      category: document.getElementById("catFilter").value || null,
    };
    const res = await fetch("/api/query", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(body),
    });
    const data = await res.json();

    if (data.error) {
      area.innerHTML = `<p class="empty">${data.error}</p>`;
      return;
    }

    let html = `<div class="answer-text">${marked.parse(data.answer)}</div>`;
    html += `<div class="meta">${data.elapsed}s · ${data.llm}</div>`;
    if (data.sources && data.sources.length) {
      html += '<ul class="sources-list">' +
        data.sources.map(s => `<li>${s.split("/").slice(-2).join("/")}</li>`).join("") +
        "</ul>";
    }
    area.innerHTML = html;
  } catch (err) {
    area.innerHTML = `<p class="empty">Error: ${err.message}</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Ask";
  }
});

loadStats();
loadSources();
</script>
</body>
</html>
"""


@app.get("/", response_class=HTMLResponse)
def index():
    return HTML_PAGE


if __name__ == "__main__":
    uvicorn.run("web:app", host="0.0.0.0", port=5051, reload=True)
