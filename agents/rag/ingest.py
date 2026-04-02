"""Document ingestion pipeline for RAG agents.

Walks an agent's knowledge_base/ directory, chunks text files, embeds them via
OpenAI, and upserts into ChromaDB. Can also fetch and ingest web pages by URL,
crawl an entire URL prefix, or discover pages from a sitemap.

Usage:
    python ingest.py --agent librarian                              # ingest local files
    python ingest.py --agent librarian --path knowledge_base/docs   # ingest a subset
    python ingest.py --agent value --url "https://datadoghq.com/blog/foo/"
    python ingest.py --agent value --crawl "https://datadoghq.com/blog/" --max-pages 200
    python ingest.py --agent value --sitemap "https://www.datadoghq.com/en/sitemap.xml" \
        --crawl "https://www.datadoghq.com/blog/" --max-pages 200  # sitemap discovery
"""

import argparse
import hashlib
import re
import sys
import time
import xml.etree.ElementTree as ET
from collections import deque
from pathlib import Path
from urllib.parse import urljoin, urlparse

import chromadb
import httpx
from bs4 import BeautifulSoup
from markdownify import markdownify as md
from openai import OpenAI

from config import (
    CHROMA_COLLECTION,
    CHROMA_PERSIST_DIR,
    CHUNK_OVERLAP,
    CHUNK_SIZE,
    EMBEDDING_DIMENSIONS,
    EMBEDDING_MODEL,
    KNOWLEDGE_BASE_DIR,
    OPENAI_API_KEY,
    SUPPORTED_EXTENSIONS,
    agent,
)


MAX_CHUNK_TOKENS = 7000
MAX_EMBEDDING_TOKENS = 7500
MAX_EMBEDDING_CHARS = 20000


def _estimate_tokens(text: str) -> int:
    return int(len(text.split()) / 0.75)


def _split_long_paragraph(text: str, max_tokens: int) -> list[str]:
    """Split a paragraph that exceeds max_tokens into smaller pieces by sentence."""
    sentences = re.split(r"(?<=[.!?])\s+", text)
    pieces: list[str] = []
    current: list[str] = []
    current_len = 0

    for sentence in sentences:
        sent_tokens = _estimate_tokens(sentence)
        if current_len + sent_tokens > max_tokens and current:
            pieces.append(" ".join(current))
            current = []
            current_len = 0
        current.append(sentence)
        current_len += sent_tokens

    if current:
        pieces.append(" ".join(current))
    return pieces


def chunk_text(text: str, chunk_size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> list[str]:
    """Split text into overlapping chunks by approximate token count.

    Uses a simple word-based splitter: ~1 token per 0.75 words (conservative).
    Splits on paragraph boundaries when possible, falling back to sentences
    for long paragraphs.
    """
    raw_paragraphs = text.split("\n\n")
    paragraphs: list[str] = []
    for para in raw_paragraphs:
        para = para.strip()
        if not para:
            continue
        if _estimate_tokens(para) > chunk_size:
            paragraphs.extend(_split_long_paragraph(para, chunk_size))
        else:
            paragraphs.append(para)

    chunks: list[str] = []
    current_chunk: list[str] = []
    current_length = 0

    for para in paragraphs:
        para_tokens = _estimate_tokens(para)

        if current_length + para_tokens > chunk_size and current_chunk:
            chunks.append("\n\n".join(current_chunk))
            overlap_text = _get_overlap(current_chunk, overlap)
            current_chunk = [overlap_text] if overlap_text else []
            current_length = _estimate_tokens(overlap_text) if overlap_text else 0

        current_chunk.append(para)
        current_length += para_tokens

    if current_chunk:
        chunks.append("\n\n".join(current_chunk))

    return chunks if chunks else [text]


def _get_overlap(paragraphs: list[str], target_tokens: int) -> str:
    """Return the tail of paragraphs up to target_tokens."""
    words: list[str] = []
    for para in reversed(paragraphs):
        para_words = para.split()
        if len(words) + len(para_words) > int(target_tokens * 0.75):
            break
        words = para_words + words
    return " ".join(words)


def make_chunk_id(filepath: str, chunk_index: int) -> str:
    """Deterministic ID so re-ingestion upserts instead of duplicating."""
    raw = f"{filepath}::chunk_{chunk_index}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def categorize(filepath: Path) -> str:
    """Derive a category from the first subdirectory under knowledge_base/."""
    try:
        relative = filepath.relative_to(KNOWLEDGE_BASE_DIR)
        return relative.parts[0] if len(relative.parts) > 1 else "general"
    except ValueError:
        return "general"


def load_documents(base_path: Path) -> list[dict]:
    """Recursively load all supported files under base_path."""
    docs = []
    for ext in SUPPORTED_EXTENSIONS:
        for filepath in sorted(base_path.rglob(f"*{ext}")):
            if filepath.name.startswith("."):
                continue
            text = filepath.read_text(encoding="utf-8", errors="replace")
            if text.strip():
                docs.append({
                    "path": str(filepath),
                    "text": text,
                    "category": categorize(filepath),
                })
    return docs


def _slugify(text: str) -> str:
    """Convert text to a filesystem-safe slug."""
    text = text.lower().strip()
    text = re.sub(r"[^\w\s-]", "", text)
    text = re.sub(r"[\s_]+", "-", text)
    text = re.sub(r"-+", "-", text).strip("-")
    return text[:80] or "page"


def _clean_markdown(text: str) -> str:
    """Remove navigation noise and excessive whitespace from converted markdown."""
    lines = text.split("\n")
    cleaned: list[str] = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("* [") and stripped.endswith(")"):
            continue
        if stripped.startswith("+ [") and stripped.endswith(")"):
            continue
        if stripped.startswith("- [") and stripped.endswith(")"):
            continue
        cleaned.append(line)
    text = "\n".join(cleaned)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


_HTTP_CLIENT = None


def _get_http_client() -> httpx.Client:
    global _HTTP_CLIENT
    if _HTTP_CLIENT is None:
        _HTTP_CLIENT = httpx.Client(
            follow_redirects=True,
            timeout=30,
            headers={
                "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
            },
        )
    return _HTTP_CLIENT


def _fetch_and_parse(url: str) -> tuple[BeautifulSoup | None, str]:
    """Fetch a URL and return (soup, final_url). Returns (None, url) on failure."""
    try:
        response = _get_http_client().get(url)
        response.raise_for_status()
        return BeautifulSoup(response.text, "html.parser"), str(response.url)
    except (httpx.HTTPError, httpx.InvalidURL) as e:
        print(f"  Skipping {url}: {e}")
        return None, url


def _extract_links(soup: BeautifulSoup, base_url: str, prefix: str) -> list[str]:
    """Extract all links from a page that fall under the given URL prefix."""
    links = set()
    for a_tag in soup.find_all("a", href=True):
        href = a_tag["href"]
        absolute = urljoin(base_url, href)
        parsed = urlparse(absolute)
        clean = f"{parsed.scheme}://{parsed.hostname}{parsed.path}"
        if clean.startswith(prefix) and clean != prefix:
            if not parsed.path.endswith((".png", ".jpg", ".svg", ".gif", ".css", ".js", ".json", ".xml")):
                links.add(clean.rstrip("/") + "/")
    return sorted(links)


def fetch_url(url: str) -> dict | None:
    """Fetch a web page, convert to markdown, and save to knowledge_base/ mirroring the URL path."""
    print(f"Fetching {url} ...")
    soup, final_url = _fetch_and_parse(url)
    if soup is None:
        return None

    title_tag = soup.find("title")
    title = title_tag.get_text(strip=True) if title_tag else ""
    if not title:
        title = urlparse(final_url).path.strip("/").split("/")[-1] or "page"

    for tag in soup.find_all(["script", "style", "nav", "header", "footer",
                               "noscript", "iframe", "aside", "svg"]):
        tag.decompose()

    candidates = [
        soup.find("article"),
        soup.find("main"),
        soup.find("div", role="main"),
    ]
    candidates = [c for c in candidates if c and len(c.get_text(strip=True)) > 200]
    if candidates:
        content = max(candidates, key=lambda c: len(c.get_text(strip=True)))
    else:
        content = soup.find("body") or soup

    markdown_text = md(str(content), heading_style="ATX", strip=["img"])
    markdown_text = _clean_markdown(markdown_text)

    if not markdown_text:
        print(f"  Skipping {url}: no content extracted.")
        return None

    parsed = urlparse(final_url)
    url_path = parsed.path.strip("/")
    if not url_path:
        url_path = "index"
    save_dir = KNOWLEDGE_BASE_DIR / parsed.hostname / str(Path(url_path).parent)
    save_dir.mkdir(parents=True, exist_ok=True)
    filename = Path(url_path).name or "index"
    save_path = save_dir / f"{filename}.md"

    page_header = f"# {title}\n\nSource: {final_url}\n\n"
    save_path.write_text(page_header + markdown_text, encoding="utf-8")
    print(f"  Saved to {save_path}")

    return {
        "path": str(save_path),
        "text": page_header + markdown_text,
        "category": parsed.hostname,
    }


def _resolve_prefix(base_url: str) -> str:
    """Follow redirects on the base URL and return the canonical prefix.

    Sites like datadoghq.com redirect to www.datadoghq.com, so the prefix
    must be built from the final URL to match discovered links.
    """
    try:
        resp = _get_http_client().head(base_url)
        final = str(resp.url).rstrip("/") + "/"
    except httpx.HTTPError:
        final = base_url
    parsed = urlparse(final)
    return f"{parsed.scheme}://{parsed.hostname}{parsed.path}"


def crawl_urls(base_url: str, max_pages: int = 0, delay: float = 0.5) -> list[dict]:
    """BFS crawl starting from base_url, staying within the URL prefix.

    Args:
        max_pages: Stop after this many pages. 0 means no limit (crawl everything).
        delay: Seconds to wait between requests.

    Returns a list of document dicts ready for ingestion.
    """
    base_url = base_url.rstrip("/") + "/"
    prefix = _resolve_prefix(base_url)

    visited: set[str] = set()
    queue: deque[str] = deque([prefix])
    docs: list[dict] = []

    limit_str = str(max_pages) if max_pages else "unlimited"
    print(f"Crawling {prefix}* (limit: {limit_str}) ...\n")

    while queue:
        if max_pages and len(visited) >= max_pages:
            break

        url = queue.popleft()
        normalized = url.rstrip("/") + "/"
        if normalized in visited:
            continue
        visited.add(normalized)

        soup, final_url = _fetch_and_parse(url)
        if soup is None:
            continue

        child_links = _extract_links(soup, final_url, prefix)
        for link in child_links:
            if link.rstrip("/") + "/" not in visited:
                queue.append(link)

        doc = fetch_url(url)
        if doc:
            docs.append(doc)

        print(f"  [{len(visited)} visited, {len(queue)} queued, {len(docs)} saved]\n")

        if queue:
            time.sleep(delay)

    return docs


def _discover_sitemap_urls(sitemap_url: str, prefix: str) -> list[str]:
    """Recursively parse a sitemap (index or urlset) and return URLs under prefix."""
    ns = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}
    try:
        resp = _get_http_client().get(sitemap_url)
        resp.raise_for_status()
    except httpx.HTTPError as e:
        print(f"  Failed to fetch sitemap {sitemap_url}: {e}")
        return []

    root = ET.fromstring(resp.text)
    urls: list[str] = []

    sub_sitemaps = root.findall("sm:sitemap/sm:loc", ns)
    if sub_sitemaps:
        for loc in sub_sitemaps:
            urls.extend(_discover_sitemap_urls(loc.text.strip(), prefix))
        return urls

    for loc in root.findall("sm:url/sm:loc", ns):
        url = loc.text.strip()
        if url.startswith(prefix) and url.rstrip("/") + "/" != prefix.rstrip("/") + "/":
            urls.append(url)

    return urls


def _discover_sitemap_entries(sitemap_url: str, prefix: str) -> dict[str, str | None]:
    """Recursively parse a sitemap and return {url: lastmod} for URLs under prefix.

    lastmod is the raw string from the sitemap's <lastmod> element, or None if absent.
    """
    ns = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}
    try:
        resp = _get_http_client().get(sitemap_url)
        resp.raise_for_status()
    except httpx.HTTPError as e:
        print(f"  Failed to fetch sitemap {sitemap_url}: {e}")
        return {}

    root = ET.fromstring(resp.text)
    entries: dict[str, str | None] = {}

    sub_sitemaps = root.findall("sm:sitemap/sm:loc", ns)
    if sub_sitemaps:
        for loc in sub_sitemaps:
            entries.update(_discover_sitemap_entries(loc.text.strip(), prefix))
        return entries

    for url_elem in root.findall("sm:url", ns):
        loc = url_elem.find("sm:loc", ns)
        if loc is None or not loc.text:
            continue
        url = loc.text.strip()
        if url.startswith(prefix) and url.rstrip("/") + "/" != prefix.rstrip("/") + "/":
            lastmod_elem = url_elem.find("sm:lastmod", ns)
            entries[url] = lastmod_elem.text.strip() if lastmod_elem is not None and lastmod_elem.text else None

    return entries


def crawl_sitemap(sitemap_url: str, url_prefix: str, max_pages: int = 0, delay: float = 0.5) -> list[dict]:
    """Discover blog URLs from a sitemap and fetch each one.

    Args:
        sitemap_url: URL to the sitemap XML (or sitemap index).
        url_prefix: Only URLs starting with this prefix are included
                     (e.g. "https://www.datadoghq.com/blog/").
        max_pages: Stop after this many pages. 0 means no limit.
        delay: Seconds to wait between requests.
    """
    prefix = url_prefix.rstrip("/") + "/"
    print(f"Discovering URLs from sitemap: {sitemap_url}")
    print(f"Filtering to prefix: {prefix}\n")

    all_urls = _discover_sitemap_urls(sitemap_url, prefix)
    print(f"Found {len(all_urls)} URLs under {prefix}\n")

    if max_pages:
        all_urls = all_urls[:max_pages]
        print(f"Limiting to first {max_pages} pages.\n")

    docs: list[dict] = []
    for i, url in enumerate(all_urls, 1):
        doc = fetch_url(url)
        if doc:
            docs.append(doc)
        print(f"  [{i}/{len(all_urls)} fetched, {len(docs)} saved]\n")
        if i < len(all_urls):
            time.sleep(delay)

    return docs


_tiktoken_enc = None


def _tiktoken_encode(text: str) -> list[int]:
    global _tiktoken_enc
    if _tiktoken_enc is None:
        import tiktoken
        _tiktoken_enc = tiktoken.encoding_for_model("text-embedding-3-small")
    return _tiktoken_enc.encode(text)


def _truncate_for_embedding(text: str, max_tokens: int = MAX_EMBEDDING_TOKENS) -> str:
    """Truncate text to stay under the embedding model's 8192 token limit."""
    if len(text) > MAX_EMBEDDING_CHARS:
        text = text[:MAX_EMBEDDING_CHARS]
    tokens = _tiktoken_encode(text)
    if len(tokens) <= max_tokens:
        return text
    return _tiktoken_enc.decode(tokens[:max_tokens])


def embed_texts(client: OpenAI, texts: list[str]) -> list[list[float]]:
    """Embed a batch of texts via OpenAI, with fallback to one-at-a-time on error."""
    safe_texts = [_truncate_for_embedding(t) for t in texts]
    try:
        response = client.embeddings.create(
            model=EMBEDDING_MODEL,
            input=safe_texts,
            dimensions=EMBEDDING_DIMENSIONS,
        )
        return [item.embedding for item in response.data]
    except Exception:
        results = []
        for i, text in enumerate(safe_texts):
            try:
                resp = client.embeddings.create(
                    model=EMBEDDING_MODEL,
                    input=[text],
                    dimensions=EMBEDDING_DIMENSIONS,
                )
                results.append(resp.data[0].embedding)
            except Exception:
                tok_count = len(_tiktoken_encode(text))
                print(f"    WARNING: Skipping chunk {i} ({tok_count} tokens, {len(text)} chars) — re-truncating")
                truncated = _truncate_for_embedding(text, max_tokens=6000)
                resp = client.embeddings.create(
                    model=EMBEDDING_MODEL,
                    input=[truncated],
                    dimensions=EMBEDDING_DIMENSIONS,
                )
                results.append(resp.data[0].embedding)
        return results


def ingest_documents(docs: list[dict]) -> None:
    """Chunk, embed, and upsert a list of documents into ChromaDB."""
    all_chunks: list[str] = []
    all_ids: list[str] = []
    all_metadata: list[dict] = []
    seen_ids: set[str] = set()

    for doc in docs:
        chunks = chunk_text(doc["text"])
        for i, chunk in enumerate(chunks):
            chunk_id = make_chunk_id(doc["path"], i)
            if chunk_id in seen_ids:
                continue
            seen_ids.add(chunk_id)
            all_chunks.append(chunk)
            all_ids.append(chunk_id)
            meta = {
                "source": doc["path"],
                "category": doc["category"],
                "chunk_index": i,
            }
            if doc.get("ticker"):
                meta["ticker"] = doc["ticker"]
            all_metadata.append(meta)

    print(f"Created {len(all_chunks)} chunk(s). Embedding ...")

    openai_client = OpenAI(api_key=OPENAI_API_KEY)

    batch_size = 20
    all_embeddings: list[list[float]] = []
    for i in range(0, len(all_chunks), batch_size):
        batch = all_chunks[i : i + batch_size]
        all_embeddings.extend(embed_texts(openai_client, batch))
        print(f"  Embedded {min(i + batch_size, len(all_chunks))}/{len(all_chunks)}")

    print("Upserting into ChromaDB ...")

    chroma_client = chromadb.PersistentClient(path=CHROMA_PERSIST_DIR)
    collection = chroma_client.get_or_create_collection(
        name=CHROMA_COLLECTION,
        metadata={"hnsw:space": "cosine"},
    )

    for i in range(0, len(all_chunks), batch_size):
        end = min(i + batch_size, len(all_chunks))
        collection.upsert(
            ids=all_ids[i:end],
            embeddings=all_embeddings[i:end],
            documents=all_chunks[i:end],
            metadatas=all_metadata[i:end],
        )

    print(f"Done. Collection '{CHROMA_COLLECTION}' now has {collection.count()} chunk(s).")


def ingest_path(base_path: Path) -> None:
    """Load documents from the filesystem and ingest them."""
    print(f"Loading documents from {base_path} ...")
    docs = load_documents(base_path)
    if not docs:
        print("No documents found. Add .md or .txt files to knowledge_base/ and try again.")
        sys.exit(1)

    print(f"Found {len(docs)} document(s). Chunking ...")
    ingest_documents(docs)


def ingest_url(url: str) -> None:
    """Fetch a URL, save it, and ingest it."""
    doc = fetch_url(url)
    if not doc:
        print("No content to ingest.")
        sys.exit(1)
    print("Chunking ...")
    ingest_documents([doc])


def ingest_crawl(base_url: str, max_pages: int = 0) -> None:
    """Crawl a URL prefix and ingest all discovered pages."""
    docs = crawl_urls(base_url, max_pages=max_pages)
    if not docs:
        print("No pages found to ingest.")
        sys.exit(1)
    print(f"\nIngesting {len(docs)} page(s) ...")
    ingest_documents(docs)


def ingest_sitemap(sitemap_url: str, url_prefix: str, max_pages: int = 0) -> None:
    """Discover URLs from a sitemap and ingest them."""
    docs = crawl_sitemap(sitemap_url, url_prefix, max_pages=max_pages)
    if not docs:
        print("No pages found to ingest.")
        sys.exit(1)
    print(f"\nIngesting {len(docs)} page(s) ...")
    ingest_documents(docs)


def main():
    parser = argparse.ArgumentParser(description="Ingest documents into a RAG agent's knowledge base.")
    parser.add_argument("--agent", type=str, default=None, help="Agent name (default: from RAG_AGENT env or 'librarian')")
    parser.add_argument("--path", type=str, default=None, help="Path to ingest (default: entire knowledge_base/)")
    parser.add_argument("--url", type=str, default=None, help="URL of a single web page to fetch and ingest")
    parser.add_argument("--crawl", type=str, default=None, help="Base URL to crawl — fetches all child pages under this prefix")
    parser.add_argument("--sitemap", type=str, default=None,
                        help="Sitemap XML URL to discover pages from (use with --crawl to set the URL prefix filter)")
    parser.add_argument("--max-pages", type=int, default=0, help="Maximum pages to crawl (default: 0 = no limit)")
    args = parser.parse_args()

    if args.sitemap:
        url_prefix = args.crawl or args.sitemap.rsplit("/sitemap", 1)[0] + "/"
        ingest_sitemap(args.sitemap, url_prefix, max_pages=args.max_pages)
    elif args.crawl:
        ingest_crawl(args.crawl, max_pages=args.max_pages)
    elif args.url:
        ingest_url(args.url)
    else:
        base_path = Path(args.path) if args.path else KNOWLEDGE_BASE_DIR
        if not base_path.exists():
            print(f"Error: {base_path} does not exist.")
            sys.exit(1)
        ingest_path(base_path)


if __name__ == "__main__":
    main()
