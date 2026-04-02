"""Video case study transcription pipeline.

Discovers Vimeo video URLs from crawled markdown files, the /customers/ HTML,
and JS-rendered video modals (via Playwright). Downloads each video, extracts
audio with ffmpeg, transcribes via OpenAI Whisper, saves transcripts as
markdown, and ingests them into ChromaDB.

Usage:
    python transcribe.py --agent case_studies
    python transcribe.py --agent case_studies --discover-only
    python transcribe.py --agent case_studies --video-url "https://player.vimeo.com/..."
"""

import argparse
import json
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import unquote

import httpx
from openai import OpenAI

from config import KNOWLEDGE_BASE_DIR, OPENAI_API_KEY, agent
from ingest import ingest_documents

VIMEO_RE = re.compile(
    r"https?://player\.vimeo\.com/progressive_redirect/playback/(\d+)/[^\s\"\')>]+"
)

VIMEO_ANY_RE = re.compile(
    r"https?://player\.vimeo\.com/(?:progressive_redirect/playback|external)/(\d+)[^\s\"\')>]*"
)

CUSTOMERS_URL = "https://www.datadoghq.com/customers/"

TYPESENSE_HOST = "dnm1k9zrpctsvjowp-1.a1.typesense.net"
TYPESENSE_API_KEY = "O2QyrgpWb3eKxVCmGVNrORNcSo3pOZJu"
TYPESENSE_COLLECTION = "corpsite_alias"

TRANSCRIPT_DIR = KNOWLEDGE_BASE_DIR / "transcripts"

MANIFEST_PATH = KNOWLEDGE_BASE_DIR.parent / "transcripts_manifest.json"


# ---------------------------------------------------------------------------
# Manifest – tracks which Vimeo IDs have already been processed
# ---------------------------------------------------------------------------

def _load_manifest() -> dict:
    if MANIFEST_PATH.exists():
        return json.loads(MANIFEST_PATH.read_text())
    return {}


def _save_manifest(manifest: dict) -> None:
    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2))


# ---------------------------------------------------------------------------
# Video discovery
# ---------------------------------------------------------------------------

def _clean_vimeo_url(url: str) -> str:
    """Normalise a Vimeo direct-download URL (fix HTML entities, %20 etc.)."""
    url = url.replace("&amp;", "&")
    url = unquote(url)
    if url.endswith(")"):
        url = url[:-1]
    return url


def discover_from_markdown() -> dict[str, str]:
    """Scan crawled .md files for embedded Vimeo MP4 links.

    Returns {vimeo_id: clean_url}.
    """
    videos: dict[str, str] = {}
    if not KNOWLEDGE_BASE_DIR.exists():
        return videos
    for md_file in KNOWLEDGE_BASE_DIR.rglob("*.md"):
        text = md_file.read_text(encoding="utf-8", errors="replace")
        for m in VIMEO_RE.finditer(text):
            vid_id = m.group(1)
            if vid_id not in videos:
                videos[vid_id] = _clean_vimeo_url(m.group(0))
    return videos


def discover_from_customers_html() -> dict[str, tuple[str, str]]:
    """Fetch /customers/ static HTML and extract data-video-id / data-video-src pairs.

    Returns {vimeo_id: (company_slug, clean_url)}.
    """
    videos: dict[str, tuple[str, str]] = {}
    try:
        resp = httpx.get(CUSTOMERS_URL, follow_redirects=True, timeout=30)
        resp.raise_for_status()
    except httpx.HTTPError as e:
        print(f"  Warning: could not fetch {CUSTOMERS_URL}: {e}")
        return videos

    html = resp.text
    pairs = re.findall(
        r'data-video-id=([^\s>"]+)\s+data-video-src=([^\s>"]+)', html
    )
    for slug, vimeo_id in pairs:
        if vimeo_id in videos:
            continue
        url_match = re.search(
            rf"player\.vimeo\.com/progressive_redirect/playback/{vimeo_id}/[^\s\"'>]+",
            html,
        )
        if url_match:
            url = _clean_vimeo_url("https://" + url_match.group(0))
            videos[vimeo_id] = (slug, url)
    return videos


def discover_from_playwright() -> dict[str, tuple[str, str]]:
    """Use Playwright to render /customers/ and find JS-loaded video URLs.

    Returns {vimeo_id: (company_slug, clean_url)}.
    """
    videos: dict[str, tuple[str, str]] = {}
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("  Warning: playwright not installed, skipping JS video discovery.")
        return videos

    print("  Launching headless browser ...")
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        page = browser.new_page()
        try:
            page.goto(CUSTOMERS_URL, wait_until="networkidle", timeout=30000)
        except Exception as e:
            print(f"  Warning: page load issue ({e}), continuing with partial content.")

        page.evaluate("window.scrollBy(0, document.body.scrollHeight)")
        time.sleep(2)

        video_buttons = page.query_selector_all(
            "button[data-video-id], a[data-video-id], [data-video-id]"
        )
        print(f"  Found {len(video_buttons)} video trigger elements in DOM.")

        for btn in video_buttons:
            slug = btn.get_attribute("data-video-id") or ""
            vimeo_id = btn.get_attribute("data-video-src") or ""
            embed = btn.get_attribute("data-video-embed") or ""
            if vimeo_id and vimeo_id not in videos:
                url = _clean_vimeo_url(embed) if embed else ""
                if not url:
                    id_match = re.search(r"(\d{6,})", vimeo_id)
                    if id_match:
                        vimeo_id = id_match.group(1)
                if url:
                    videos[vimeo_id] = (slug, url)
                elif vimeo_id.isdigit():
                    videos[vimeo_id] = (slug, "")

        # Try clicking video modal triggers to capture dynamically loaded URLs
        story_buttons = page.query_selector_all(
            ".js-video-modal, [data-toggle='video-modal'], "
            ".customer-story-card button, .customer-story-card a"
        )
        for btn in story_buttons:
            try:
                btn.click(timeout=2000)
                time.sleep(1)
                modal_html = page.content()
                for m in VIMEO_RE.finditer(modal_html):
                    vid_id = m.group(1)
                    if vid_id not in videos:
                        slug_attr = btn.get_attribute("data-video-id") or f"modal-{vid_id}"
                        videos[vid_id] = (slug_attr, _clean_vimeo_url(m.group(0)))
                page.keyboard.press("Escape")
                time.sleep(0.5)
            except Exception:
                continue

        browser.close()

    return videos


def discover_from_typesense() -> dict[str, tuple[str, str, str]]:
    """Query the Datadog Typesense index for all video-testimonial entries.

    Returns {vimeo_id: (company_slug, clean_url, summary)}.
    """
    videos: dict[str, tuple[str, str, str]] = {}
    base = f"https://{TYPESENSE_HOST}"
    headers = {"X-TYPESENSE-API-KEY": TYPESENSE_API_KEY}
    params = {
        "q": "*",
        "query_by": "title",
        "filter_by": "type:=video-testimonials",
        "per_page": 250,
    }

    try:
        resp = httpx.get(
            f"{base}/collections/{TYPESENSE_COLLECTION}/documents/search",
            params=params,
            headers=headers,
            timeout=15,
        )
        resp.raise_for_status()
    except httpx.HTTPError as e:
        print(f"  Warning: Typesense query failed: {e}")
        return videos

    data = resp.json()
    for hit in data.get("hits", []):
        doc = hit["document"]
        slug = doc.get("video_id", "")
        title = doc.get("title", slug)
        embed = _clean_vimeo_url(doc.get("video_embed", ""))
        summary = doc.get("summary", "")

        vimeo_match = VIMEO_ANY_RE.search(embed) if embed else None
        if not vimeo_match:
            vimeo_match = re.search(r"/(\d{6,})", embed) if embed else None
        vid_id = vimeo_match.group(1) if vimeo_match else ""

        if vid_id and vid_id not in videos:
            videos[vid_id] = (slug or title, embed, summary)

    return videos


def discover_all() -> list[dict]:
    """Merge all discovery sources into a deduplicated list.

    Returns list of {"vimeo_id", "company", "url", "summary"}.
    """
    results: dict[str, dict] = {}

    print("Discovering videos from Typesense API (primary source) ...")
    for vid_id, (slug, url, summary) in discover_from_typesense().items():
        results[vid_id] = {
            "vimeo_id": vid_id, "company": slug or vid_id,
            "url": url, "summary": summary,
        }

    print("Discovering videos from crawled markdown ...")
    for vid_id, url in discover_from_markdown().items():
        if vid_id in results:
            if url and not results[vid_id]["url"]:
                results[vid_id]["url"] = url
        else:
            results[vid_id] = {
                "vimeo_id": vid_id, "company": vid_id,
                "url": url, "summary": "",
            }

    print("Discovering videos from /customers/ static HTML ...")
    for vid_id, (slug, url) in discover_from_customers_html().items():
        if vid_id in results:
            if slug and results[vid_id]["company"] == vid_id:
                results[vid_id]["company"] = slug
            if url and not results[vid_id]["url"]:
                results[vid_id]["url"] = url
        else:
            results[vid_id] = {
                "vimeo_id": vid_id, "company": slug or vid_id,
                "url": url, "summary": "",
            }

    print("Discovering videos via Playwright (JS-rendered content) ...")
    for vid_id, (slug, url) in discover_from_playwright().items():
        if vid_id in results:
            if slug and results[vid_id]["company"] == vid_id:
                results[vid_id]["company"] = slug
            if url and not results[vid_id]["url"]:
                results[vid_id]["url"] = url
        else:
            results[vid_id] = {
                "vimeo_id": vid_id, "company": slug or vid_id,
                "url": url, "summary": "",
            }

    return list(results.values())


# ---------------------------------------------------------------------------
# Download + audio extraction + transcription
# ---------------------------------------------------------------------------

def download_video(url: str, dest: Path) -> bool:
    """Download a Vimeo MP4 to a local file."""
    print(f"  Downloading {url[:80]}...")
    try:
        with httpx.stream("GET", url, follow_redirects=True, timeout=120) as resp:
            resp.raise_for_status()
            with open(dest, "wb") as f:
                for chunk in resp.iter_bytes(chunk_size=1024 * 64):
                    f.write(chunk)
        size_mb = dest.stat().st_size / (1024 * 1024)
        print(f"  Downloaded {size_mb:.1f} MB")
        return True
    except Exception as e:
        print(f"  Download failed: {e}")
        return False


def extract_audio(video_path: Path, audio_path: Path) -> bool:
    """Extract audio from video using ffmpeg."""
    result = subprocess.run(
        [
            "ffmpeg", "-y", "-i", str(video_path),
            "-vn", "-acodec", "libmp3lame", "-q:a", "4",
            str(audio_path),
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print(f"  ffmpeg failed: {result.stderr[:200]}")
        return False
    size_mb = audio_path.stat().st_size / (1024 * 1024)
    print(f"  Extracted audio: {size_mb:.1f} MB")
    return True


def transcribe_audio(audio_path: Path, client: OpenAI) -> str | None:
    """Transcribe audio file via OpenAI Whisper API."""
    size_mb = audio_path.stat().st_size / (1024 * 1024)
    if size_mb > 25:
        print(f"  Audio file too large ({size_mb:.1f} MB > 25 MB limit). Skipping.")
        return None

    print("  Transcribing with Whisper ...")
    with open(audio_path, "rb") as f:
        transcript = client.audio.transcriptions.create(
            model="whisper-1",
            file=f,
        )
    return transcript.text


def _slugify(text: str) -> str:
    text = text.lower().strip()
    text = re.sub(r"[^\w\s-]", "", text)
    text = re.sub(r"[\s_]+", "-", text)
    text = re.sub(r"-+", "-", text).strip("-")
    return text[:80] or "video"


def save_transcript(
    company: str, vimeo_id: str, url: str, text: str, summary: str = "",
) -> Path:
    """Save a transcript as a markdown file in the knowledge_base/transcripts/ dir."""
    TRANSCRIPT_DIR.mkdir(parents=True, exist_ok=True)
    slug = _slugify(company)
    filename = f"{slug}-{vimeo_id}.md"
    path = TRANSCRIPT_DIR / filename

    display_name = company.replace("_", " ").replace("-", " ").title()
    summary_block = f"Summary: {summary}\n" if summary else ""
    content = (
        f"# {display_name} - Video Case Study Transcript\n\n"
        f"Source: {url}\n"
        f"Type: auto-transcribed video\n"
        f"Customer: {display_name}\n"
        f"{summary_block}\n"
        f"---\n\n"
        f"{text}\n"
    )
    path.write_text(content, encoding="utf-8")
    print(f"  Saved transcript: {path}")
    return path


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------

def process_video(video: dict, openai_client: OpenAI, manifest: dict) -> dict | None:
    """Download, extract audio, transcribe, and save one video.

    Returns a document dict for ingestion, or None on failure.
    """
    vid_id = video["vimeo_id"]
    company = video["company"]
    url = video["url"]
    summary = video.get("summary", "")

    if vid_id in manifest:
        print(f"  Skipping {company} ({vid_id}) — already transcribed.")
        return None

    if not url:
        print(f"  Skipping {company} ({vid_id}) — no download URL available.")
        return None

    with tempfile.TemporaryDirectory() as tmpdir:
        mp4_path = Path(tmpdir) / f"{vid_id}.mp4"
        mp3_path = Path(tmpdir) / f"{vid_id}.mp3"

        if not download_video(url, mp4_path):
            return None

        if not extract_audio(mp4_path, mp3_path):
            return None

        text = transcribe_audio(mp3_path, openai_client)
        if not text:
            return None

    path = save_transcript(company, vid_id, url, text, summary)

    manifest[vid_id] = {
        "company": company,
        "url": url,
        "transcript_path": str(path),
    }
    _save_manifest(manifest)

    return {
        "path": str(path),
        "text": path.read_text(encoding="utf-8"),
        "category": "transcripts",
    }


def main():
    parser = argparse.ArgumentParser(
        description="Discover, download, transcribe, and ingest video case studies."
    )
    parser.add_argument(
        "--agent", type=str, default=None,
        help="Agent name (default: from RAG_AGENT env or 'librarian')",
    )
    parser.add_argument(
        "--discover-only", action="store_true",
        help="Only discover and print video URLs without downloading or transcribing.",
    )
    parser.add_argument(
        "--video-url", type=str, default=None,
        help="Transcribe a single video URL directly.",
    )
    args = parser.parse_args()

    print(f"Agent: {agent['name']}  |  Knowledge base: {KNOWLEDGE_BASE_DIR}\n")

    if args.video_url:
        m = VIMEO_RE.search(args.video_url)
        vid_id = m.group(1) if m else "unknown"
        videos = [{"vimeo_id": vid_id, "company": vid_id, "url": args.video_url}]
    else:
        videos = discover_all()

    print(f"\nDiscovered {len(videos)} unique video(s):\n")
    for v in videos:
        status = "has URL" if v["url"] else "NO URL"
        print(f"  [{v['vimeo_id']}] {v['company']} — {status}")

    if args.discover_only:
        print("\n--discover-only set. Exiting.")
        return

    if not videos:
        print("\nNo videos to process.")
        return

    manifest = _load_manifest()
    openai_client = OpenAI(api_key=OPENAI_API_KEY)
    docs: list[dict] = []

    for i, video in enumerate(videos, 1):
        print(f"\n--- [{i}/{len(videos)}] {video['company']} ({video['vimeo_id']}) ---")
        doc = process_video(video, openai_client, manifest)
        if doc:
            docs.append(doc)

    if docs:
        print(f"\nIngesting {len(docs)} transcript(s) into ChromaDB ...")
        ingest_documents(docs)
    else:
        print("\nNo new transcripts to ingest.")


if __name__ == "__main__":
    main()
