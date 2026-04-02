"""Incremental sync for Datadog documentation.

Fetches the docs.datadoghq.com sitemap, compares lastmod dates against a local
manifest, and only re-fetches pages that are new or updated since the last run.
Changed pages are ingested into ChromaDB via the existing ingest pipeline.

Usage:
    python sync_docs.py --agent librarian                        # incremental sync
    python sync_docs.py --agent librarian --dry-run              # preview changes only
    python sync_docs.py --agent librarian --force                # re-fetch everything
    python sync_docs.py --agent librarian --max-pages 50         # cap pages per run

Automation (macOS launchd):
    cp com.aplan.sync-librarian-docs.plist ~/Library/LaunchAgents/
    launchctl load ~/Library/LaunchAgents/com.aplan.sync-librarian-docs.plist
"""

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from config import AGENT_NAME, KNOWLEDGE_BASE_DIR
from ingest import (
    _discover_sitemap_entries,
    _resolve_prefix,
    fetch_url,
    ingest_documents,
)

DEFAULT_SITEMAP = "https://docs.datadoghq.com/en/sitemap.xml"
DEFAULT_PREFIX = "https://docs.datadoghq.com/"

DATA_DIR = KNOWLEDGE_BASE_DIR.parent
MANIFEST_PATH = DATA_DIR / "sync_manifest.json"
SYNC_LOG_PATH = DATA_DIR / "sync_log.json"


def load_manifest() -> dict[str, dict]:
    if MANIFEST_PATH.exists():
        return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    return {}


def save_manifest(manifest: dict[str, dict]) -> None:
    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(
        json.dumps(manifest, indent=2, sort_keys=True),
        encoding="utf-8",
    )


def append_sync_log(entry: dict) -> None:
    log: list[dict] = []
    if SYNC_LOG_PATH.exists():
        try:
            log = json.loads(SYNC_LOG_PATH.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, ValueError):
            log = []
    log.append(entry)
    SYNC_LOG_PATH.write_text(
        json.dumps(log, indent=2),
        encoding="utf-8",
    )


def sync(
    sitemap_url: str,
    url_prefix: str,
    dry_run: bool = False,
    force: bool = False,
    max_pages: int = 0,
    delay: float = 0.5,
) -> dict:
    """Run an incremental sync and return a summary dict."""
    now = datetime.now(timezone.utc).isoformat()
    manifest = load_manifest()

    prefix = _resolve_prefix(url_prefix)
    print(f"Fetching sitemap: {sitemap_url}")
    print(f"URL prefix filter: {prefix}\n")

    sitemap_entries = _discover_sitemap_entries(sitemap_url, prefix)
    print(f"Sitemap contains {len(sitemap_entries)} URLs under prefix.\n")

    if not sitemap_entries:
        print("No URLs found in sitemap. Aborting.")
        return {"timestamp": now, "error": "empty_sitemap"}

    to_fetch: list[str] = []
    new_urls: list[str] = []
    updated_urls: list[str] = []

    for url, lastmod in sitemap_entries.items():
        prev = manifest.get(url)
        if prev is None:
            new_urls.append(url)
            to_fetch.append(url)
        elif force or (lastmod and prev.get("lastmod") != lastmod):
            updated_urls.append(url)
            to_fetch.append(url)

    sitemap_url_set = set(sitemap_entries.keys())
    manifest_url_set = set(manifest.keys())
    stale_urls = sorted(manifest_url_set - sitemap_url_set)

    print(f"New pages:     {len(new_urls)}")
    print(f"Updated pages: {len(updated_urls)}")
    print(f"Stale pages:   {len(stale_urls)} (in manifest but gone from sitemap)")
    print(f"Unchanged:     {len(sitemap_entries) - len(to_fetch)}")
    print(f"Total to fetch: {len(to_fetch)}\n")

    if max_pages and len(to_fetch) > max_pages:
        print(f"Capping at --max-pages {max_pages}.\n")
        to_fetch = to_fetch[:max_pages]

    if dry_run:
        print("--dry-run: no pages will be fetched or ingested.\n")
        if new_urls:
            print(f"Would add ({len(new_urls)}):")
            for u in new_urls[:20]:
                print(f"  + {u}")
            if len(new_urls) > 20:
                print(f"  ... and {len(new_urls) - 20} more")
        if updated_urls:
            print(f"\nWould update ({len(updated_urls)}):")
            for u in updated_urls[:20]:
                print(f"  ~ {u}")
            if len(updated_urls) > 20:
                print(f"  ... and {len(updated_urls) - 20} more")
        if stale_urls:
            print(f"\nStale (no longer in sitemap, {len(stale_urls)}):")
            for u in stale_urls[:20]:
                print(f"  ? {u}")
            if len(stale_urls) > 20:
                print(f"  ... and {len(stale_urls) - 20} more")
        return {
            "timestamp": now,
            "dry_run": True,
            "new": len(new_urls),
            "updated": len(updated_urls),
            "stale": len(stale_urls),
        }

    docs: list[dict] = []
    errors: list[str] = []
    for i, url in enumerate(to_fetch, 1):
        try:
            doc = fetch_url(url)
            if doc:
                docs.append(doc)
            else:
                errors.append(url)
        except Exception as e:
            print(f"  ERROR fetching {url}: {e}")
            errors.append(url)
        print(f"  [{i}/{len(to_fetch)} fetched, {len(docs)} saved]\n")
        if i < len(to_fetch):
            time.sleep(delay)

    if docs:
        print(f"Ingesting {len(docs)} page(s) into ChromaDB ...")
        ingest_documents(docs)
    else:
        print("No new content to ingest.")

    for url in to_fetch:
        if url not in errors:
            manifest[url] = {
                "lastmod": sitemap_entries.get(url),
                "last_synced": now,
            }
    save_manifest(manifest)

    summary = {
        "timestamp": now,
        "agent": AGENT_NAME,
        "sitemap": sitemap_url,
        "new": len(new_urls),
        "updated": len(updated_urls),
        "fetched": len(docs),
        "errors": len(errors),
        "stale": len(stale_urls),
    }
    append_sync_log(summary)

    print(f"\nSync complete: {len(docs)} page(s) ingested, {len(errors)} error(s).")
    if stale_urls:
        print(f"  {len(stale_urls)} stale URL(s) flagged (not auto-deleted).")
    print(f"Manifest saved to {MANIFEST_PATH}")
    print(f"Log appended to  {SYNC_LOG_PATH}")

    return summary


def main():
    parser = argparse.ArgumentParser(
        description="Incremental sync of Datadog docs into the Librarian RAG agent.",
    )
    parser.add_argument("--agent", type=str, default=None, help="Agent name (default: from RAG_AGENT env or 'librarian')")
    parser.add_argument("--sitemap", type=str, default=DEFAULT_SITEMAP, help=f"Sitemap XML URL (default: {DEFAULT_SITEMAP})")
    parser.add_argument("--prefix", type=str, default=DEFAULT_PREFIX, help=f"URL prefix filter (default: {DEFAULT_PREFIX})")
    parser.add_argument("--dry-run", action="store_true", help="Preview what would change without fetching or ingesting")
    parser.add_argument("--force", action="store_true", help="Re-fetch all pages regardless of lastmod")
    parser.add_argument("--max-pages", type=int, default=0, help="Max pages to fetch per run (0 = no limit)")
    parser.add_argument("--delay", type=float, default=0.5, help="Seconds between HTTP requests (default: 0.5)")
    args = parser.parse_args()

    sync(
        sitemap_url=args.sitemap,
        url_prefix=args.prefix,
        dry_run=args.dry_run,
        force=args.force,
        max_pages=args.max_pages,
        delay=args.delay,
    )


if __name__ == "__main__":
    main()
